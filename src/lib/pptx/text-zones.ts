/**
 * AIが見つけた「文字の行」の範囲から、画像の「文字の範囲」の地図を作る（PowerPoint白黒反転の、AIの判断で反転する機能）。
 *
 * AIには、文字の行の位置を見つけてもらうだけで、画像を作り直すことは頼まない。ここで作る地図は、反転のときに
 * 「この範囲の中の細い色は、文字のにじみ・文字に重なった線なので、白黒にそろえる」と判断するためだけに使う。
 * 画像は、画像のまま反転する（消したり、文字を入れ直したりしない）。
 *
 * AIが返す位置は、実際の文字より小さい・ずれていることがあるため、画像の文字（白地に黒文字）に合わせて直してから使う。
 */
import type { PptxTextLine } from "@/lib/ai/pptx-text";
import { parseHex } from "./color";
import type { RasterImage } from "./image-invert";

/** 画像全体に対する割合（0〜1）で表した、行の長方形。x, y は左上 */
export interface LineBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * AIが返した行の位置・大きさは、実際の文字より小さい（または、ずれている）ことがある。
 * 小さいままだと、文字のまわりの色のにじみまで、範囲が届かない。
 * そこで、画像の中の「文字の画素」を実際に探して、行の位置・大きさを合わせ直す。
 *  - 文字の画素: 背景色との明るさの差が大きい画素（方眼のうすい線などは含まない）。
 *  - AIの位置の近くで、縦に並んだ文字の画素のまとまり（1行ぶん）を探し、その左右を、すき間が空くまで広げる。
 *  - 見つからない・まとまりが大きすぎる（図や、ほかの行とくっついている）ときは、AIの位置のまま。
 */
export interface SnapResult {
  line: LineBox;
  /** 画像の文字に合わせて、位置・大きさを直した */
  snapped: boolean;
  /** 直した範囲の中の、文字の画素の割合（0〜1）。白い帯のような塗りは高く、文字・式はまばら */
  density: number;
}

const lumaRgb = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** 画像の「文字の画素」の地図（1が文字）。背景色との明るさの差が、しきい値以上の画素 */
export function buildInkMask(data: Uint8ClampedArray | Uint8Array, width: number, height: number, backgroundColor: string, textColor: string): Uint8Array {
  const bg = parseHex(backgroundColor) ?? { r: 0, g: 0, b: 0 };
  const tx = parseHex(textColor) ?? { r: 255, g: 255, b: 255 };
  const bgL = lumaRgb(bg.r, bg.g, bg.b);
  const span = Math.abs(lumaRgb(tx.r, tx.g, tx.b) - bgL);
  const threshold = Math.max(50, span * 0.4);
  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (data[i + 3] < 128) continue;
    if (Math.abs(lumaRgb(data[i], data[i + 1], data[i + 2]) - bgL) >= threshold) mask[p] = 1;
  }
  return mask;
}

/** 位置を直す対象の行の高さの上限（AIの高さの何倍まで広げるか）。これを超えるまとまりは、図や別の行とくっついているとみなす */
const SNAP_MAX_GROWTH = 3.6;
/** 文字の画素の割合がこれを超えるまとまりは、塗りつぶし（帯など）とみなして、位置を直さない */
const SNAP_MAX_DENSITY = 0.85;

