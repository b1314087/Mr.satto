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

import { isDefaultPalette, type Palette } from "./color";

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

/** 見やすさの調整（enhance）の対象にする、「文書のような画像」の目安。白黒の画素のうち、ほぼ白かほぼ黒の画素の割合の下限 */
export const ENHANCE_DOCUMENT_EXTREME_RATIO_MIN = 0.7;
/** 反転後の「文字の濃さ」（0=背景、255=文字）がこの値以下なら、背景のにじみ・ノイズとして背景色にそろえる */
export const ENHANCE_NOISE_FLOOR = 24;
/** 反転後の「文字の濃さ」がこの値以上なら、文字色いっぱいにする */
export const ENHANCE_FULL_INK = 190;
/** 中間の濃さを明るい側へ持ち上げる強さ（1より小さいほど、細い線が明るくなる） */
export const ENHANCE_GAMMA = 0.75;
/** 線を太らせる強さ（上下左右の隣の画素の濃さの、この割合までを自分に足す） */
export const ENHANCE_THICKEN = 0.6;

export interface EnhanceOptions {
  width: number;
  height: number;
}

/** 見やすさの調整をするかの判定（文書のように、白地や黒地が中心の画像だけ。白黒写真は調整しない） */
export function shouldEnhance(analysis: PixelAnalysis): boolean {
  return (analysis.decision === "invert-all" || analysis.decision === "invert-gray") && analysis.extremeRatio >= ENHANCE_DOCUMENT_EXTREME_RATIO_MIN;
}

/** 反転後の文字の濃さ（0〜255）を、背景のノイズを消し、細い線が薄くならないように整える */
function toneInk(ink: number): number {
  if (ink <= ENHANCE_NOISE_FLOOR) return 0;
  if (ink >= ENHANCE_FULL_INK) return 255;
  const t = (ink - ENHANCE_NOISE_FLOOR) / (ENHANCE_FULL_INK - ENHANCE_NOISE_FLOOR);
  return Math.round(255 * t ** ENHANCE_GAMMA);
}

/**
 * 判定にしたがって、画素を反転する（その場で書き換える。透明度は変えない）。
 * 配色（palette）を渡すと、反転した明るさ（白→背景色、黒→文字色、灰色はその間）を、その配色に写す。
 * 配色を渡さない、または既定（純黒×純白）のときは、単純な反転（255 から引く）。
 * enhance を渡すと、文書のような画像向けに、背景のにじみを消し・細い線の明るさを上げ・線を少し太らせて、文字を見やすくする。
 */
export function invertImagePixels(data: PixelData, decision: ImageDecision, palette?: Palette | null, enhance?: EnhanceOptions): void {
  if (decision !== "invert-all" && decision !== "invert-gray") return;
  const onlyGray = decision === "invert-gray";
  const custom = palette && !isDefaultPalette(palette) ? palette : null;
  // チャンネルごとの変換表（反転した値 0〜255 → 配色の背景〜文字の間の値）
  const lut = (b: number, t: number) => {
    const table = new Uint8Array(256);
    for (let v = 0; v < 256; v++) table[v] = Math.min(255, Math.max(0, Math.round(b + (t - b) * (v / 255))));
    return table;
  };
  const lr = custom ? lut(custom.background.r, custom.text.r) : null;
  const lg = custom ? lut(custom.background.g, custom.text.g) : null;
  const lb = custom ? lut(custom.background.b, custom.text.b) : null;

  if (enhance && enhance.width * enhance.height * 4 === data.length) {
    enhanceAndInvert(data, enhance.width, enhance.height, onlyGray, lr, lg, lb);
    return;
  }
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (onlyGray && Math.max(r, g, b) - Math.min(r, g, b) > IMAGE_COLOR_CHROMA) continue;
    data[i] = lr ? lr[255 - r] : 255 - r;
    data[i + 1] = lg ? lg[255 - g] : 255 - g;
    data[i + 2] = lb ? lb[255 - b] : 255 - b;
  }
}

