import type { PositionedTextItem } from "./pdfjs-client";

/**
 * PDFの座標付きテキストから、表の行・列構造を推定する（Phase 2-D ■表構造推定）。
 *
 * 単純に「1行1テキストをCSVの1行にする」というテキスト連結ではなく、
 * 文字の x/y 座標・幅・行間から
 *   1. どのテキストが同じ「行」に属するか（y座標のクラスタリング）
 *   2. どのテキストが同じ「列」に属するか（列と列の間の空白＝ギャップの検出）
 * を推定し、行×列の2次元グリッドを組み立てる。
 *
 * 列の検出は「文字の左端x座標が揃っている」ことを前提にしない
 * （数値列は右揃えのことが多く、左端は行ごとにバラバラになるため）。
 * 代わりに、各行内でテキスト同士の間に空いた「大きめの隙間」を候補とし、
 * その隙間がページ全体の複数行で共通して現れる位置だけを
 * 実際の列区切りとして採用する。これにより左揃え・右揃え・中央揃えの
 * どの列でも実用的に列を推定できる。
 *
 * 完全に複雑なPDFの表（結合セル・多段見出し等）を100%再現することは
 * 保証しない（開発指示書■「複雑なPDFについて」）。あくまで実用的な
 * 精度を目指す。
 *
 * 【列区切りの検出方法：ページ全体でのカバレッジ判定】
 * 当初は「各行ごとに隣り合うテキストの隙間を求め、複数行で近い位置に
 * 現れた隙間だけを列区切りとして採用する」方式を試したが、以下の理由で
 * 不安定だった：
 *   - pdf生成ツールによっては、各セルを別々のテキスト描画命令として
 *     出力することがあり、その場合pdfjsの getTextContent() は実テキスト
 *     同士の間に `str: " "` という空白専用の項目を自動挿入し、
 *     その項目の width が隙間の大きさをそのまま表してしまう
 *     （＝隣接テキスト同士のバウンディングボックスの隙間は常に0に見える）。
 *   - 行ごとに文字数・揃え（左揃え/右揃え）が異なると、同じ列であっても
 *     行ごとに隙間の開始・終了位置（＝中点）が変わってしまい、
 *     複数行で「同じ位置」に集約されない。
 *
 * そこで、行単位ではなくページ全体で「どのx座標にも一度も文字が
 * かからない、連続した縦の帯（コリドー）」を検出する方式に変更した。
 * これは表の列区切りが持つ本質的な性質（＝どの行の文字もその位置には
 * 掛からない）を直接利用するもので、揃え方や行ごとの文字数の違いに
 * 左右されない。
 */

/** 行のグルーピング結果。PDF→Word（paragraph-reconstruction.ts）とも共通利用する（開発指示書■21） */
export interface Line {
  y: number;
  items: PositionedTextItem[];
}

const MIN_GAP_TOLERANCE = 3; // pt
/** 列区切りの帯として認識するための最小幅の比率（1文字あたりの目安幅に対する倍率） */
const MIN_GAP_WIDTH_RATIO = 2.5;
const BIN_SIZE_PT = 1;

function isBlank(item: PositionedTextItem): boolean {
  return item.str.trim() === "";
}

/**
 * 座標付きテキストをy座標でグルーピングし「行」の単位にまとめる。
 * PDF→Excelの表構造推定・PDF→Wordの段落構造推定の両方が使う共通処理
 * （開発指示書■21：共通のPDF解析基盤として集約する）。
 */