export function snapLineToInk(mask: Uint8Array, width: number, height: number, line: LineBox): SnapResult {
  const keep: SnapResult = { line, snapped: false, density: 0 };
  const bx0 = line.x * width;
  const by0 = line.y * height;
  const bw = Math.max(1, line.w * width);
  const bh = Math.max(2, line.h * height);
  // 探す範囲: 縦は、AIの位置の少し上〜大きく下（AIが小さく・上にずれる場合が多い）。
  // 横は、AIの横の範囲だけ（広げると、隣の枠の線などを拾って、行がつながってしまう）
  const wx0 = clamp(Math.floor(bx0 - bh * 0.5), 0, width);
  const wx1 = clamp(Math.ceil(bx0 + bw + bh * 0.5), 0, width);
  const wy0 = clamp(Math.floor(by0 - bh * 1.2), 0, height);
  const wy1 = clamp(Math.ceil(by0 + bh * (1 + SNAP_MAX_GROWTH)), 0, height);
  if (wx1 - wx0 < 2 || wy1 - wy0 < 2) return keep;

  // 行ごとの文字の画素の数 → 縦のまとまり（すき間1行までは、つなげる）
  const rowHas = new Uint8Array(wy1 - wy0);
  for (let y = wy0; y < wy1; y++) {
    let n = 0;
    for (let x = wx0; x < wx1; x++) n += mask[y * width + x];
    // 画像の端の枠線のような、細い縦線だけの行は、文字の行とみなさない
    rowHas[y - wy0] = n >= Math.max(2, Math.ceil((wx1 - wx0) * 0.03)) ? 1 : 0;
  }
  const runs: { a: number; b: number }[] = [];
  let a = -1;
  let last = -1;
  for (let i = 0; i < rowHas.length; i++) {
    if (!rowHas[i]) continue;
    if (a >= 0 && i - last > 2) {
      runs.push({ a, b: last });
      a = -1;
    }
    if (a < 0) a = i;
    last = i;
  }
  if (a >= 0) runs.push({ a, b: last });
  // AIの行（by0〜by0+bh）といちばん重なるまとまりを選ぶ
  let best: { a: number; b: number } | null = null;
  let bestOverlap = 0;
  for (const run of runs) {
    const ya = wy0 + run.a;
    const yb = wy0 + run.b + 1;
    const overlap = Math.min(yb, by0 + bh) - Math.max(ya, by0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = run;
    }
  }
  if (!best || bestOverlap <= 0) return keep;
  const ry0 = wy0 + best.a;
  const ry1 = wy0 + best.b + 1;
  const rh = ry1 - ry0;
  if (rh > bh * SNAP_MAX_GROWTH || rh < 2) return keep;

  // 横: まとまりの行の範囲で、文字の画素がある列。AIの位置から、すき間が空くまで左右へ広げる
  const colHas = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    for (let y = ry0; y < ry1; y++) {
      if (mask[y * width + x]) {
        colHas[x] = 1;
        break;
      }
    }
  }
  const gap = Math.max(4, Math.round(rh));
  // 種になる列: AIの横の範囲の中の、いちばん左の文字の列
  let seed = -1;
  for (let x = clamp(Math.floor(bx0 - bh), 0, width); x < clamp(Math.ceil(bx0 + bw + bh), 0, width); x++) {
    if (colHas[x]) {
      seed = x;
      break;
    }
  }
  if (seed < 0) return keep;
  let left = seed;
  for (let x = seed - 1, miss = 0; x >= 0 && miss <= gap; x--) {
    if (colHas[x]) {
      left = x;
      miss = 0;
    } else miss++;
  }
  let right = seed;
  const maxRight = clamp(Math.ceil(bx0 + bw * SNAP_MAX_GROWTH + bh * 4), 0, width);
  for (let x = seed + 1, miss = 0; x < maxRight && miss <= gap; x++) {
    if (colHas[x]) {
      right = x;
      miss = 0;
    } else miss++;
  }
  const nx = left / width;
  const ny = ry0 / height;
  const nw = (right + 1 - left) / width;
  const nh = rh / height;
  // ほとんど変わらないときは、AIの位置のまま（わずかな差で、毎回動かさない）
  if (Math.abs(nx - line.x) < 0.004 && Math.abs(ny - line.y) < 0.004 && Math.abs(nw - line.w) < 0.01 && Math.abs(nh - line.h) < 0.006) return keep;
  let ink = 0;
  for (let y = ry0; y < ry1; y++) for (let x = left; x <= right; x++) ink += mask[y * width + x];
  const density = ink / ((right + 1 - left) * rh);
  // ほぼ全面が塗りつぶされているもの（帯・図形）は、文字ではなく塗り。文字の範囲を決められないので、AIの位置のまま
  if (density > SNAP_MAX_DENSITY) return keep;
  return { line: { ...line, x: nx, y: ny, w: nw, h: nh }, snapped: true, density };
}

/** 消す範囲を、上下左右に、行の高さの約15%（最低1px）広げる */
export function padLine(line: LineBox, width: number, height: number): LineBox {
  const px = Math.max(1, Math.round(line.h * height * 0.15));
  const x0 = Math.max(0, line.x - px / width);
  const y0 = Math.max(0, line.y - px / height);
  const x1 = Math.min(1, line.x + line.w + px / width);
  const y1 = Math.min(1, line.y + line.h + px / height);
  return { ...line, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 範囲にする行の種類。普通の文字と数式の行だけ（図の中のラベルは、色つきの線と近いので、範囲にしない） */
export const ZONE_KINDS: ReadonlySet<PptxTextLine["kind"]> = new Set(["text", "math"]);

export type ZoneLine = LineBox;

/**
 * 画像（白地・黒文字）と、AIが見つけた行の範囲（画像全体を0〜1にした割合）から、文字の範囲の地図を作る。
 * 返すのは、画像と同じ大きさの配列（1が範囲の中）。範囲が1つもなければ null。
 */
export function buildTextZoneMask(image: RasterImage, lines: ZoneLine[]): Uint8Array | null {
  const { width, height } = image;
  if (lines.length === 0 || width < 2 || height < 2) return null;
  const ink = buildInkMask(image.data, width, height, "FFFFFF", "000000");
  const zone = new Uint8Array(width * height);
  let any = false;
  for (const l of lines) {
    const snapped = snapLineToInk(ink, width, height, l);
    // 文字のふちの色のにじみは、文字の画素の1〜3画素外側にあるので、範囲を少し広げる
    const r = padLine(snapped.line, width, height);
    const x0 = Math.max(0, Math.floor(r.x * width));
    const y0 = Math.max(0, Math.floor(r.y * height));
    const x1 = Math.min(width, Math.ceil((r.x + r.w) * width));
    const y1 = Math.min(height, Math.ceil((r.y + r.h) * height));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) zone[y * width + x] = 1;
    if (x1 > x0 && y1 > y0) any = true;
  }
  return any ? zone : null;
}
