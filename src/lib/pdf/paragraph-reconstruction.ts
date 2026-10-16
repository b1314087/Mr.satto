import type { PositionedTextItem } from "./pdfjs-client";
import { groupIntoLines, reconstructTable, type Line, type ColumnSpanHint } from "./table-reconstruction";

/**
 * PDFの座標付きテキストから、Word文書として自然な段落構造を推定する
 * （Phase 2-D ■PDF→Word）。
 *
 * 目的は「PDFの見た目を完全に再現すること」ではなく、
 *   1. 文字を編集可能にする
 *   2. 段落構造を維持する
 *   3. 見出し・改行をできる範囲で維持する
 *   4. 簡単な表があれば維持する
 * という優先順位（開発指示書に明記）に沿って、実用的に編集しやすい
 * Word文書の元になるブロック列を組み立てることにある。
 *
 * 2段組・特殊フォント等、完全な再現が難しい要素は無理に再現しようとせず、
 * テキストの内容自体は失わないことを優先する
 * （段組みは検出せず、読み取り順（PDFの座標順）でそのまま連結する）。
 *
 * 【表の検出を先に行う理由】
 * 当初は「行間の広さで段落の切れ目を決め、できあがったブロックの中に
 * 表らしいものがあれば表として扱う」という1パス構成だったが、
 * 実際の帳票・表形式PDFでは行間（表の行の高さ）が本文の行間とほぼ同じか
 * それ以上になることがあり、段落分割の閾値で表の行同士が個別の
 * ブロックに分断されてしまい、表として認識できなくなる問題があった。
 * そのため、行間による段落分割を行う前に、まず「連続する行が表を
 * 構成できるか」を独立して判定し、表と判定できた区間を先に確定させる
 * 2段階構成にした。
 *
 * 【箇条書き・番号リストの扱い】
 * 行頭の記号（「・」「●」「1.」「(1)」「①」等）と、その後ろに続く1つながりの文章
 * という形の行は、表ではなくリスト項目として扱う。以前は、記号と本文の間の隙間を
 * 「2列の表」と誤認し、リストの内容が表の中に入ってしまっていた。
 * Wordの箇条書き記号が文字としてPDFに入らない場合（記号フォントの文字が
 * 空文字として入る）も、行頭の幅のある空文字を記号とみなして検出する。
 *
 * 【書式】
 * 文字ごとの太字・斜体・色・大きさ・リンクと、段落の中央/右揃え・字下げは、
 * 取得できた範囲で runs / align / indent に記録する（Word側で再現する）。
 */

export interface RunInfo {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** 文字サイズ(pt) */
  size?: number;
  /** 文字色("RRGGBB") */
  color?: string;
  serif?: boolean;
  mono?: boolean;
  link?: string;
}

export type BlockAlign = "left" | "center" | "right";

export interface HeadingBlock {
  type: "heading1" | "heading2";
  text: string;
  runs?: RunInfo[];
  align?: BlockAlign;
  /** 見出しの先頭行のy座標（画像の差し込み位置の判定用） */
  y?: number;
}
export interface ParagraphBlock {
  type: "paragraph";
  text: string;
  runs?: RunInfo[];
  align?: BlockAlign;
  /** 左の字下げ(pt) */
  indent?: number;
  /** 1行目だけの字下げ(pt) */
  firstLineIndent?: number;
  y?: number;
}
export interface ListItemBlock {
  type: "list";
  ordered: boolean;
  /** 入れ子の深さ(0〜3) */
  level: number;
  /** PDF上の行頭記号（「・」「1.」等。プレビュー表示用） */
  marker: string;
  text: string;
  runs?: RunInfo[];
  y?: number;
}
export interface TableBlock {
  type: "table";
  rows: string[][];
  /** 各列の幅(pt)。PDF上の列境界から求める（取れなければ省略） */
  colWidths?: number[];
  /** 列結合（複数列にまたがるセル）の推定 */
  spans?: ColumnSpanHint[];
  /** 表の文字の大きさ(pt) */
  fontSize?: number;
  y?: number;
}
export interface ImageBlock {
  type: "image";
  /** PNGのバイト列 */
  data: Uint8Array;
  /** Word上の表示サイズ(pt) */
  width: number;
  height: number;
  align?: BlockAlign;
  y?: number;
}
export type DocumentBlock = HeadingBlock | ParagraphBlock | ListItemBlock | TableBlock | ImageBlock;

