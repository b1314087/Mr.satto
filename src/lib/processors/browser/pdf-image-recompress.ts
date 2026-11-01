import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument, type PDFObject } from "pdf-lib";
import { fitWithinEdge, type PdfCompressSettings } from "@/lib/pdf/compress-settings";

/**
 * PDFに埋め込まれた画像を、指定した品質・長辺の上限のJPEGに作り直す（PDF圧縮の数値設定・目標のサイズ）。ブラウザ内だけで行う。
 *
 * 作り直す画像：
 *   1. JPEG（DCTDecode）だけで圧縮された、1色あたり8ビットの画像（工程18）
 *   2. JPEG以外のうち、Flate（ZIPと同じ方式。PNGに近い）で保存された、写真のような大きな画像（PDF圧縮の写真のJPEG化）。
 *      デザインソフトから書き出したPDFでは、写真がこの形式で入っていて、ファイルが大きくなりやすい。
 *      小さな画像（部品・アイコンなど）は、JPEGにしてもほとんど小さくならず、輪郭がにじみやすいため対象外にする。
 * どちらも、色空間が DeviceRGB・DeviceGray、または同じ色数の ICCBased のものだけ（色の扱いが変わらない）。
 *
 * 次の画像は変えずに残す（数える）：
 *   - 透明度（SMask）・マスク（Mask）として使われている画像（JPEGにすると透明の扱いが壊れるため）
 *   - CMYK・Lab・Indexed、Decode配列やカラーキーのマスクを持つもの、読み込めないもの、小さな画像
 * 透明度（SMask）を持つ画像は、本体だけをJPEGにし、透明度は別の画像のまま残す（見た目の透明は変わらない）。
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
  /** 置き換えた画像のうち、JPEG以外の形式（Flate）からJPEGにした数 */
  convertedToJpeg: number;
  /** 長辺の上限を超えていたため縮小した画像の数（置き換えたものの内数） */
  resized: number;
  /** 対象外の形式・小さな画像・透明度のマスクなどで、変えずに残した画像の数 */
  skipped: number;
  /** 作り直しても小さくならなかったため、元のまま残した画像の数 */
  keptOriginal: number;
}

/** JPEG以外の画像をJPEGにする対象の大きさ（写真らしい大きな画像だけ）。画素の数と、保存されているデータの大きさ */
export const FLATE_PHOTO_MIN_PIXELS = 200 * 200;
export const FLATE_PHOTO_MIN_BYTES = 30_000;

const N = (name: string) => PDFName.of(name);

function isName(obj: PDFObject | undefined, name: string): boolean {
  return obj instanceof PDFName && obj === N(name);
}

/** フィルターが指定の1つだけか（名前1つ、または要素1つの配列） */
function isOnlyFilter(filter: PDFObject | undefined, name: string): boolean {
  if (isName(filter, name)) return true;
  return filter instanceof PDFArray && filter.size() === 1 && isName(filter.get(0), name);
}

/** 色空間が、ブラウザで作り直しても色の扱いが変わらないものか。成分の数（1か3）を返す */
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

/** 透明度（SMask）・マスク（Mask）として使われている画像の参照を集める（これらはJPEGにしない） */
function collectMaskRefs(doc: PDFDocument): Set<PDFRef> {
  const refs = new Set<PDFRef>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || !isName(obj.dict.get(N("Subtype")), "Image")) continue;
    for (const key of ["SMask", "Mask"]) {
      const v = obj.dict.get(N(key));
      if (v instanceof PDFRef) refs.add(v);
    }
  }
  return refs;
}

/**
 * Flateの画像の「行ごとの前処理（PNGの予測。Predictor 10〜15）」の設定を確かめる。
 * 前処理なし（Predictor 1）か、PNGの予測で、色数・ビット数・幅が画像と一致するときだけ扱う。扱えないときは null。
 */
function pngPredictorOf(dict: PDFDict, doc: PDFDocument, width: number, components: number): { png: boolean } | null {
  let parms: PDFObject | undefined = dict.get(N("DecodeParms"));
  if (parms instanceof PDFRef) parms = doc.context.lookup(parms);
  if (parms instanceof PDFArray) parms = parms.size() === 1 ? parms.get(0) : undefined;
  if (parms instanceof PDFRef) parms = doc.context.lookup(parms);
  if (parms === undefined) return { png: false };
  if (!(parms instanceof PDFDict)) return null;
  const predictor = numberOf(parms, "Predictor") ?? 1;
  if (predictor === 1) return { png: false };
  if (predictor < 10 || predictor > 15) return null; // TIFFの予測（2）などは扱わない
  const colors = numberOf(parms, "Colors") ?? 1;
  const bpc = numberOf(parms, "BitsPerComponent") ?? 8;
  const columns = numberOf(parms, "Columns") ?? 1;
  if (colors !== components || bpc !== 8 || columns !== width) return null;
  return { png: true };
}

/** Flate（zlib）で縮めたデータを戻す。ブラウザの機能を使い、使えなければ pdf-lib の機能で戻す */
async function inflate(stream: PDFRawStream): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    try {
      const ds = new DecompressionStream("deflate");
      const out = new Blob([new Uint8Array(stream.contents)]).stream().pipeThrough(ds);
      return new Uint8Array(await new Response(out).arrayBuffer());
    } catch {
      // 壊れたデータ・ブラウザの違いなど。pdf-lib の機能で、もう一度試す
    }
  }
  const plain = PDFRawStream.of(PDFDict.withContext(stream.dict.context), stream.contents);
  plain.dict.set(N("Filter"), N("FlateDecode"));
  return decodePDFRawStream(plain).decode();
}

