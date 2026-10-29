/**
 * AIが見つけた「文字の行」の範囲から、画像の「文字の範囲」の地図を作る（PowerPoint白黒反転の、AIによる色の判断の補助）。
 *
 * AIには、文字の中身を読むことは頼むが、画像を作り直すことは頼まない。ここで作る地図は、反転のときに
 * 「この範囲の中の細い色は、文字のにじみ・文字に重なった線なので、白黒にそろえる」と判断するためだけに使う。
 * 画像は、画像のまま反転する（消したり、文字を入れ直したりしない）。
 *
 * AIが返す位置は、実際の文字より小さい・ずれていることがあるため、画像の文字（白地に黒文字）に合わせて直してから使う。
 */
import type { PptxTextLine } from "@/lib/ai/pptx-text";
import type { RasterImage } from "./image-invert";
import { buildInkMask, padLine, snapLineToInk, type ReplaceLine } from "./text-replace";

/** 範囲にする行の種類。普通の文字と数式の行だけ（図の中のラベルは、色つきの線と近いので、範囲にしない） */
export const ZONE_KINDS: ReadonlySet<PptxTextLine["kind"]> = new Set(["text", "math"]);

export interface ZoneLine {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
    const base: ReplaceLine = { text: "", x: l.x, y: l.y, w: l.w, h: l.h, underline: false, bold: false };
    const snapped = snapLineToInk(ink, width, height, base);
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
