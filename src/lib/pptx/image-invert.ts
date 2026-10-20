/**
 * PowerPointに挿入された画像の、白黒反転の判定と処理（Mr.Satto「PowerPoint白黒反転」）。
 *
 * 画像は次の3つに分け、「白黒と判定できるもの」だけを反転する。迷うものは反転しない。
 *   白黒の画像（色のついた画素がほとんどない）     → 全体を反転する（白黒の文書・スクリーンショット・白黒写真）
 *   白黒が中心で、カラーが少し混ざった画像         → 白黒の画素だけを反転し、色のついた画素は残す
 *                                                   （白地に黒文字と色つきの図、のような文書的な画像に限る）
 *   それ以外（カラー写真・カラーイラストなど）      → 変更しない
 * 透明（アルファ）は変えない。判定は画素の統計だけで、AI・外部サービスは使わない。
 */

export type ImageDecision = "invert-all" | "invert-gray" | "keep-color" | "keep-transparent";

export interface PixelAnalysis {
  decision: ImageDecision;
  /** 見えている（透明でない）画素の数（標本） */
  visible: number;
  /** 見えている画素のうち、色のついた画素の割合（0〜1） */
  coloredRatio: number;
  /** 白黒の画素のうち、ほぼ白かほぼ黒の画素の割合（0〜1） */
  extremeRatio: number;
}

/** RGBの差がこの値を超える画素を、色のついた画素とする（JPEGのノイズや色のにじみは白黒として扱うため、少し大きめ） */
export const IMAGE_COLOR_CHROMA = 28;
/** 透明度がこの値（0〜255）以上の画素を、見えている画素とする */
export const IMAGE_VISIBLE_ALPHA = 32;
/** 色のついた画素の割合がこれ以下なら、白黒の画像 */
export const MONOCHROME_COLORED_RATIO = 0.004;
/** 「白黒が中心で、カラーが少し混ざった画像」と判定する、色のついた画素の割合の上限 */
export const MIXED_DOCUMENT_COLORED_RATIO_MAX = 0.3;
/** 同じく、白黒の画素のうち、ほぼ白かほぼ黒の画素の割合の下限（文書・画面のように、白地や黒地が中心であること） */
export const MIXED_DOCUMENT_EXTREME_RATIO_MIN = 0.8;
const EXTREME_LIGHT = 230;
const EXTREME_DARK = 64;
/** 画素数が多い画像は、この数くらいの標本で判定する */
const ANALYSIS_SAMPLE_TARGET = 4_000_000;
/** これを超える画素数（約4000万画素）の画像は、メモリ不足を避けるため処理しない */
export const MAX_IMAGE_PIXELS = 40_000_000;

type PixelData = Uint8ClampedArray | Uint8Array;

export function analyzeImage(data: PixelData, width: number, height: number): PixelAnalysis {
  const total = width * height;
  const stride = Math.max(1, Math.floor(total / ANALYSIS_SAMPLE_TARGET));
  let visible = 0;
  let colored = 0;
  let gray = 0;
  let extreme = 0;
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    if (data[i + 3] < IMAGE_VISIBLE_ALPHA) continue;
    visible++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > IMAGE_COLOR_CHROMA) {
      colored++;
      continue;
    }
    gray++;
    const lum = (r + g + b) / 3;
    if (lum >= EXTREME_LIGHT || lum <= EXTREME_DARK) extreme++;
  }
  if (visible === 0) return { decision: "keep-transparent", visible: 0, coloredRatio: 0, extremeRatio: 0 };
  const coloredRatio = colored / visible;
  const extremeRatio = gray === 0 ? 0 : extreme / gray;
  let decision: ImageDecision = "keep-color";
  if (coloredRatio <= MONOCHROME_COLORED_RATIO) decision = "invert-all";
  else if (coloredRatio <= MIXED_DOCUMENT_COLORED_RATIO_MAX && extremeRatio >= MIXED_DOCUMENT_EXTREME_RATIO_MIN) decision = "invert-gray";
  return { decision, visible, coloredRatio, extremeRatio };
}

/** 判定にしたがって、画素を反転する（その場で書き換える。透明度は変えない） */
export function invertImagePixels(data: PixelData, decision: ImageDecision): void {
  if (decision !== "invert-all" && decision !== "invert-gray") return;
  const onlyGray = decision === "invert-gray";
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (onlyGray && Math.max(r, g, b) - Math.min(r, g, b) > IMAGE_COLOR_CHROMA) continue;
    data[i] = 255 - r;
    data[i + 1] = 255 - g;
    data[i + 2] = 255 - b;
  }
}

export type RasterKind = "png" | "jpeg";

/** ファイルの先頭のバイトから、PNG・JPEGを見分ける（拡張子は当てにしない）。それ以外は null */
export function sniffRasterKind(bytes: Uint8Array): RasterKind | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA（1画素4バイト） */
  data: Uint8ClampedArray;
}

/** 画像の読み込み・書き出し。ブラウザではCanvasを使う（テストでは、別の実装に差し替える） */
export interface ImageCodec {
  decode(bytes: Uint8Array, kind: RasterKind): Promise<RasterImage>;
  encode(image: RasterImage, kind: RasterKind): Promise<Uint8Array>;
}

const MIME: Record<RasterKind, string> = { png: "image/png", jpeg: "image/jpeg" };

/** ブラウザのCanvasで画像を読み書きする（ファイルは外部に送信しない）。EXIFの向き・色の変換は適用せず、画素そのままを扱う */
export function createBrowserImageCodec(): ImageCodec {
  return {
    async decode(bytes, kind) {
      const blob = new Blob([bytes as BlobPart], { type: MIME[kind] });
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" });
      } catch {
        bitmap = await createImageBitmap(blob);
      }
      try {
        const { width, height } = bitmap;
        if (width * height > MAX_IMAGE_PIXELS) throw new Error("too-large");
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(bitmap, 0, 0);
        return { width, height, data: ctx.getImageData(0, 0, width, height).data };
      } finally {
        bitmap.close();
      }
    },
    async encode(image, kind) {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, MIME[kind], kind === "jpeg" ? 0.92 : undefined));
      if (!blob) throw new Error("encode");
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}