export interface ReconstructOptions {
  /** 本文領域の左端・右端のx座標（複数ページ全体から求めた値。中央/右揃えの判定の基準） */
  contentLeft?: number;
  contentRight?: number;
}

/** 行間がこの倍率(本文行の高さ比)を超えたら段落の切れ目とみなす */
const PARAGRAPH_BREAK_RATIO = 1.6;
const HEADING1_RATIO = 1.6;
const HEADING2_RATIO = 1.2;
/** 見出しとして扱う最大文字数（長い本文が大きいフォントというだけで見出し扱いされるのを防ぐ） */
const HEADING_MAX_LENGTH = 60;
/** 表候補として1行に伸ばして試す最大行数（暴走防止の安全上限） */
const MAX_TABLE_RUN_LINES = 200;
/** 直前の行がこの割合より短く終わっていたら、そこで段落が終わったとみなす（本文領域の幅に対する割合） */
const SHORT_LINE_RATIO = 0.7;

const CJK_RE = /[　-ヿ㐀-鿿＀-￯]/;
const BULLET_RE = /^[•●○◦▪▫■□◆◇▶▷►‣⁃∙・-]$/;
const ORDERED_RE =
  /^(?:[(（]?\d{1,3}[)）.．、]|[①-⑳㉑-㉟]|[(（]?[a-zA-Z][)）.]|[(（]?(?:[ivxIVX]{1,4})[)）.])$/;
const FUSED_BULLET_RE = /^([•●○◦▪▫■□◆◇▶▷►‣⁃∙・-])\s*(\S.*)$/;
const FUSED_ORDERED_RE = /^((?:\d{1,3}[.．)）]|[(（]\d{1,3}[)）]|[①-⑳㉑-㉟]))\s*(\S.*)$/;

function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK_RE.test(ch);
}

function averageLineFontHeight(line: Line): number {
  if (line.items.length === 0) return 10;
  const total = line.items.reduce((sum, item) => sum + item.fontHeight, 0);
  return total / line.items.length;
}

/** 文字数で重み付けした中央値に近い値を「本文の標準フォントサイズ」の目安とする */
function estimateBodyFontHeight(lines: Line[]): number {
  const samples: number[] = [];
  for (const line of lines) {
    for (const item of line.items) {
      const weight = Math.max(1, item.str.trim().length);
      for (let i = 0; i < weight; i++) samples.push(item.fontHeight);
    }
  }
  if (samples.length === 0) return 10;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function lineLeft(line: Line): number {
  return Math.min(...line.items.map((i) => i.x));
}
function lineRight(line: Line): number {
  return Math.max(...line.items.map((i) => i.x + i.width));
}

// ---------------------------------------------------------------------------
// 前処理: 行頭の「文字に変換されなかった記号」(箇条書きの黒丸など)を「•」にする
// ---------------------------------------------------------------------------

/**
 * 箇条書きの黒丸などが記号フォントの文字で、テキストとしては空文字(幅だけある)になる
 * PDFがある。行の一番左にある「幅のある空文字」を、箇条書きの記号「•」とみなす。
 */
function markUnmappedBullets(items: PositionedTextItem[]): PositionedTextItem[] {
  const result = items.map((i) => ({ ...i }));
  for (const item of result) {
    if (item.str !== "" || item.width < item.fontHeight * 0.25) continue;
    const tol = Math.max(2, item.fontHeight * 0.4);
    const sameLine = result.filter((o) => o !== item && Math.abs(o.y - item.y) <= tol);
    const hasTextRight = sameLine.some((o) => o.str.trim() !== "" && o.x >= item.x + item.width - 1);
    const hasTextLeft = sameLine.some((o) => o.str.trim() !== "" && o.x < item.x - 1);
    const hasOtherBullet = sameLine.some((o) => o.str === "" && o.width > 0 && o.x < item.x - 0.5);
    // 行の一番左側にあること（同じ位置に複数の記号用の空文字が重なる場合は、最も左のものだけ）
    if (hasTextRight && !hasTextLeft && !hasOtherBullet) item.str = "•";
  }
  return result;
}

// ---------------------------------------------------------------------------
// 文字列・書式つきの「ラン」の組み立て
// ---------------------------------------------------------------------------

function styleOf(item: PositionedTextItem): Omit<RunInfo, "text"> {
  const style: Omit<RunInfo, "text"> = { size: Math.round(item.fontHeight * 2) / 2 };
  if (item.bold) style.bold = true;
  if (item.italic) style.italic = true;
  if (item.color) style.color = item.color;
  if (item.serif) style.serif = true;
  if (item.mono) style.mono = true;
  if (item.link) style.link = item.link;
  return style;
}

function sameStyle(a: Omit<RunInfo, "text">, b: Omit<RunInfo, "text">): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.size === b.size &&
    a.color === b.color &&
    a.serif === b.serif &&
    a.mono === b.mono &&
    a.link === b.link
  );
}

