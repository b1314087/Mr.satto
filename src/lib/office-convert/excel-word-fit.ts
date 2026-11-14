/**
 * Excel→Word変換の「用紙に収める」計算（画面・ファイルを使わない純粋な処理。テストしやすいように分けてある）。
 *
 * 最優先の決まり：Wordの表・画像を、ページの印刷できる範囲（用紙から余白を除いた範囲）の横幅を超えて置かない。
 * 表の幅はWordの自動調整に任せず、列ごとの幅（twip = 1/20pt）をここで決めて、固定の幅の表として書き出す。
 *
 * 収まらないときの順番（指示書3-2）：
 *   1. 元の列幅の比率を保ったまま縮める（MIN_SHRINK まで）。縮めた表では、セルの左右の余白も小さくし、文字を折り返す
 *   2. 元が縦向きで、横向きにすれば縮め過ぎずに収まる場合だけ、横向きにする（自動の向きの調整がオンのとき）
 *   3. それでも収まらなければ、列の途中でページを分ける（結合セルの途中では、なるべく分けない）
 * 文字の大きさは、Excelの印刷の倍率（拡大縮小・ページに合わせる）の分だけ小さくし、MIN_FONT_PT より小さくはしない。
 * 列を消したり、右端・左端を切り捨てたりはしない。
 */

export const TWIPS_PER_PT = 20;
/** 縮めてよい限度（元の列幅の65%まで）。これより縮めると読みにくくなるため、横向き・列での分割を使う */
export const MIN_SHRINK = 0.65;
/** 文字の大きさの下限（Excelの縮小印刷の倍率をかけても、これより小さくしない） */
export const MIN_FONT_PT = 7;
/** 1列の幅の下限（pt）。0や極端に細い列で文字が縦に並ばないように */
export const MIN_COLUMN_PT = 9;

export interface PaperSize {
  name: string;
  /** 縦向きのときの幅・高さ（pt） */
  widthPt: number;
  heightPt: number;
}

const MM = 72 / 25.4;
const paper = (name: string, wMm: number, hMm: number): PaperSize => ({ name, widthPt: wMm * MM, heightPt: hMm * MM });

/** src/lib/excel/ooxml-page-settings.ts の用紙名 → 大きさ */
export const PAPER_SIZES: Record<string, PaperSize> = {
  A2: paper("A2", 420, 594),
  A3: paper("A3", 297, 420),
  A4: paper("A4", 210, 297),
  A5: paper("A5", 148, 210),
  A6: paper("A6", 105, 148),
  B4: paper("B4", 257, 364),
  B5: paper("B5", 182, 257),
  B6: paper("B6", 128, 182),
  "B4-ISO": paper("B4", 250, 353),
  "B5-ISO": paper("B5", 176, 250),
  Letter: { name: "Letter", widthPt: 612, heightPt: 792 },
  Legal: { name: "Legal", widthPt: 612, heightPt: 1008 },
  Tabloid: { name: "Tabloid", widthPt: 792, heightPt: 1224 },
  Ledger: { name: "Ledger", widthPt: 1224, heightPt: 792 },
  Statement: { name: "Statement", widthPt: 396, heightPt: 612 },
  Executive: { name: "Executive", widthPt: 522, heightPt: 756 },
  Folio: paper("Folio", 216, 330),
  Quarto: paper("Quarto", 215, 275),
  Postcard: paper("はがき", 100, 148),
  DoublePostcard: paper("往復はがき", 148, 200),
};

export interface PageGeometry {
  paper: PaperSize;
  orientation: "portrait" | "landscape";
  /** pt */
  margins: { top: number; bottom: number; left: number; right: number; header: number; footer: number };
}

/** Excelの既定の余白（標準）：上下0.75インチ・左右0.7インチ・ヘッダー/フッター0.3インチ */
export const EXCEL_DEFAULT_MARGINS_PT = { top: 54, bottom: 54, left: 50.4, right: 50.4, header: 21.6, footer: 21.6 };

export function pageWidthPt(g: PageGeometry): number {
  return g.orientation === "landscape" ? g.paper.heightPt : g.paper.widthPt;
}
export function pageHeightPt(g: PageGeometry): number {
  return g.orientation === "landscape" ? g.paper.widthPt : g.paper.heightPt;
}

/**
 * 印刷できる範囲の幅（twip）。Wordに書き出すページの幅・余白をtwipにしてから引く（四捨五入のずれで、はみ出さないように）
 */
