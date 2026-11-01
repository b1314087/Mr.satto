import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, type PDFDocument, type PDFObject } from "pdf-lib";
import { fitWithinEdge, type PdfCompressSettings } from "@/lib/pdf/compress-settings";

/**
 * PDFに埋め込まれたJPEG画像を、指定した品質・長辺の上限で作り直す（PDF圧縮の数値設定）。ブラウザ内だけで行う。
 *
 * 対象にするのは、そのままJPEGファイルとしてブラウザで読めて、色の扱いが変わらない画像だけ：
 *   - JPEG（DCTDecode）だけで圧縮された、1色あたり8ビットの画像
 *   - 色空間が DeviceRGB・DeviceGray、または同じ色数の ICCBased
 * 次の画像は変えずに残す（数える）：JPEG以外（Flateなど）、CMYK・Lab・Indexed、Decode配列やカラーキーのマスクを持つもの、
 * 読み込めないもの。透明度（SMask）は別の画像として残るため、本体を縮小しても透明部分の扱いは変わらない。
 *
 * 文字・図形・フォント・リンク・注釈・しおり・フォームは画像ではないため、変えない（文字の検索・選択もそのまま）。
 * 作り直したJPEGが元より大きくなる場合は、元の画像をそのまま使う（品質を上げてもサイズは増えない）。
 * JPEGの向き情報（EXIF）は使わない（PDFでも使われないため。表示の向きは変わらない）。
 */

export interface RecompressStats {
  /** PDF内の画像の数 */
  imageCount: number;
  /** 作り直して置き換えた画像の数 */
  recompressed: number;
  /** 長辺の上限を超えていたため縮小した画像の数（置き換えたものの内数） */
  resized: number;
  /** 対象外の形式などで、変えずに残した画像の数 */
  skipped: number;
  /** 作り直しても小さくならなかったため、元のまま残した画像の数 */
  keptOriginal: number;
}

const N = (name: string) => PDFName.of(name);

function isName(obj: PDFObject | undefined, name: string): boolean {
  return obj instanceof PDFName && obj === N(name);
}

/** フィルターが DCTDecode だけか（名前1つ、または要素1つの配列） */
function isDctOnly(filter: PDFObject | undefined): boolean {
  if (isName(filter, "DCTDecode")) return true;
  return filter instanceof PDFArray && filter.size() === 1 && isName(filter.get(0), "DCTDecode");
}

/** 色空間が、ブラウザで読んで作り直しても色の扱いが変わらないものか。成分の数（1か3）を返す */
function supportedComponents(doc: PDFDocument, colorSpace: PDFObject | undefined): 1 | 3 | null {
  const cs = colorSpace instanceof PDFRef ? doc.context.lookup(colorSpace) : colorSpace;
  if (isName(cs, "DeviceRGB")) return 3;
  if (isName(cs, "DeviceGray")) return 1;
  if (cs instanceof PDFArray && cs.size() === 2 && isName(cs.get(0), "ICCBased")) {
    const profileRef = cs.get(1);
    const profile = profileRef instanceof PDFRef ? doc.context.lookup(profileRef) : profileRef;
    const n = profile instanceof PDFRawStream ? profile.dict.get(N("N")) : undefined;
    if (n instanceof PDFNumber && (n.asNumber() === 3 || n.asNumber() === 1)) return n.asNumber() as 1 | 3;
  }
  return null;
}

function numberOf(dict: PDFDict, key: string): number | null {
  const v = dict.get(N(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** JPEGのバイト列を、指定した大きさ・品質のJPEGに作り直す。読めない場合は null */
async function reencodeJpeg(
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
  settings: PdfCompressSettings
): Promise<{ bytes: Uint8Array; width: number; height: number; resized: boolean } | null> {
  let bitmap: ImageBitmap;
  try {
    // PDFはJPEGの向き情報（EXIF）を使わないため、ここでも使わない（向きを変えない）
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), { imageOrientation: "none" });
  } catch {
    return null;
  }
  try {
    if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) return null;
    const target = fitWithinEdge(bitmap.width, bitmap.height, settings.maxImageEdge);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // JPEGは透明を持たないため、背景は白で塗ってから描く（元のJPEGにも透明はない）
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, target.width, target.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", settings.imageQuality / 100));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: target.width, height: target.height, resized: target.resized };
  } finally {
    bitmap.close();
  }
}

/** 置き換える画像の辞書（大きさ・色空間・フィルターだけを変え、ほかの項目＝透明度のSMaskなどは残す） */
function replacementDict(doc: PDFDocument, original: PDFDict, width: number, height: number): PDFDict {
  const dict = doc.context.obj({});
  const replaced = new Set(["Width", "Height", "ColorSpace", "BitsPerComponent", "Filter", "DecodeParms", "Length"]);
  for (const [key, value] of original.entries()) {
    if (!replaced.has(key.decodeText())) dict.set(key, value);
  }
  dict.set(N("Width"), PDFNumber.of(width));
  dict.set(N("Height"), PDFNumber.of(height));
  // ブラウザが書き出すJPEGはRGB（3成分）。白黒の画像もRGBとして書き出すため、色空間はRGBにする
  dict.set(N("ColorSpace"), N("DeviceRGB"));
  dict.set(N("BitsPerComponent"), PDFNumber.of(8));
  dict.set(N("Filter"), N("DCTDecode"));
  return dict;
}

/** PDF内のJPEG画像を、設定に従って作り直す。PDFDocument をその場で書き換え、件数を返す */
export async function recompressPdfImages(doc: PDFDocument, settings: PdfCompressSettings): Promise<RecompressStats> {
  const stats: RecompressStats = { imageCount: 0, recompressed: 0, resized: 0, skipped: 0, keptOriginal: 0 };
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || !isName(obj.dict.get(N("Subtype")), "Image")) continue;
    stats.imageCount++;
    const dict = obj.dict;
    const width = numberOf(dict, "Width");
    const height = numberOf(dict, "Height");
    const eligible =
      isDctOnly(dict.get(N("Filter"))) &&
      numberOf(dict, "BitsPerComponent") === 8 &&
      supportedComponents(doc, dict.get(N("ColorSpace"))) !== null &&
      dict.get(N("Decode")) === undefined &&
      dict.get(N("Mask")) === undefined &&
      dict.get(N("ImageMask")) === undefined &&
      width !== null &&
      height !== null;
    if (!eligible) {
      stats.skipped++;
      continue;
    }
    const out = await reencodeJpeg(obj.contents, width!, height!, settings);
    if (!out) {
      stats.skipped++;
      continue;
    }
    if (out.bytes.length >= obj.contents.length) {
      stats.keptOriginal++;
      continue;
    }
    doc.context.assign(ref, PDFRawStream.of(replacementDict(doc, dict, out.width, out.height), out.bytes));
    stats.recompressed++;
    if (out.resized) stats.resized++;
  }
  return stats;
}

/** 電子署名を含むPDFか（圧縮して保存し直すと、署名は無効になる） */
export function hasDigitalSignature(doc: PDFDocument): boolean {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFRawStream ? obj.dict : null;
    if (!dict) continue;
    if (isName(dict.get(N("FT")), "Sig") || isName(dict.get(N("Type")), "Sig")) return true;
  }
  return false;
}