function pushPiece(runs: RunInfo[], text: string, style: Omit<RunInfo, "text">) {
  if (text === "") return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, style)) {
    last.text += text;
  } else {
    runs.push({ text, ...style });
  }
}

/** 1行分の項目を、隙間の広さをもとに文字列（書式つきラン）へつなぐ */
function lineRuns(items: PositionedTextItem[]): RunInfo[] {
  const runs: RunInfo[] = [];
  let prev: PositionedTextItem | null = null;
  for (const item of items) {
    const text = item.str.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    const style = styleOf(item);
    if (prev) {
      const prevText = prev.str.trim();
      const gap = item.x - (prev.x + prev.width);
      const nearCjk = isCjk(prevText[prevText.length - 1]) || isCjk(text[0]);
      // 「1.」「(2)」のような番号のあとは、日本語が続いても空白を入れる
      const afterNumber = /[0-9][.)）．]$/.test(prevText) && gap > prev.fontHeight * 0.05;
      const needSpace = gap > prev.fontHeight * 0.6 || afterNumber || (gap > prev.fontHeight * 0.18 && !nearCjk);
      if (needSpace) {
        // 空白は前の項目の書式に含める（空白だけの別のランを作らない）
        const last = runs[runs.length - 1];
        if (last) last.text += " ";
      }
    }
    pushPiece(runs, text, style);
    prev = item;
  }
  return runs;
}

/** 複数行の文章を、行の継ぎ目の空白（日本語の途中では入れない）に注意しながら1つにつなぐ */
function joinLines(lines: Line[]): RunInfo[] {
  const runs: RunInfo[] = [];
  for (const line of lines) {
    const lr = lineRuns(line.items);
    if (lr.length === 0) continue;
    const last = runs[runs.length - 1];
    if (last) {
      const prevChar = last.text[last.text.length - 1];
      const nextChar = lr[0].text[0];
      if (!isCjk(prevChar) && !isCjk(nextChar) && prevChar !== " ") last.text += " ";
    }
    for (const r of lr) {
      const { text, ...style } = r;
      pushPiece(runs, text, style);
    }
  }
  return runs;
}