/**
 * PNGの予測（行ごとのフィルター：なし・左・上・平均・Paeth）を戻し、画素の並び（1行あたり width×components バイト）にする。
 * 1行の先頭1バイトがフィルターの種類。データの長さが合わない・知らない種類のときは null。
 */
export function unpredictPng(data: Uint8Array, width: number, height: number, components: number): Uint8Array | null {
  const rowBytes = width * components;
  if (data.length < height * (rowBytes + 1)) return null;
  const out = new Uint8Array(height * rowBytes);
  const bpp = components;
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const dst = y * rowBytes;
    const prev = dst - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x];
      const left = x >= bpp ? out[dst + x - bpp] : 0;
      const up = y > 0 ? out[prev + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          return null;
      }
      out[dst + x] = value & 0xff;
    }
  }
  return out;
}

/** 画素の並び（グレー1成分・RGB3成分）を、canvasに描ける ImageData にする */
function toImageData(pixels: Uint8Array, width: number, height: number, components: 1 | 3): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += components) {
    const o = i * 4;
    if (components === 3) {
      rgba[o] = pixels[j];
      rgba[o + 1] = pixels[j + 1];
      rgba[o + 2] = pixels[j + 2];
    } else {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[j];
    }
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, width, height);
}

/** 画像（canvasに描けるもの）を、指定した大きさ・品質のJPEGにする。作れなければ null */
async function encodeJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  settings: PdfCompressSettings
): Promise<{ bytes: Uint8Array; width: number; height: number; resized: boolean } | null> {
  const target = fitWithinEdge(width, height, settings.maxImageEdge);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // JPEGは透明を持たないため、背景は白で塗ってから描く（透明度は、別の画像（SMask）として残す）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, target.width, target.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", settings.imageQuality / 100));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: target.width, height: target.height, resized: target.resized };
}

/** JPEGのバイト列を、指定した大きさ・品質のJPEGに作り直す。読めない場合は null */
async function reencodeJpeg(bytes: Uint8Array, expectedWidth: number, expectedHeight: number, settings: PdfCompressSettings) {
  let bitmap: ImageBitmap;
  try {
    // PDFはJPEGの向き情報（EXIF）を使わないため、ここでも使わない（向きを変えない）
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), { imageOrientation: "none" });
  } catch {
    return null;
  }
  try {
    if (bitmap.width !== expectedWidth || bitmap.height !== expectedHeight) return null;
    return await encodeJpeg(bitmap, bitmap.width, bitmap.height, settings);
  } finally {
    bitmap.close();
  }
}

/** Flateで保存された写真のような画像を、指定した大きさ・品質のJPEGにする。扱えない・読めない場合は null */
async function convertFlateToJpeg(
  doc: PDFDocument,
  stream: PDFRawStream,
  width: number,
  height: number,
  components: 1 | 3,
  settings: PdfCompressSettings
) {
  const predictor = pngPredictorOf(stream.dict, doc, width, components);
  if (!predictor) return null;
  let data: Uint8Array;
  try {
    data = await inflate(stream);
  } catch {
    return null;
  }
  const pixels = predictor.png ? unpredictPng(data, width, height, components) : data.length >= width * height * components ? data : null;
  if (!pixels) return null;
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const ctx = source.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.putImageData(toImageData(pixels, width, height, components), 0, 0);
    return await encodeJpeg(source, width, height, settings);
  } finally {
    source.width = 0;
    source.height = 0;
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

/** PDF内の画像を、設定に従ってJPEGに作り直す。PDFDocument をその場で書き換え、件数を返す */
export async function recompressPdfImages(doc: PDFDocument, settings: PdfCompressSettings): Promise<RecompressStats> {
  const stats: RecompressStats = { imageCount: 0, recompressed: 0, convertedToJpeg: 0, resized: 0, skipped: 0, keptOriginal: 0 };
  const maskRefs = collectMaskRefs(doc);
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || !isName(obj.dict.get(N("Subtype")), "Image")) continue;
    stats.imageCount++;
    const dict = obj.dict;
    const width = numberOf(dict, "Width");
    const height = numberOf(dict, "Height");
    const components = supportedComponents(doc, dict.get(N("ColorSpace")));
    const common =
      !maskRefs.has(ref) &&
      numberOf(dict, "BitsPerComponent") === 8 &&
      components !== null &&
      dict.get(N("Decode")) === undefined &&
      dict.get(N("Mask")) === undefined &&
      dict.get(N("ImageMask")) === undefined &&
      width !== null &&
      height !== null;
    const filter = dict.get(N("Filter"));
    const isJpeg = common && isOnlyFilter(filter, "DCTDecode");
    const isFlatePhoto =
      common &&
      isOnlyFilter(filter, "FlateDecode") &&
      width! * height! >= FLATE_PHOTO_MIN_PIXELS &&
      obj.contents.length >= FLATE_PHOTO_MIN_BYTES;
    if (!isJpeg && !isFlatePhoto) {
      stats.skipped++;
      continue;
    }
    const out = isJpeg
      ? await reencodeJpeg(obj.contents, width!, height!, settings)
      : await convertFlateToJpeg(doc, obj, width!, height!, components!, settings);
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
    if (!isJpeg) stats.convertedToJpeg++;
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
