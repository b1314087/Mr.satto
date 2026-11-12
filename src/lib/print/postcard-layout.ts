import { PAPER_SIZES_PT, applyOrientation, type PaperOrientation } from "./paper-sizes";

/**
 * ハガキ作成（次期機能追加 1）の配置の計算。画面のプレビュー（SVG）とPDFの書き出しで同じ計算を使い、
 * 見た目と出来上がりがずれないようにする。
 *
 * - 大きさは日本のはがき（100mm × 148mm）。縦向き・横向きを選べる。
 * - 座標は、はがきの左上を原点にしたpt（1pt = 1/72インチ）。PDFでは下から測るため、書き出しのときに上下を反転する。
 * - 文字・画像の位置は、はがきの幅・高さに対する割合（0〜100%）で、文字・画像の「中心」を表す。
 *   文字は中央揃え（行ごとに中心をそろえる）にするため、プレビューとPDFで文字の幅の測り方が少し違っても、位置はずれない。
 * - 画像は縦横比を保ったまま、幅（はがきの幅に対する割合）で大きさを決める（引き伸ばし・切り抜きはしない）。
 */

export type PostcardOrientation = PaperOrientation;

export const POSTCARD_ORIENTATION_LABELS: Record<PostcardOrientation, string> = {
  portrait: "縦向き",
  landscape: "横向き",
};

/** はがきの大きさ（pt）。縦向きは 283.46 × 419.53（100mm × 148mm） */
export function postcardSizePt(orientation: PostcardOrientation): { width: number; height: number } {
  return applyOrientation(PAPER_SIZES_PT.Postcard, orientation);
}

export const POSTCARD_TEXT_MIN_PT = 6;
export const POSTCARD_TEXT_MAX_PT = 96;
export const POSTCARD_IMAGE_MIN_PCT = 5;
export const POSTCARD_IMAGE_MAX_PCT = 200;
export const POSTCARD_MAX_TEXTS = 20;
export const POSTCARD_MAX_IMAGES = 10;
/** 行の間隔（文字の大きさに対する倍率） */
export const POSTCARD_LINE_HEIGHT = 1.4;
/** 1行の上端から、文字のベースライン（文字の下の線）までの割合（日本語の書体のおおよその値） */
const BASELINE_RATIO = 0.88;

export interface PostcardText {
  id: string;
  text: string;
  /** 文字の大きさ（pt） */
  size: number;
  /** #rrggbb */
  color: string;
  /** 文字のまとまりの中心（はがきの幅・高さに対する割合 0〜100） */
  x: number;
  y: number;
}

export interface PostcardImage {
  id: string;
  /** 画像の元の大きさ（px。写真の向きの情報を反映した後の大きさ） */
  naturalWidth: number;
  naturalHeight: number;
  /** 画像の中心（はがきの幅・高さに対する割合 0〜100） */
  x: number;
  y: number;
  /** 画像の幅（はがきの幅に対する割合）。高さは縦横比から決める */
  widthPct: number;
}

export interface PostcardTextLine {
  text: string;
  /** 行の中心のx（pt） */
  x: number;
  /** ベースラインのy（pt。上から） */
  baseline: number;
}

/** 文字のまとまりを、行ごとの位置にする（中央揃え） */
export function layoutPostcardText(t: PostcardText, page: { width: number; height: number }): PostcardTextLine[] {
  const lines = t.text.replace(/\r\n?/g, "\n").split("\n");
  const lineHeight = t.size * POSTCARD_LINE_HEIGHT;
  const blockHeight = lines.length * lineHeight;
  const cx = (t.x / 100) * page.width;
  const top = (t.y / 100) * page.height - blockHeight / 2;
  return lines.map((text, i) => ({ text, x: cx, baseline: top + i * lineHeight + (lineHeight - t.size) / 2 + t.size * BASELINE_RATIO }));
}

/** 画像を置く四角（pt。左上の位置と大きさ） */
export function layoutPostcardImage(img: PostcardImage, page: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const width = (img.widthPct / 100) * page.width;
  const height = img.naturalWidth > 0 ? width * (img.naturalHeight / img.naturalWidth) : width;
  return { x: (img.x / 100) * page.width - width / 2, y: (img.y / 100) * page.height - height / 2, width, height };
}

/** #rrggbb を 0〜1 のRGBにする（読めない値は黒） */
export function hexToRgb01(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 入力の確かめ（書き出しの前に呼ぶ。問題があれば日本語のメッセージ） */
export function validatePostcard(texts: PostcardText[], images: PostcardImage[]): string | null {
  const usedTexts = texts.filter((t) => t.text.trim() !== "");
  if (usedTexts.length === 0 && images.length === 0) return "文字か画像を1つ以上入れてください。";
  if (texts.length > POSTCARD_MAX_TEXTS) return `文字は${POSTCARD_MAX_TEXTS}個まで置けます。`;
  if (images.length > POSTCARD_MAX_IMAGES) return `画像は${POSTCARD_MAX_IMAGES}枚まで置けます。`;
  const inPct = (v: number) => Number.isFinite(v) && v >= 0 && v <= 100;
  for (const t of usedTexts) {
    if (!Number.isFinite(t.size) || t.size < POSTCARD_TEXT_MIN_PT || t.size > POSTCARD_TEXT_MAX_PT) {
      return `文字の大きさは${POSTCARD_TEXT_MIN_PT}〜${POSTCARD_TEXT_MAX_PT}ptの範囲で指定してください。`;
    }
    if (!inPct(t.x) || !inPct(t.y)) return "文字の位置は0〜100%の範囲で指定してください。";
  }
  for (const img of images) {
    if (!inPct(img.x) || !inPct(img.y)) return "画像の位置は0〜100%の範囲で指定してください。";
    if (!Number.isFinite(img.widthPct) || img.widthPct < POSTCARD_IMAGE_MIN_PCT || img.widthPct > POSTCARD_IMAGE_MAX_PCT) {
      return `画像の大きさは${POSTCARD_IMAGE_MIN_PCT}〜${POSTCARD_IMAGE_MAX_PCT}%の範囲で指定してください。`;
    }
  }
  return null;
}