function runsText(runs: RunInfo[]): string {
  return runs
    .map((r) => r.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// リスト
// ---------------------------------------------------------------------------

interface ListLineInfo {
  ordered: boolean;
  marker: string;
  markerX: number;
  /** 本文の開始x座標（折り返した行の揃え位置の判定に使う） */
  textX: number;
  rest: PositionedTextItem[];
}

function parseListLine(line: Line, bodyFontHeight: number): ListLineInfo | null {
  const items = line.items;
  if (items.length === 0) return null;
  // 見出し(大きい文字)の行頭の「1.」は箇条書きではなく見出しの番号
  if (averageLineFontHeight(line) >= bodyFontHeight * HEADING2_RATIO) return null;

  const first = items[0];
  const firstText = first.str.trim();
  const fh = first.fontHeight;
  let ordered = false;
  let marker = "";
  let rest: PositionedTextItem[] | null = null;

  if (items.length >= 2 && BULLET_RE.test(firstText)) {
    marker = firstText;
    rest = items.slice(1);
  } else if (items.length >= 2 && ORDERED_RE.test(firstText)) {
    ordered = true;
    marker = firstText;
    rest = items.slice(1);
  } else {
    // 記号と本文が同じ項目に入っている場合（「• 項目A」「1. 手順」）
    const mb = FUSED_BULLET_RE.exec(first.str.trim());
    const mo = mb ? null : FUSED_ORDERED_RE.exec(first.str.trim());
    const m = mb ?? mo;
    if (m) {
      ordered = !mb;
      marker = m[1];
      const total = first.str.trim().length || 1;
      const offset = (first.width * (total - m[2].length)) / total;
      rest = [{ ...first, str: m[2], x: first.x + offset, width: Math.max(0, first.width - offset) }, ...items.slice(1)];
    }
  }
  if (!rest || rest.length === 0) return null;

  // 記号と本文の間が離れすぎていない（表の列の間の隙間ではない）こと
  const markerEnd = marker === first.str.trim() ? first.x + first.width : rest[0].x - 1;
  const startGap = rest[0].x - markerEnd;
  if (startGap > fh * 3) return null;
  // 本文が1つながり（途中に表の列のような大きな隙間がない）であること
  for (let k = 1; k < rest.length; k++) {
    const gap = rest[k].x - (rest[k - 1].x + rest[k - 1].width);
    if (gap > fh * 1.5) return null;
  }
  if (rest.every((r) => r.str.trim() === "")) return null;
  return { ordered, marker, markerX: first.x, textX: rest[0].x, rest };
}

/** lines[start]から始まるリスト（項目と、折り返された続きの行）を読み取る */
function readList(
  lines: Line[],
  start: number,
  bodyFontHeight: number
): { blocks: ListItemBlock[]; lineCount: number } {
  const blocks: ListItemBlock[] = [];
  const entries: { info: ListLineInfo; lines: Line[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const info = parseListLine(lines[i], bodyFontHeight);
    if (info) {
      entries.push({ info, lines: [{ y: lines[i].y, items: info.rest }] });
      i++;
      continue;
    }
    // 折り返した続きの行: 直前の項目の本文位置以降から始まり、行間が詰まっている
    const cur = entries[entries.length - 1];
    if (!cur) break;
    const prevLine = cur.lines[cur.lines.length - 1];
    const gap = prevLine.y - lines[i].y;
    const fh = averageLineFontHeight(prevLine);
    if (lines[i].items.length > 0 && lineLeft(lines[i]) >= cur.info.textX - 2 && gap <= fh * PARAGRAPH_BREAK_RATIO) {
      cur.lines.push(lines[i]);
      i++;
      continue;
    }
    break;
  }

  const baseX = Math.min(...entries.map((e) => e.info.markerX));
  for (const e of entries) {
    const unit = Math.max(8, bodyFontHeight * 1.2);
    const level = Math.max(0, Math.min(3, Math.round((e.info.markerX - baseX) / unit)));
    const runs = joinLines(e.lines);
    blocks.push({
      type: "list",
      ordered: e.info.ordered,
      level,
      marker: e.info.marker,
      text: runsText(runs),
      runs,
      y: e.lines[0].y,
    });
  }
  return { blocks, lineCount: i - start };
}

// ---------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------

/**
 * 行の中に、列の区切りとみなせる隙間（文字の高さの0.3倍より広い）が1つ以上あるか。
 * 「図 1: 画像キャプション」のように、隙間が小さい項目の並び（実際は1つながりの文章）は
 * 表の行ではない。
 */
function hasWideGap(line: Line): boolean {
  for (let k = 1; k < line.items.length; k++) {
    const prev = line.items[k - 1];
    const gap = line.items[k].x - (prev.x + prev.width);
    if (gap > Math.max(prev.fontHeight, line.items[k].fontHeight) * 0.3) return true;
  }
  return false;
}

/**
 * 各列の幅(pt)を、列の文字の左端の位置から求める。
 * 列の境界線の位置は推定値のため、最後の列が細くなりやすい。左端の間隔なら安定して取れる
 * （最後の列は、本文領域の右端または文字の右端までの広いほうとする）。
 */
function columnWidthsOf(
  table: ReturnType<typeof reconstructTable>,
  items: PositionedTextItem[],
  boxRight: number
): number[] | undefined {
  const lefts = table.columnInfo.map((c) => c.left);
  if (lefts.length !== table.columnCount || lefts.some((l) => !Number.isFinite(l))) return undefined;
  for (let i = 1; i < lefts.length; i++) if (lefts[i] <= lefts[i - 1]) return undefined;
  const maxRight = Math.max(...items.map((i) => i.x + i.width));
  const widths = lefts.map((l, i) => (i < lefts.length - 1 ? lefts[i + 1] - l : Math.max(boxRight, maxRight) - l));
  return widths.every((w) => w > 4) ? widths : undefined;
}

/**
 * lines[startIndex] から始まる、表として成立する最大の連続行数を探す。
 * 各行が2項目以上を持ち、かつ座標ベースの表構造推定（reconstructTable、
 * PDF→Excelと共通）で2列以上・行数が一致する結果が得られる間、
 * 貪欲に行を伸ばしていく。2行未満でしか成立しない場合はnullを返す
 * （表ではなく通常の段落として扱う）。
 * リスト項目の行・見出しの行は表に含めない。
 */
function tryExtendTableRun(
  lines: Line[],
  startIndex: number,
  bodyFontHeight: number,
  boxRight: number
): { block: TableBlock; lineCount: number } | null {
  const canBeTableLine = (line: Line) =>
    line.items.length >= 2 &&
    averageLineFontHeight(line) < bodyFontHeight * HEADING2_RATIO &&
    hasWideGap(line) &&
    !parseListLine(line, bodyFontHeight);

  if (!canBeTableLine(lines[startIndex])) return null;

  let best: { block: TableBlock; lineCount: number } | null = null;
  const maxWindow = Math.min(lines.length - startIndex, MAX_TABLE_RUN_LINES);

  for (let windowSize = 2; windowSize <= maxWindow; windowSize++) {
    const windowLines = lines.slice(startIndex, startIndex + windowSize);
    if (!canBeTableLine(windowLines[windowLines.length - 1])) break;

    const items = windowLines.flatMap((l) => l.items);
    const table = reconstructTable(items);
    if (table.columnCount >= 2 && table.rows.length === windowLines.length) {
      // 行を足したら列数が減る（＝その行は表の行ではなかった）場合は、そこで打ち切る
      if (best && best.block.rows[0].length > table.columnCount) break;
      const widths = columnWidthsOf(table, items, boxRight);
      best = {
        block: {
          type: "table",
          rows: table.rows,
          colWidths: widths,
          spans: table.columnSpans.length > 0 ? table.columnSpans : undefined,
          fontSize: Math.round((windowLines.reduce((sum, l) => sum + averageLineFontHeight(l), 0) / windowLines.length) * 2) / 2,
          y: windowLines[0].y,
        },
        lineCount: windowSize,
      };
    } else {
      break;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 段落・見出し
// ---------------------------------------------------------------------------

interface AlignInfo {
  align: BlockAlign;
  /** 左の字下げ(pt)。中央・右揃えのときは0 */
  indent: number;
}

function alignOf(line: Line, box: { left: number; right: number }, bodyFontHeight: number): AlignInfo {
  const left = lineLeft(line);
  const right = lineRight(line);
  const width = right - left;
  const boxWidth = box.right - box.left;
  if (boxWidth <= bodyFontHeight * 8 || width >= boxWidth * 0.9) return { align: "left", indent: 0 };
  const leftOff = left - box.left;
  const rightOff = box.right - right;
  const tol = Math.max(4, bodyFontHeight * 0.5);
  if (Math.abs(leftOff - rightOff) <= tol && leftOff > bodyFontHeight * 2) return { align: "center", indent: 0 };
  if (rightOff <= tol && leftOff > bodyFontHeight * 3) return { align: "right", indent: 0 };
  return { align: "left", indent: leftOff >= bodyFontHeight * 1.5 ? leftOff : 0 };
}

/** 表ではない行の連続区間を、行間の広さ・位置に基づいて見出し／段落へ組み立てる */
function buildParagraphBlocks(
  lines: Line[],
  bodyFontHeight: number,
  box: { left: number; right: number }
): DocumentBlock[] {
  if (lines.length === 0) return [];

  const groups: Line[][] = [];
  const aligns = new Map<Line, AlignInfo>();
  let current: Line[] = [];
  let prevLine: Line | null = null;
  const boxWidth = box.right - box.left;

  for (const line of lines) {
    const info = alignOf(line, box, bodyFontHeight);
    aligns.set(line, info);
    if (prevLine) {
      const gap = prevLine.y - line.y; // ページ座標はy上方向が正のため、上から下へ進むとyは減少する
      const refHeight = averageLineFontHeight(prevLine);
      const prevInfo = aligns.get(prevLine)!;
      const alignChanged = prevInfo.align !== info.align;
      // 直前の行が本文領域の途中で終わっている（改行で終わった段落・宛名などの短い行）
      const prevShort =
        boxWidth > bodyFontHeight * 20 &&
        prevInfo.align === "left" &&
        lineRight(prevLine) < box.left + boxWidth * SHORT_LINE_RATIO;
      if (gap > refHeight * PARAGRAPH_BREAK_RATIO || alignChanged || prevShort) {
        if (current.length > 0) groups.push(current);
        current = [];
      }
    }
    current.push(line);
    prevLine = line;
  }
  if (current.length > 0) groups.push(current);

  const result: DocumentBlock[] = [];
  for (const group of groups) {
    const runs = joinLines(group);
    const text = runsText(runs);
    if (text === "") continue;
    const first = aligns.get(group[0])!;
    const y = group[0].y;

    if (group.length === 1) {
      const ratio = averageLineFontHeight(group[0]) / bodyFontHeight;
      if (text.length <= HEADING_MAX_LENGTH && ratio >= HEADING1_RATIO) {
        result.push({ type: "heading1", text, runs, align: first.align, y });
        continue;
      }
      if (text.length <= HEADING_MAX_LENGTH && ratio >= HEADING2_RATIO) {
        result.push({ type: "heading2", text, runs, align: first.align, y });
        continue;
      }
    }

    // 字下げ: 全行が同じだけ下がっていれば左の字下げ、1行目だけなら1行目の字下げ
    const block: ParagraphBlock = { type: "paragraph", text, runs, y };
    if (first.align !== "left") block.align = first.align;
    if (first.align === "left") {
      const rest = group.slice(1).map((l) => aligns.get(l)!.indent);
      if (first.indent > 0 && rest.every((r) => Math.abs(r - first.indent) <= bodyFontHeight * 0.5)) {
        block.indent = first.indent;
      } else if (first.indent > 0 && rest.length > 0 && rest.every((r) => r === 0)) {
        block.firstLineIndent = first.indent;
      } else if (first.indent > 0 && rest.length === 0) {
        block.indent = first.indent;
      }
    }
    result.push(block);
  }
  return result;
}

/**
 * 1ページ分の座標付きテキストから、Word文書のブロック列（見出し／段落／リスト／表）を推定する。
 * PDF→Excelの reconstructTable と同じ「座標に基づく推定であり、100%の再現を
 * 保証しない」という前提に立つ。
 */
export function reconstructParagraphs(items: PositionedTextItem[], options: ReconstructOptions = {}): DocumentBlock[] {
  const lines = groupIntoLines(markUnmappedBullets(items));
  if (lines.length === 0) return [];

  const bodyFontHeight = estimateBodyFontHeight(lines);
  const box = {
    left: options.contentLeft ?? Math.min(...lines.map(lineLeft)),
    right: options.contentRight ?? Math.max(...lines.map(lineRight)),
  };
  const result: DocumentBlock[] = [];
  let paragraphBuffer: Line[] = [];

  const flushParagraphBuffer = () => {
    result.push(...buildParagraphBlocks(paragraphBuffer, bodyFontHeight, box));
    paragraphBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (parseListLine(lines[i], bodyFontHeight)) {
      flushParagraphBuffer();
      const list = readList(lines, i, bodyFontHeight);
      result.push(...list.blocks);
      i += Math.max(1, list.lineCount);
      continue;
    }
    const tableRun = tryExtendTableRun(lines, i, bodyFontHeight, box.right);
    if (tableRun) {
      flushParagraphBuffer();
      result.push(tableRun.block);
      i += tableRun.lineCount;
    } else {
      paragraphBuffer.push(lines[i]);
      i += 1;
    }
  }
  flushParagraphBuffer();

  return result;
}

/** ページ内のテキストが占める左端・右端（複数ページから本文領域を求めるために使う） */
export function textExtent(items: PositionedTextItem[]): { left: number; right: number } | null {
  const meaningful = items.filter((i) => i.str.trim() !== "");
  if (meaningful.length === 0) return null;
  return {
    left: Math.min(...meaningful.map((i) => i.x)),
    right: Math.max(...meaningful.map((i) => i.x + i.width)),
  };
}