function enhanceAndInvert(data: PixelData, width: number, height: number, onlyGray: boolean, lr: Uint8Array | null, lg: Uint8Array | null, lb: Uint8Array | null): void {
  const total = width * height;
  // ink: 反転後の文字の濃さ。eligible: 反転する画素（色つきの画素は、白黒中心の画像では残す）
  const ink = new Uint8Array(total);
  const eligible = new Uint8Array(total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (onlyGray && Math.max(r, g, b) - Math.min(r, g, b) > IMAGE_COLOR_CHROMA) continue;
    eligible[p] = 1;
    ink[p] = toneInk(255 - Math.round((r + g + b) / 3));
  }
  // 線を少し太らせる（上下左右の隣の画素の濃さに引っぱられる。透明に近い画素は、そのまま）
  const thick = new Uint8Array(ink);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!eligible[p] || ink[p] === 255 || data[p * 4 + 3] < 200) continue;
      let m = 0;
      if (x > 0 && eligible[p - 1] && ink[p - 1] > m) m = ink[p - 1];
      if (x < width - 1 && eligible[p + 1] && ink[p + 1] > m) m = ink[p + 1];
      if (y > 0 && eligible[p - width] && ink[p - width] > m) m = ink[p - width];
      if (y < height - 1 && eligible[p + width] && ink[p + width] > m) m = ink[p + width];
      const grown = Math.round(m * ENHANCE_THICKEN);
      if (grown > ink[p]) thick[p] = grown;
    }
  }
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    if (!eligible[p]) continue;
    const v = thick[p];
    data[i] = lr ? lr[v] : v;
    data[i + 1] = lg ? lg[v] : v;
    data[i + 2] = lb ? lb[v] : v;
  }
}

/**
 * 低い解像度の画像を、なめらかに2倍へ拡大するかの判定（文字をくっきり調整する画像だけ）。
 * 画面の大きさに対して粗い画像は、スライドに大きく映すと、文字や数式の縁がギザギザに見える。
 * 反転の前に、なめらかに2倍へ拡大しておくと、縁の濃淡が保たれて、きれいに見える（ファイルは少し大きくなる）。
 * 小さすぎる画像（アイコンなど）と、もともと十分に大きい画像は、そのまま。
 */
export const UPSCALE_MIN_LONG_SIDE = 600;
export const UPSCALE_MAX_LONG_SIDE = 1600;

export function shouldUpscale(width: number, height: number): boolean {
  const long = Math.max(width, height);
  return long >= UPSCALE_MIN_LONG_SIDE && long <= UPSCALE_MAX_LONG_SIDE;
}

/** Catmull-Rom の重み（t は 0〜1。4つの隣の画素に対する重みを返す） */
function catmullRomWeights(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/** 画像（RGBA）を、バイキュービック（Catmull-Rom）で縦横2倍に拡大する。透明度もいっしょに拡大する。元の画像は変えない */
export function upscale2x(image: RasterImage): RasterImage {
  const { width: w, height: h, data } = image;
  const w2 = w * 2;
  const h2 = h * 2;
  // 横方向: 出力の列ごとの、参照する列4つと重み
  const colIndex = new Int32Array(w2 * 4);
  const colWeight = new Float32Array(w2 * 4);
  for (let o = 0; o < w2; o++) {
    const s = (o + 0.5) / 2 - 0.5;
    const i = Math.floor(s);
    const wt = catmullRomWeights(s - i);
    for (let k = 0; k < 4; k++) {
      colIndex[o * 4 + k] = Math.min(w - 1, Math.max(0, i - 1 + k));
      colWeight[o * 4 + k] = wt[k];
    }
  }
  const tmp = new Float32Array(w2 * h * 4);
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4;
    for (let o = 0; o < w2; o++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) acc += data[rowBase + colIndex[o * 4 + k] * 4 + c] * colWeight[o * 4 + k];
        tmp[(y * w2 + o) * 4 + c] = acc;
      }
    }
  }
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let oy = 0; oy < h2; oy++) {
    const s = (oy + 0.5) / 2 - 0.5;
    const i = Math.floor(s);
    const wt = catmullRomWeights(s - i);
    const rows = [0, 1, 2, 3].map((k) => Math.min(h - 1, Math.max(0, i - 1 + k)));
    for (let x = 0; x < w2; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) acc += tmp[(rows[k] * w2 + x) * 4 + c] * wt[k];
        out[(oy * w2 + x) * 4 + c] = acc;
      }
    }
  }
  return { width: w2, height: h2, data: out };
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
  /** quality は JPEG の画質（0〜1）。省略時は 0.92 */
  encode(image: RasterImage, kind: RasterKind, quality?: number): Promise<Uint8Array>;
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
    async encode(image, kind, quality) {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, MIME[kind], kind === "jpeg" ? (quality ?? 0.92) : undefined));
      if (!blob) throw new Error("encode");
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}
