import type { PositionedTextItem } from "./pdfjs-client";
import { groupIntoLines } from "./table-reconstruction";

/**
 * PDFの各ページの上下の余白にある「ページ番号」や「毎ページ繰り返される見出し(ヘッダー/フッター)」を
 * 表のデータから取り除く。Excelに変換すると、表のデータの途中や末尾に
 * 「38」「[令和8年勧告]」のような1行が混ざってしまい、並べ替えや集計の邪魔になるため。
 *
 * 誤って表の中身を消さないよう、次の条件をすべて満たす行だけを対象にする:
 * - ページの上端・下端の約7%の範囲にある
 * - 1行の項目が4個以下で、短い(40文字以内)
 * - ページ番号の書式(「38」「- 38 -」「38/60」「P.38」「38ページ」)であるか、
 *   数字を無視して同じ内容の行が別のページの同じ範囲にも現れる
 * - 表の内容(見出し行・数値の列)ではなく、隣の行との間に行間以上の空きがある孤立した行である
 */

const REGION_RATIO = 0.07;
const MAX_ITEMS_PER_LINE = 4;
const MAX_TEXT_LENGTH = 40;

export interface PageFurnitureInput {
  items: PositionedTextItem[];
  /** ページの高さ・下端のy座標(PDFのページ座標系) */
  pageHeight: number;
  pageBottom: number;
}

export interface PageFurnitureResult {
  items: PositionedTextItem[];
  /** 取り除いた行の数 */
  removedLines: number;
}

/** 数字(全角を含む)を「#」にそろえ、空白を除いた比較用の文字列にする */
function normalizeLineText(items: PositionedTextItem[]): string {
  return items
    .map((i) => i.str)
    .join("")
    .replace(/[0-9０-９]/g, "#")
    .replace(/\s+/g, "");
}

const PAGE_NUMBER_RE = /^[-‐‑–—―ー]*(p\.?|page|ページ|第)?#{1,4}(\/#{1,4}|ページ|頁)?[-‐‑–—―ー]*$/i;

function isPageNumberText(normalized: string): boolean {
  return PAGE_NUMBER_RE.test(normalized);
}

interface CandidateLine {
  page: number;
  items: PositionedTextItem[];
  normalized: string;
  region: "top" | "bottom";
  /** 内容の側(ページの中央側)の隣の行との間隔 */
  gapToContent: number;
  fontHeight: number;
}

export function removePageFurniture(pages: PageFurnitureInput[]): PageFurnitureResult[] {
  const candidates: CandidateLine[] = [];

  pages.forEach((page, pageIndex) => {
    const lines = groupIntoLines(page.items);
    lines.forEach((line, i) => {
      if (line.items.length > MAX_ITEMS_PER_LINE) return;
      const normalized = normalizeLineText(line.items);
      if (normalized === "" || normalized.length > MAX_TEXT_LENGTH) return;
      const fromBottom = line.y - page.pageBottom;
      const region =
        fromBottom >= page.pageHeight * (1 - REGION_RATIO)
          ? "top"
          : fromBottom <= page.pageHeight * REGION_RATIO
            ? "bottom"
            : null;
      if (!region) return;
      // lines は上から下の順。上端の行の「内容の側」は次の行、下端の行は前の行
      const neighbor = region === "top" ? lines[i + 1] : lines[i - 1];
      const gapToContent = neighbor ? Math.abs(neighbor.y - line.y) : Infinity;
      const fontHeight = Math.max(...line.items.map((it) => it.fontHeight));
      candidates.push({ page: pageIndex, items: line.items, normalized, region, gapToContent, fontHeight });
    });
  });

  // 数字を無視して同じ内容の行が、何ページに現れるか
  const pagesByText = new Map<string, Set<number>>();
  for (const c of candidates) {
    const key = `${c.region}:${c.normalized}`;
    const set = pagesByText.get(key) ?? new Set<number>();
    set.add(c.page);
    pagesByText.set(key, set);
  }

  const removedByPage = pages.map(() => new Set<PositionedTextItem>());
  const removedLineCount = pages.map(() => 0);
  for (const c of candidates) {
    const isNumber = isPageNumberText(c.normalized);
    const repeated = (pagesByText.get(`${c.region}:${c.normalized}`)?.size ?? 0) >= 2;
    // 表の見出し行・数値だけが縦に並ぶ表の行を消さないよう、どちらの場合も
    // 「内容との間に行間以上の空きがある、孤立した行」だけを対象にする
    const separated = c.gapToContent >= c.fontHeight * 1.5;
    const hasLetters = /[^#\-‐‑–—―ー\/.\s]/.test(c.normalized);
    if (separated && (isNumber || (repeated && hasLetters))) {
      c.items.forEach((it) => removedByPage[c.page].add(it));
      removedLineCount[c.page]++;
    }
  }

  return pages.map((page, i) => ({
    items: removedByPage[i].size > 0 ? page.items.filter((it) => !removedByPage[i].has(it)) : page.items,
    removedLines: removedLineCount[i],
  }));
}
