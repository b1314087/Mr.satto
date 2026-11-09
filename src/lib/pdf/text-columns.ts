import type { PositionedTextItem } from "./pdfjs-client";
import { groupIntoLines } from "./table-reconstruction";

/**
 * 段組み（2段・3段）の検出と、読む順番への並べ替え（工程4：PDF→Wordの精度改善）。
 *
 * これまでのPDF→Wordは段組みを検出せず、同じ高さにある左右の段の行を1行として扱っていたため、
 * 2段組みの文書で左右の段の文が交互に混ざったり、表と見誤られたりしていた。
 *
 * ここでは、ページの本文の中に、上から下まで文字がほとんどない縦の「すき間」（段間）があるかを調べ、
 * 見つかったときは、段ごとに文字を分けて、左の段→右の段の順（段の中は上から下）に読む。
 * 段をまたぐ見出し・図表の題などの行は、その位置で区切り（区切りの上下で、それぞれ段ごとに読む）。
 *
 * 表との区別：表もすき間を持つため、段とみなすのは「それぞれの段に、段の幅いっぱい近くまで続く文章の行が
 * 多い（文章の段）」ときだけにする。判定できないときは段組みなし（これまでどおり）として扱う。
 * 文字の内容は変えず、並べる順番だけを変える。
 */

export interface TextColumnLayout {
  /** 段の数（1は段組みなし） */
  columnCount: number;
  /** 段の間の平均の幅(pt) */
  gutterPt: number;
  /** 読む順番に並べた、文字のまとまり（それぞれを別々に段落へ組み立てる）。spanning は段をまたぐ行のまとまり */
  segments: { items: PositionedTextItem[]; spanning: boolean }[];
}

/** 段とみなすための条件 */
const RULES = {
  /** 段間とみなすすき間の最小の幅（本文の文字の大きさに対する倍率）と下限(pt) */
  minGutterFontRatio: 0.9,
  minGutterPt: 7,
  /** 段の最小の幅（本文の幅に対する割合） */
  minColumnWidthRatio: 0.2,
  /** 1つの段の最小の行数 */
  minLinesPerColumn: 5,
  /** 段の幅の6割以上まで続く行の割合（文章の段であることの判定） */
  minFullLineRatio: 0.55,
  /** 段間をまたぐ文字（見出しなど）として許す割合（本文の文字の数に対する割合） */
  maxSpanningRatio: 0.25,
} as const;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Range {
  x0: number;
  x1: number;
}

/** 段間の候補（文字の幅を区切りにして、段をまたがない文字だけで、縦に空いているすき間を探す） */
function findGutters(items: PositionedTextItem[], left: number, right: number, fontHeight: number): Range[] {
  const width = right - left;
  if (width <= 0) return [];
  const bins = Math.ceil(width);
  const cover = new Array<number>(bins).fill(0);
  // 長い文字列（段をまたぎうる見出しなど）は、すき間を探すときには数えない
  const narrow = items.filter((it) => it.width < width * 0.55);
  for (const it of narrow) {
    const a = Math.max(0, Math.floor(it.x - left));
    const b = Math.min(bins, Math.ceil(it.x + it.width - left));
    for (let i = a; i < b; i++) cover[i]++;
  }
  const maxCover = Math.max(1, ...cover);
  const threshold = Math.max(0, Math.floor(maxCover * 0.02));
  const minGutter = Math.max(RULES.minGutterPt, fontHeight * RULES.minGutterFontRatio);
  const gutters: Range[] = [];
  let start = -1;
  for (let i = 0; i <= bins; i++) {
    const empty = i < bins && cover[i] <= threshold;
    if (empty && start < 0) start = i;
    if (!empty && start >= 0) {
      const x0 = left + start;
      const x1 = left + i;
      // ページの端のすき間（余白）は段間ではない
      if (x1 - x0 >= minGutter && start > 0 && i < bins) gutters.push({ x0, x1 });
      start = -1;
    }
  }
  return gutters;
}

/** すき間で区切った段の範囲 */
function columnsFrom(gutters: Range[], left: number, right: number): Range[] {
  const cols: Range[] = [];
  let x = left;
  for (const g of gutters) {
    cols.push({ x0: x, x1: g.x0 });
    x = g.x1;
  }
  cols.push({ x0: x, x1: right });
  return cols;
}

function columnOf(item: PositionedTextItem, cols: Range[]): number {
  const a = item.x;
  const b = item.x + Math.max(item.width, 0.1);
  for (let i = 0; i < cols.length; i++) {
    if (a >= cols[i].x0 - 1 && b <= cols[i].x1 + 1) return i;
  }
  return -1; // 段をまたぐ
}

