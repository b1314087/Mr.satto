import type { PositionedTextItem } from "./pdfjs-client";
import { groupIntoLines, reconstructTable, type Line } from "./table-reconstruction";

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
 * 2段組・ヘッダー/フッター・特殊フォント等、完全な再現が難しい要素は
 * 無理に再現しようとせず、テキストの内容自体は失わないことを優先する
 * （段組みは検出せず、読み取り順（PDFの座標順）でそのまま連結する）。
 * 画像の抽出・埋め込みは今回のスコープ外とする（優先順位表で最下位のため）。
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
 */

export interface HeadingBlock {
  type: "heading1" | "heading2";
  text: string;
}
export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}
export interface TableBlock {
  type: "table";
  rows: string[][];
}
export type DocumentBlock = HeadingBlock | ParagraphBlock | TableBlock;

/** 行間がこの倍率(本文行の高さ比)を超えたら段落の切れ目とみなす */
const PARAGRAPH_BREAK_RATIO = 1.6;
const HEADING1_RATIO = 1.6;
const HEADING2_RATIO = 1.2;
/** 見出しとして扱う最大文字数（長い本文が大きいフォントというだけで見出し扱いされるのを防ぐ） */
const HEADING_MAX_LENGTH = 60;
/** 表候補として1行に伸ばして試す最大行数（暴走防止の安全上限） */
const MAX_TABLE_RUN_LINES = 200;

function lineText(line: Line): string {
  return line.items
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * lines[startIndex] から始まる、表として成立する最大の連続行数を探す。
 * 各行が2項目以上を持ち、かつ座標ベースの表構造推定（reconstructTable、
 * PDF→Excelと共通）で2列以上・行数が一致する結果が得られる間、
 * 貪欲に行を伸ばしていく。2行未満でしか成立しない場合はnullを返す
 * （表ではなく通常の段落として扱う）。
 */
function tryExtendTableRun(
  lines: Line[],
  startIndex: number
): { rows: string[][]; lineCount: number } | null {
  if (lines[startIndex].items.length < 2) return null;

  let best: { rows: string[][]; lineCount: number } | null = null;
  const maxWindow = Math.min(lines.length - startIndex, MAX_TABLE_RUN_LINES);

  for (let windowSize = 2; windowSize <= maxWindow; windowSize++) {
    const windowLines = lines.slice(startIndex, startIndex + windowSize);
    if (windowLines[windowLines.length - 1].items.length < 2) break;

    const items = windowLines.flatMap((l) => l.items);
    const table = reconstructTable(items);
    if (table.columnCount >= 2 && table.rows.length === windowLines.length) {
      best = { rows: table.rows, lineCount: windowSize };
    } else {
      break;
    }
  }
  return best;
}

/** 表ではない行の連続区間を、行間の広さに基づいて見出し／段落へ組み立てる */
function buildParagraphBlocks(lines: Line[], bodyFontHeight: number): DocumentBlock[] {
  if (lines.length === 0) return [];

  const groups: Line[][] = [];
  let current: Line[] = [];
  let prevLine: Line | null = null;

  for (const line of lines) {
    if (prevLine) {
      const gap = prevLine.y - line.y; // ページ座標はy上方向が正のため、上から下へ進むとyは減少する
      const refHeight = averageLineFontHeight(prevLine);
      if (gap > refHeight * PARAGRAPH_BREAK_RATIO) {
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
    if (group.length === 1) {
      const text = lineText(group[0]);
      if (text === "") continue;
      const ratio = averageLineFontHeight(group[0]) / bodyFontHeight;
      if (text.length <= HEADING_MAX_LENGTH && ratio >= HEADING1_RATIO) {
        result.push({ type: "heading1", text });
      } else if (text.length <= HEADING_MAX_LENGTH && ratio >= HEADING2_RATIO) {
        result.push({ type: "heading2", text });
      } else {
        result.push({ type: "paragraph", text });
      }
      continue;
    }

    const text = group
      .map(lineText)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") {
      result.push({ type: "paragraph", text });
    }
  }
  return result;
}

/**
 * 1ページ分の座標付きテキストから、Word文書のブロック列（見出し／段落／表）を推定する。
 * PDF→Excelの reconstructTable と同じ「座標に基づく推定であり、100%の再現を
 * 保証しない」という前提に立つ。
 */
export function reconstructParagraphs(items: PositionedTextItem[]): DocumentBlock[] {
  const lines = groupIntoLines(items);
  if (lines.length === 0) return [];

  const bodyFontHeight = estimateBodyFontHeight(lines);
  const result: DocumentBlock[] = [];
  let paragraphBuffer: Line[] = [];

  const flushParagraphBuffer = () => {
    result.push(...buildParagraphBlocks(paragraphBuffer, bodyFontHeight));
    paragraphBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const tableRun = tryExtendTableRun(lines, i);
    if (tableRun) {
      flushParagraphBuffer();
      result.push({ type: "table", rows: tableRun.rows });
      i += tableRun.lineCount;
    } else {
      paragraphBuffer.push(lines[i]);
      i += 1;
    }
  }
  flushParagraphBuffer();

  return result;
}