export function printableWidthTwips(g: PageGeometry): number {
  return pageTwips(g).width - Math.round(g.margins.left * TWIPS_PER_PT) - Math.round(g.margins.right * TWIPS_PER_PT);
}
export function printableHeightTwips(g: PageGeometry): number {
  return pageTwips(g).height - Math.round(g.margins.top * TWIPS_PER_PT) - Math.round(g.margins.bottom * TWIPS_PER_PT);
}
export function pageTwips(g: PageGeometry): { width: number; height: number } {
  return { width: Math.round(pageWidthPt(g) * TWIPS_PER_PT), height: Math.round(pageHeightPt(g) * TWIPS_PER_PT) };
}

/**
 * Excelの印刷の倍率（ページ設定の「拡大縮小」「次のページ数に合わせて印刷」）。
 * ページに合わせる設定は、横方向のページ数（fitToWidth）だけを使う（Wordでは縦方向は内容に合わせてページが続くため）。
 */
export function excelPrintScale(opts: {
  fitToPageEnabled: boolean;
  fitToWidth: number | null;
  scalePercent: number | null;
  totalWidthPt: number;
  printableWidthPt: number;
}): number {
  if (opts.fitToPageEnabled) {
    const pages = opts.fitToWidth ?? 1;
    if (pages >= 1 && opts.totalWidthPt > 0) return Math.min(1, (pages * opts.printableWidthPt) / opts.totalWidthPt);
    return 1;
  }
  if (opts.scalePercent && opts.scalePercent > 0) return Math.min(4, Math.max(0.1, opts.scalePercent / 100));
  return 1;
}

export interface ColumnGroup {
  /** このページ（列のまとまり）に入る列の番号（入力の配列の添字） */
  cols: number[];
  /** 列ごとの幅（twip）。合計は印刷できる範囲の幅以下 */
  widthsTwips: number[];
  /** 元の幅に対する縮小率（1 = 縮めていない） */
  shrink: number;
}

export interface FitResult {
  orientation: "portrait" | "landscape";
  groups: ColumnGroup[];
  /** 横向きに変えたか */
  rotated: boolean;
  /** 列の途中でページを分けたとき、結合セルの途中で分けた数 */
  splitMerges: number;
}

export interface FitInput {
  /** 列の幅（pt。Excelの印刷の倍率をかけたあと） */
  columnWidthsPt: number[];
  geometry: PageGeometry;
  /** 元が縦向きのとき、必要なら横向きに変えてよいか */
  allowAutoLandscape: boolean;
  /** 結合セルの列の範囲（入力の配列の添字。両端を含む）。この途中では、なるべく列を分けない */
  mergeColSpans: { start: number; end: number }[];
  /** Excelの手動の改ページ（この列の後でページを分ける。入力の配列の添字） */
  forcedBreaksAfter?: number[];
  /** 毎ページに繰り返す列（印刷タイトル。入力の配列の添字） */
  repeatCols?: number[];
}

/** 合計が limit 以下になるよう、比率を保って整数のtwipに配分する（各列は最低幅を守る） */
export function distributeTwips(widthsPt: number[], limitTwips: number): number[] {
  const minTw = Math.round(MIN_COLUMN_PT * TWIPS_PER_PT);
  const raw = widthsPt.map((w) => Math.max(minTw, Math.round(w * TWIPS_PER_PT)));
  const total = raw.reduce((s, w) => s + w, 0);
  if (total <= limitTwips) return raw;
  // 最低幅の列は固定し、残りを比率で縮める（最低幅だけで超える場合は、全体を均等に）
  const n = raw.length;
  if (n * minTw >= limitTwips) {
    const each = Math.floor(limitTwips / n);
    return raw.map(() => each);
  }
  let widths = raw.slice();
  for (let iter = 0; iter < 8; iter++) {
    const fixed = widths.filter((w) => w <= minTw).length;
    const flexTotal = widths.reduce((s, w) => (w > minTw ? s + w : s), 0);
    const room = limitTwips - fixed * minTw;
    const ratio = room / flexTotal;
    widths = widths.map((w) => (w > minTw ? Math.max(minTw, Math.floor(w * ratio)) : minTw));
    if (widths.reduce((s, w) => s + w, 0) <= limitTwips) break;
  }
  // 端数のずれを、最後に確実に収める
  let sum = widths.reduce((s, w) => s + w, 0);
  for (let i = widths.length - 1; sum > limitTwips && i >= 0; i--) {
    const cut = Math.min(sum - limitTwips, widths[i] - 1);
    widths[i] -= cut;
    sum -= cut;
  }
  return widths;
}

function groupOf(cols: number[], widthsPt: number[], limitTwips: number): ColumnGroup {
  const w = cols.map((c) => widthsPt[c]);
  const totalTw = w.reduce((s, x) => s + Math.max(MIN_COLUMN_PT, x) * TWIPS_PER_PT, 0);
  const widthsTwips = distributeTwips(w, limitTwips);
  return { cols, widthsTwips, shrink: totalTw > 0 ? Math.min(1, limitTwips / totalTw) : 1 };
}