/** 段の中の行が、文章の段らしい（段の幅いっぱい近くまで続く行が多い）か */
function looksLikeTextColumn(items: PositionedTextItem[], col: Range): boolean {
  const lines = groupIntoLines(items);
  if (lines.length < RULES.minLinesPerColumn) return false;
  const colWidth = col.x1 - col.x0;
  const full = lines.filter((l) => {
    const l0 = Math.min(...l.items.map((i) => i.x));
    const l1 = Math.max(...l.items.map((i) => i.x + i.width));
    return l1 - l0 >= colWidth * 0.6;
  }).length;
  return full / lines.length >= RULES.minFullLineRatio;
}

/**
 * ページの文字の段組みを調べ、読む順番に並べたまとまりを返す。
 * 段組みがない（または判定できない）ときは、columnCount: 1 で、文字をそのまま1つのまとまりとして返す
 */
export function detectTextColumns(items: PositionedTextItem[]): TextColumnLayout {
  const body = items.filter((it) => it.str.trim() !== "");
  const single: TextColumnLayout = { columnCount: 1, gutterPt: 0, segments: [{ items, spanning: false }] };
  if (body.length < RULES.minLinesPerColumn * 2) return single;
  const left = Math.min(...body.map((i) => i.x));
  const right = Math.max(...body.map((i) => i.x + i.width));
  const width = right - left;
  const fontHeight = median(body.map((i) => i.fontHeight)) || 10;

  let gutters = findGutters(body, left, right, fontHeight);
  // 2段・3段だけを対象にする（それより多いすき間は表の可能性が高い）。広い順に選ぶ
  if (gutters.length === 0) return single;
  if (gutters.length > 2) gutters = [...gutters].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0)).slice(0, 2).sort((a, b) => a.x0 - b.x0);
  for (const tryGutters of gutters.length === 2 ? [gutters, [gutters[0]], [gutters[1]]] : [gutters]) {
    const cols = columnsFrom(tryGutters, left, right);
    if (cols.some((c) => c.x1 - c.x0 < width * RULES.minColumnWidthRatio)) continue;
    const byCol: PositionedTextItem[][] = cols.map(() => []);
    const spanning: PositionedTextItem[] = [];
    // 空白の項目（箇条書きの記号の代わりなど）も、位置で段に分ける（文字の判定には使わない）
    for (const it of items) {
      const c = columnOf(it, cols);
      if (c < 0) spanning.push(it);
      else byCol[c].push(it);
    }
    if (spanning.filter((it) => it.str.trim() !== "").length > body.length * RULES.maxSpanningRatio) continue;
    if (!byCol.every((colItems, i) => looksLikeTextColumn(colItems, cols[i]))) continue;
    return {
      columnCount: cols.length,
      gutterPt: tryGutters.reduce((s, g) => s + (g.x1 - g.x0), 0) / tryGutters.length,
      segments: orderSegments(byCol, spanning),
    };
  }
  return single;
}

/**
 * 段をまたぐ行（見出しなど）の位置で上下に区切り、区切りの間は段ごと（左の段→右の段）に並べる
 */
function orderSegments(byCol: PositionedTextItem[][], spanning: PositionedTextItem[]): TextColumnLayout["segments"] {
  // 段をまたぐ空白の項目は、文字を持たないので使わない
  const spanLines = groupIntoLines(spanning.filter((it) => it.str.trim() !== ""));
  // 区切りの高さ（上から順）。段をまたぐ行の上端・下端で区切る
  const cuts = spanLines.map((l) => {
    const top = Math.max(...l.items.map((i) => i.y + i.fontHeight));
    return { top, items: l.items };
  });
  const segments: TextColumnLayout["segments"] = [];
  let upper = Number.POSITIVE_INFINITY;
  const emitBand = (hi: number, lo: number) => {
    for (const colItems of byCol) {
      const band = colItems.filter((it) => it.y < hi && it.y >= lo);
      if (band.length > 0) segments.push({ items: band, spanning: false });
    }
  };
  // 区切りの上端の高さで帯に分ける（どの文字も、どれか1つの帯に必ず入る）
  for (const cut of cuts) {
    const at = cut.top - 0.01;
    emitBand(upper, at);
    segments.push({ items: cut.items, spanning: true });
    upper = at;
  }
  emitBand(upper, Number.NEGATIVE_INFINITY);
  return segments;
}
