/**
 * PDF黒塗り・墨消し（工程4）の、画面と処理で共通の決まり。
 *
 * 方式（画面の説明・テストと同じ）:
 * - 黒塗りの範囲を指定したページは、ページ全体を画像にして、指定した範囲を黒で塗りつぶし、
 *   画像だけのページとして新しいPDFに入れる。元のページの文字・画像・図形のデータは、新しいPDFに一切入れない。
 *   （黒い四角形を重ねるだけの方式では、元の文字がファイルに残り、コピー・検索・文字抽出で読み取れるため、使わない）
 * - 範囲を指定しなかったページは、元のページをそのまま新しいPDFに入れる（文字検索・コピーもそのまま使える）。
 * - 範囲は「画面に表示されたページの縦横に対する割合」（0〜1）で持つ。表示の拡大・縮小、スクロール、ページの回転があっても、
 *   同じ場所を指すため、座標がずれない。
 */

/** 黒塗りの範囲。page は0始まり。x・y・width・height は、表示されたページ（左上が原点）に対する割合（0〜1） */
export interface RedactRegion {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 1回に処理できる総ページ数。超えるとエラーにして処理しない */
export const REDACT_MAX_PAGES = 100;
/** 黒塗りの範囲を指定できるページ数（画像にして書き出すページ数）。メモリ使用量を抑えるための上限 */
export const REDACT_MAX_REDACTED_PAGES = 30;
/** 1ページに指定できる範囲の数 */
export const REDACT_MAX_REGIONS_PER_PAGE = 200;
/** 画像にするときの倍率（PDFの1ptあたりのピクセル数。2 = 144dpi 相当） */
export const REDACT_RENDER_SCALE = 2;
/** 画像にするときの、1辺のピクセル数の上限（巨大なページでメモリを使い切らないため。超える場合は倍率を下げる） */
export const REDACT_MAX_PIXELS_PER_SIDE = 4000;
/** 小さすぎる範囲（誤ってクリックしただけのもの）として無視する、ページに対する割合の下限 */
export const REDACT_MIN_REGION_FRACTION = 0.004;
/** 黒塗りの色（まず黒のみ） */
export const REDACT_COLOR = "#000000";

export const REDACT_NOTICE = {
  title: "この黒塗りは、見た目だけでなく、元の文字や画像のデータをPDFから取り除きます。",
  points: [
    "範囲を指定したページは、ページ全体が画像に置き換わります。そのページでは、文字の選択・コピー・検索はできなくなります（黒塗りしていない部分の文字も同様です）。",
    "範囲を指定していないページは、元のままです。文字の検索やコピーも、そのまま使えます。",
    "範囲を指定していないページのリンク・注釈・入力欄は、安全のため引き継がれません。",
    "スキャンしたPDF（画像のPDF）も同じ方法で処理でき、指定した範囲の画像データは出力に残りません。",
    "元のファイルは変更しません。ダウンロードするのは新しいPDFです。",
  ],
} as const;

export class RedactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedactError";
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 範囲をページの内側に収める。大きさが小さすぎる・数値でない範囲は null（無視） */
export function normalizeRegion(region: RedactRegion): RedactRegion | null {
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every(Number.isFinite) || !Number.isInteger(region.page) || region.page < 0) return null;
  // 右下から左上へドラッグした場合などに備えて、幅・高さが負なら位置を入れ替える
  const left = clamp01(Math.min(region.x, region.x + region.width));
  const right = clamp01(Math.max(region.x, region.x + region.width));
  const top = clamp01(Math.min(region.y, region.y + region.height));
  const bottom = clamp01(Math.max(region.y, region.y + region.height));
  const width = right - left;
  const height = bottom - top;
  if (width < REDACT_MIN_REGION_FRACTION || height < REDACT_MIN_REGION_FRACTION) return null;
  return { page: region.page, x: left, y: top, width, height };
}

/** 範囲を整えて、ページごとにまとめる（ページ番号は0始まり）。無効な範囲は取り除く */
export function groupRegionsByPage(regions: RedactRegion[]): Map<number, RedactRegion[]> {
  const grouped = new Map<number, RedactRegion[]>();
  for (const region of regions) {
    const normalized = normalizeRegion(region);
    if (!normalized) continue;
    const list = grouped.get(normalized.page);
    if (list) list.push(normalized);
    else grouped.set(normalized.page, [normalized]);
  }
  return grouped;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 割合で持つ範囲を、画像（canvas）のピクセルの範囲にする。
 * 文字の端が1ピクセル残らないよう、外側へ切り上げる（左上は切り捨て、右下は切り上げ）。画像の外へははみ出さない。
 */
export function regionToPixelRect(region: RedactRegion, canvasWidth: number, canvasHeight: number): PixelRect {
  const left = Math.max(0, Math.floor(region.x * canvasWidth));
  const top = Math.max(0, Math.floor(region.y * canvasHeight));
  const right = Math.min(canvasWidth, Math.ceil((region.x + region.width) * canvasWidth));
  const bottom = Math.min(canvasHeight, Math.ceil((region.y + region.height) * canvasHeight));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 画像にするときの倍率。1辺のピクセル数が上限を超えるページは、上限に収まるまで倍率を下げる */
export function renderScaleFor(pageWidthPt: number, pageHeightPt: number): number {
  const longest = Math.max(pageWidthPt, pageHeightPt);
  if (!Number.isFinite(longest) || longest <= 0) return REDACT_RENDER_SCALE;
  return Math.min(REDACT_RENDER_SCALE, REDACT_MAX_PIXELS_PER_SIDE / longest);
}

/** 処理前の入力チェック（ページ数・範囲の数）。問題があれば RedactError */
export function validateRedactPlan(pageCount: number, regions: RedactRegion[]): Map<number, RedactRegion[]> {
  if (pageCount <= 0) throw new RedactError("このPDFにはページがありません。");
  if (pageCount > REDACT_MAX_PAGES) {
    throw new RedactError(
      `ページ数が多すぎます（${pageCount}ページ）。一度に処理できるのは${REDACT_MAX_PAGES}ページまでです。ページを分けてから、もう一度お試しください。`
    );
  }
  const grouped = groupRegionsByPage(regions);
  if (grouped.size === 0) throw new RedactError("黒塗りする範囲が指定されていません。ページ上をドラッグして範囲を指定してください。");
  for (const page of grouped.keys()) {
    if (page >= pageCount) throw new RedactError("存在しないページに範囲が指定されています。もう一度、範囲を指定し直してください。");
  }
  if (grouped.size > REDACT_MAX_REDACTED_PAGES) {
    throw new RedactError(
      `黒塗りするページが多すぎます（${grouped.size}ページ）。一度に処理できるのは${REDACT_MAX_REDACTED_PAGES}ページまでです。何回かに分けて処理してください。`
    );
  }
  for (const [, list] of grouped) {
    if (list.length > REDACT_MAX_REGIONS_PER_PAGE) {
      throw new RedactError(`1ページに指定できる範囲は${REDACT_MAX_REGIONS_PER_PAGE}個までです。`);
    }
  }
  return grouped;
}