export function groupIntoLines(items: PositionedTextItem[]): Line[] {
  // 空白専用の項目（pdfjsが隙間を表すために挿入することがある）は
  // 列区切りの判定には使わず（後述のカバレッジ判定はテキストの実体のみで行う）、
  // 行のグルーピングの時点で除外してよい
  const meaningful = items.filter((item) => !isBlank(item));
  const sorted = [...meaningful].sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  for (const item of sorted) {
    const tolerance = Math.max(MIN_GAP_TOLERANCE, item.fontHeight * 0.4);
    const line = lines.find((l) => Math.abs(l.y - item.y) <= tolerance);
    if (line) {
      line.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

/**
 * ページ全体で「どの行の文字もかからない、一定幅以上の縦の帯」を検出し、
 * その中点を列区切りのx座標として返す。
 * 揃え（左揃え/右揃え/中央揃え）や行ごとの文字数の違いに影響されない
 * （どの行も、列と列の間の余白そのものには文字がかからないという
 * 表の本質的な性質を直接利用しているため）。
 */
function computeColumnBreaks(lines: Line[]): number[] {
  const contentItems = lines.flatMap((line) => line.items);
  if (contentItems.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  for (const item of contentItems) {
    minX = Math.min(minX, item.x);
    maxX = Math.max(maxX, item.x + item.width);
  }
  if (!Number.isFinite(minX) || maxX <= minX) return [];

  const charWidths = contentItems
    .map((item) => (item.str.length > 0 ? item.width / item.str.length : item.width))
    .filter((w) => w > 0)
    .sort((a, b) => a - b);
  const medianCharWidth = charWidths[Math.floor(charWidths.length / 2)] || 4;
  const minGapWidth = Math.max(medianCharWidth * MIN_GAP_WIDTH_RATIO, 6);

  const binCount = Math.max(1, Math.ceil((maxX - minX) / BIN_SIZE_PT) + 1);
  const covered = new Uint8Array(binCount);
  for (const item of contentItems) {
    const startBin = Math.max(0, Math.floor((item.x - minX) / BIN_SIZE_PT));
    const endBin = Math.min(binCount, Math.ceil((item.x + item.width - minX) / BIN_SIZE_PT));
    for (let b = startBin; b < endBin; b++) covered[b] = 1;
  }

  const breaks: number[] = [];
  let gapStartBin: number | null = null;
  for (let b = 0; b < binCount; b++) {
    if (covered[b] === 0) {
      if (gapStartBin === null) gapStartBin = b;
      continue;
    }
    if (gapStartBin !== null) {
      const widthPt = (b - gapStartBin) * BIN_SIZE_PT;
      if (widthPt >= minGapWidth) {
        breaks.push(minX + ((gapStartBin + b) / 2) * BIN_SIZE_PT);
      }
      gapStartBin = null;
    }
  }
  // ループ終了時点でまだ隙間が続いている場合は、内容の右端より外側の
  // 余白（表の外側）なので列区切りとしては扱わない（意図的に無視する）

  return breaks;
}

function columnIndexFor(x: number, breaks: number[]): number {
  let idx = 0;
  for (const b of breaks) {
    if (x >= b) idx++;
    else break;
  }
  return idx;
}

export interface ReconstructedTable {
  /** 行×列の文字列グリッド（空セルは空文字列） */
  rows: string[][];
  columnCount: number;
}

/**
 * 1ページ分の座標付きテキストから表（行×列グリッド）を推定する。
 * 表らしい隙間パターンが見つからない場合は、1行=1列（1セル）として
 * 安全側にフォールバックする（プレーンなテキストPDFでもクラッシュせず、
 * 最低限行ごとのテキストとして出力できるようにするため）。
 */
export function reconstructTable(items: PositionedTextItem[]): ReconstructedTable {
  const lines = groupIntoLines(items);
  if (lines.length === 0) {
    return { rows: [], columnCount: 0 };
  }

  const breaks = computeColumnBreaks(lines);
  const columnCount = breaks.length + 1;

  const rows: string[][] = lines.map((line) => {
    const row: string[][] = Array.from({ length: columnCount }, () => []);
    for (const item of line.items) {
      const midX = item.x + item.width / 2;
      const colIndex = Math.min(columnCount - 1, columnIndexFor(midX, breaks));
      row[colIndex].push(item.str);
    }
    return row.map((cellParts) => cellParts.join(" ").replace(/\s+/g, " ").trim());
  });

  return { rows, columnCount };
}

// ---------------------------------------------------------------------------
// セルの型推定（数値・日付）。PDF→Excelが利用する。
// 「文字列として扱うべきものを勝手に数値化しすぎない」ため、
// 通貨記号・パーセント記号付きの値や曖昧な表記は文字列のまま扱う。
// ---------------------------------------------------------------------------

const PLAIN_NUMBER_RE = /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$|^[+-]?\d+(\.\d+)?$/;

/** カンマ区切りの整数・小数のみを数値として認識する（通貨記号・%は対象外） */
export function tryParseNumberCell(text: string): number | null {
  const t = text.trim();
  if (t === "" || !PLAIN_NUMBER_RE.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function safeDate(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

const DATE_PATTERNS: { re: RegExp; toDate: (m: RegExpMatchArray) => Date | null }[] = [
  { re: /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/, toDate: (m) => safeDate(+m[1], +m[2], +m[3]) },
  { re: /^(\d{4})年(\d{1,2})月(\d{1,2})日$/, toDate: (m) => safeDate(+m[1], +m[2], +m[3]) },
];

/** 明確に日付と分かる表記（YYYY/MM/DD, YYYY-MM-DD, YYYY年MM月DD日）だけを日付として認識する */
export function tryParseDateCell(text: string): Date | null {
  const t = text.trim();
  for (const { re, toDate } of DATE_PATTERNS) {
    const m = t.match(re);
    if (m) {
      const d = toDate(m);
      if (d) return d;
    }
  }
  return null;
}