export function fitColumns(input: FitInput): FitResult {
  const { columnWidthsPt: widths, allowAutoLandscape, mergeColSpans } = input;
  const all = widths.map((_, i) => i);
  const totalPt = widths.reduce((s, w) => s + Math.max(MIN_COLUMN_PT, w), 0);
  let geometry = input.geometry;
  let rotated = false;
  let limit = printableWidthTwips(geometry);
  const forced = new Set(input.forcedBreaksAfter ?? []);

  const fits = (g: PageGeometry) => (printableWidthTwips(g) / TWIPS_PER_PT) / totalPt >= MIN_SHRINK;

  if (forced.size === 0) {
    if (totalPt * TWIPS_PER_PT <= limit || fits(geometry)) {
      return { orientation: geometry.orientation, groups: [groupOf(all, widths, limit)], rotated, splitMerges: 0 };
    }
    if (allowAutoLandscape && geometry.orientation === "portrait") {
      const landscape: PageGeometry = { ...geometry, orientation: "landscape" };
      if (fits(landscape)) {
        return { orientation: "landscape", groups: [groupOf(all, widths, printableWidthTwips(landscape))], rotated: true, splitMerges: 0 };
      }
      // 横向きでも分ける必要がある幅なら、ページ数が少なくなる向きを選ぶ（縦向きのまま分けるより、横向きの方が分け方が少ない場合）
      const pagesPortrait = Math.ceil((totalPt * TWIPS_PER_PT) / (limit / MIN_SHRINK));
      const pagesLandscape = Math.ceil((totalPt * TWIPS_PER_PT) / (printableWidthTwips(landscape) / MIN_SHRINK));
      if (pagesLandscape < pagesPortrait) {
        geometry = landscape;
        rotated = true;
        limit = printableWidthTwips(landscape);
      }
    }
  }

  // 列の途中でページを分ける
  const repeat = (input.repeatCols ?? []).filter((c) => c >= 0 && c < widths.length);
  const repeatTw = repeat.reduce((s, c) => s + Math.max(MIN_COLUMN_PT, widths[c]) * TWIPS_PER_PT, 0);
  const useRepeat = repeat.length > 0 && repeatTw < limit * 0.4;
  const repeatSet = new Set(useRepeat ? repeat : []);
  const badBoundary = (afterCol: number) => mergeColSpans.some((m) => m.start <= afterCol && m.end > afterCol);
  const budget = limit / MIN_SHRINK;

  const groups: ColumnGroup[] = [];
  let splitMerges = 0;
  let start = 0;
  while (start < widths.length) {
    const prefix = groups.length > 0 && useRepeat ? repeat.filter((c) => c < start) : [];
    const prefixTw = prefix.reduce((s, c) => s + Math.max(MIN_COLUMN_PT, widths[c]) * TWIPS_PER_PT, 0);
    let end = start;
    let acc = prefixTw;
    let lastGood = -1;
    for (let c = start; c < widths.length; c++) {
      const w = Math.max(MIN_COLUMN_PT, widths[c]) * TWIPS_PER_PT;
      if (c > start && acc + w > budget) break;
      acc += w;
      end = c;
      if (!badBoundary(c)) lastGood = c;
      if (forced.has(c)) break;
    }
    let cut = end;
    if (end < widths.length - 1 && !forced.has(end) && badBoundary(end)) {
      if (lastGood >= start) cut = lastGood;
      else splitMerges++;
    }
    const cols = [...prefix, ...Array.from({ length: cut - start + 1 }, (_, i) => start + i).filter((c) => !(groups.length > 0 && repeatSet.has(c) && c < start))];
    groups.push(groupOf(cols, widths, limit));
    start = cut + 1;
  }
  return { orientation: geometry.orientation, groups, rotated, splitMerges };
}

/** 画像の大きさを、縦横比を保って、印刷できる範囲に収める（pt） */
export function fitImageBox(widthPt: number, heightPt: number, maxWidthPt: number, maxHeightPt: number): { widthPt: number; heightPt: number; scaled: boolean } {
  if (widthPt <= 0 || heightPt <= 0) return { widthPt: 0, heightPt: 0, scaled: false };
  const k = Math.min(1, maxWidthPt / widthPt, maxHeightPt / heightPt);
  return { widthPt: widthPt * k, heightPt: heightPt * k, scaled: k < 1 };
}

/** Excelの印刷の倍率をかけた文字の大きさ（下限 MIN_FONT_PT。元が下限より小さい文字は、元の大きさのまま） */
export function scaledFontPt(sizePt: number, scale: number): number {
  const s = sizePt * scale;
  if (s >= MIN_FONT_PT) return s;
  return Math.min(sizePt, MIN_FONT_PT);
}
