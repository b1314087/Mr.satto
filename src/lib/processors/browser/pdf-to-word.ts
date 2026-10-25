import { BrowserProcessor } from "../types";
import {
  loadPdfDocument,
  getPositionedTextItems,
  pageHasText,
  renderPageToCanvas,
  type PositionedTextItem,
} from "@/lib/pdf/pdfjs-client";
import {
  reconstructParagraphs,
  textExtent,
  type DocumentBlock,
  type ImageBlock,
} from "@/lib/pdf/paragraph-reconstruction";
import { applyPageStyles, type ExtractedImage } from "@/lib/pdf/pdf-style-sampling";
import { removePageFurniture } from "@/lib/pdf/page-furniture";
import { PDF_TO_WORD_MAX_PAGES } from "@/lib/pdf/page-limits";
import { groupIntoLines } from "@/lib/pdf/table-reconstruction";
import { buildDocxBlob, type DocxPageSetup } from "./pdf-to-word-docx";
import { recognizeImageWithWords, ocrWordsToPositionedTextItems, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";

/**
 * PDF→Word Processor（Phase 2-D、外出先PC修正指示書§27-28でスキャンPDF対応を追加）。
 *
 * 目標は「PDFの見た目を100%再現すること」ではなく、
 * 「編集しやすいWord文書に変換すること」（開発指示書に明記された優先順位）。
 * 2段組・特殊フォント等、完全な再現が難しい要素は無理をして再現しない。
 * 一方で、編集時に困りやすい次の要素は取り出してWordへ反映する:
 *   - 太字・斜体・文字色・文字サイズ・明朝/ゴシック・ハイパーリンク（pdf-style-sampling.ts）
 *   - 中央/右揃え・字下げ、箇条書き・番号リスト、表の列幅と列結合（paragraph-reconstruction.ts）
 *   - 毎ページ繰り返されるヘッダー/フッター・ページ番号（本文に混ぜず、Wordのヘッダー/フッターへ）
 *   - 画像（ページ全面の背景画像を除く）
 *   - 用紙サイズ・向き・余白（元のPDFに合わせる）
 *
 * DOCX生成には `docx` パッケージを利用する（pdf-to-word-docx.ts）。
 *
 * スキャンPDF対応（§27-28）: 以前は文字レイヤーが無いページ（紙をスキャンした
 * 画像PDF）に遭遇すると、そのページに限らずファイル全体を「未対応」として
 * エラーにしていた。記入済みPDF→Excel(filled-pdf-to-excel.ts)が既に確立している
 * 「ページに文字レイヤーが無ければ画像化してOCRし、単語のbounding boxを
 * table-reconstruction.ts / paragraph-reconstruction.tsが期待する
 * PositionedTextItem形状へ変換して、以後は文字レイヤーのページと全く同じ
 * 座標ベースの構造推定ロジックに渡す」というアーキテクチャをそのまま再利用し、
 * ページ単位で「文字レイヤーがあればそれを使い、無ければOCRする」判定に変更した
 * （新しいOCRエンジン・新しい構造推定ロジックは追加せず、既存基盤の組み合わせのみ）。
 */

const MAX_PDF_TO_WORD_PAGES = PDF_TO_WORD_MAX_PAGES;
/** OCR用に描画するページ画像の解像度。filled-pdf-to-excel.tsと同じ値を踏襲する */
const PDF_RENDER_SCALE = 2;
const MAX_OCR_DIMENSION = 2000;
/** 余白として扱う範囲(pt) */
const MIN_MARGIN_PT = 36;
const MAX_MARGIN_PT = 150;
const MAX_TOTAL_IMAGES = 60;

export interface PdfToWordInput {
  file: File;
  /** スキャンPDF（文字レイヤーの無いページ）を検出した場合にOCRする言語。省略時は"ja+en"。 */
  ocrLanguage?: OcrLanguageOption;
  onPageProgress?: (info: { currentPage: number; totalPages: number; method?: "text-layer" | "ocr"; ocrProgress?: number }) => void;
}

export interface PdfToWordOutput {
  blob: Blob;
  sizeBytes: number;
  pageCount: number;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
  /** Wordへ入れた画像の数 */
  imageCount: number;
  /** 箇条書き・番号リストの項目数 */
  listItemCount: number;
  /** OCR（スキャンPDFページ）を1ページでも使用したか */
  usedOcr: boolean;
  /** OCRしたページの平均信頼度(0〜100)。OCRを使わなかった場合はnull */
  ocrConfidence: number | null;
}

interface PageData {
  pageNumber: number;
  items: PositionedTextItem[];
  /** 文字レイヤーのページか（falseならOCR） */
  fromTextLayer: boolean;
  images: ExtractedImage[];
  view: number[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const PAGE_NUMBER_TEXT_RE = /^[-‐‑–—―ー\s]*(p\.?|page|ページ|第)?\s*[0-9０-９]{1,4}\s*(\/\s*[0-9０-９]{1,4}|ページ|頁)?[-‐‑–—―ー\s]*$/i;

/** 取り除かれた上下端の行から、Wordのヘッダー・フッターに入れる文字とページ番号の有無を求める */
function summarizeFurniture(
  pages: PageData[],
  filtered: PositionedTextItem[][]
): { headerText?: string; footerText?: string; pageNumber: boolean } {
  let headerText: string | undefined;
  let footerText: string | undefined;
  let pageNumber = false;
  pages.forEach((page, i) => {
    if (!page.fromTextLayer) return;
    const kept = new Set(filtered[i]);
    const removed = page.items.filter((it) => !kept.has(it));
    if (removed.length === 0) return;
    const pageHeight = page.view[3] - page.view[1];
    for (const line of groupIntoLines(removed)) {
      const text = line.items
        .map((it) => it.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text === "") continue;
      if (PAGE_NUMBER_TEXT_RE.test(text)) {
        pageNumber = true;
        continue;
      }
      const isTop = line.y - page.view[1] >= pageHeight / 2;
      if (isTop) headerText = headerText ?? text;
      else footerText = footerText ?? text;
    }
  });
  return { headerText, footerText, pageNumber };
}

export class PdfToWordProcessor extends BrowserProcessor<PdfToWordInput, PdfToWordOutput> {
  async process({ file, ocrLanguage, onPageProgress }: PdfToWordInput): Promise<PdfToWordOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    const pdf = await loadPdfDocument(file);
    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    if (pdf.numPages > MAX_PDF_TO_WORD_PAGES) {
      throw new Error(
        `変換できるページ数の上限は${MAX_PDF_TO_WORD_PAGES}ページです（このPDFは${pdf.numPages}ページあります）。ページ数を減らしてから再度お試しください。`
      );
    }

    const pages: PageData[] = [];
    let anyTextFound = false;
    let usedOcr = false;
    let totalImages = 0;
    const ocrConfidences: number[] = [];
    const language = ocrLanguage ?? "ja+en";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
      }

      const textItems = await getPositionedTextItems(page);
      const view = page.view as number[];

      if (pageHasText(textItems)) {
        onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "text-layer" });
        anyTextFound = true;
        // 書式（太字・斜体・色・リンク）と画像を取り出す。失敗しても文字の変換は続ける
        let images: ExtractedImage[] = [];
        try {
          images = await applyPageStyles(page, textItems, { withRender: true, withImages: totalImages < MAX_TOTAL_IMAGES });
        } catch {
          images = [];
        }
        totalImages += images.length;
        pages.push({ pageNumber, items: textItems, fromTextLayer: true, images, view });
      } else {
        // 文字レイヤーの無いページ（紙をスキャンした画像PDF等）は、
        // filled-pdf-to-excel.tsと同じ方式でページを画像化してOCRする(§27-28)。
        usedOcr = true;
        onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "ocr", ocrProgress: 0 });
        let canvas: HTMLCanvasElement;
        try {
          const rendered = await renderPageToCanvas(page, PDF_RENDER_SCALE, MAX_OCR_DIMENSION);
          canvas = rendered.canvas;
        } catch {
          throw new Error(`${pageNumber}ページ目の画像化に失敗しました`);
        }
        const result = await recognizeImageWithWords(canvas, language, (p) => {
          onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "ocr", ocrProgress: p.progress });
        });
        ocrConfidences.push(result.confidence);
        if (result.words.some((w) => w.text.trim() !== "")) anyTextFound = true;
        pages.push({
          pageNumber,
          items: ocrWordsToPositionedTextItems(result.words),
          fromTextLayer: false,
          images: [],
          view,
        });
      }
    }

    if (!anyTextFound) {
      throw new Error(
        usedOcr
          ? "このPDFから文字を読み取れませんでした。スキャン画像の解像度が低いか、手書き文字の可能性があります。"
          : "このPDFから文字情報を抽出できませんでした。"
      );
    }

    // 毎ページ繰り返されるヘッダー・フッター・ページ番号は、本文に混ぜずWordのヘッダー/フッターへ移す
    const textPages = pages.filter((p) => p.fromTextLayer);
    const furniture = removePageFurniture(
      textPages.map((p) => ({ items: p.items, pageHeight: p.view[3] - p.view[1], pageBottom: p.view[1] }))
    );
    const filteredByPage: PositionedTextItem[][] = pages.map((p) => p.items);
    textPages.forEach((p, i) => {
      filteredByPage[pages.indexOf(p)] = furniture[i].items;
    });
    const { headerText, footerText, pageNumber } = summarizeFurniture(pages, filteredByPage);

    // 本文領域の左右の端（中央/右揃え・字下げの判定の基準）と、余白
    const extents = textPages
      .map((p) => textExtent(filteredByPage[pages.indexOf(p)]))
      .filter((e): e is { left: number; right: number } => e !== null);
    const contentLeft = extents.length > 0 ? Math.min(...extents.map((e) => e.left)) : undefined;
    const contentRight = extents.length > 0 ? Math.max(...extents.map((e) => e.right)) : undefined;

    const allBlocks: DocumentBlock[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const blocks = reconstructParagraphs(
        filteredByPage[i],
        p.fromTextLayer ? { contentLeft, contentRight } : {}
      );
      const withImages = insertImages(blocks, p.images, p.view, contentLeft, contentRight);
      if (i > 0 && withImages.length > 0 && allBlocks.length > 0) {
        // ページの区切りが分かるよう、空段落を1つはさむ（見た目の再現よりも
        // 読みやすさ・編集しやすさを優先する方針のため、明示的な改ページは入れない）
        allBlocks.push({ type: "paragraph", text: "" });
      }
      allBlocks.push(...withImages);
    }

    if (allBlocks.length === 0) {
      throw new Error("変換できる文章が見つかりませんでした。");
    }

    const headingCount = allBlocks.filter(
      (b) => b.type === "heading1" || b.type === "heading2"
    ).length;
    const tableCount = allBlocks.filter((b) => b.type === "table").length;
    const imageCount = allBlocks.filter((b) => b.type === "image").length;
    const listItemCount = allBlocks.filter((b) => b.type === "list").length;
    const paragraphCount = allBlocks.filter(
      (b) => b.type === "paragraph" && b.text !== ""
    ).length;

    // 用紙サイズ・余白は、最初のページに合わせる
    const first = pages[0];
    const pageSetup = buildPageSetup(first, filteredByPage[0], contentLeft, contentRight);

    let blob: Blob;
    try {
      blob = await buildDocxBlob({ blocks: allBlocks, page: pageSetup, headerText, footerText, pageNumber });
    } catch {
      throw new Error("Word文書の生成に失敗しました");
    }

    return {
      blob,
      sizeBytes: blob.size,
      pageCount: pdf.numPages,
      paragraphCount,
      headingCount,
      usedOcr,
      ocrConfidence: ocrConfidences.length > 0 ? ocrConfidences.reduce((a, b) => a + b, 0) / ocrConfidences.length : null,
      tableCount,
      imageCount,
      listItemCount,
    };
  }
}

/** ページの用紙サイズ・余白（本文の位置から求める）。OCRのページは座標系が異なるため既定の余白にする */
function buildPageSetup(
  page: PageData,
  items: PositionedTextItem[],
  contentLeft: number | undefined,
  contentRight: number | undefined
): DocxPageSetup {
  const [x0, y0, x1, y1] = page.view;
  const widthPt = x1 - x0;
  const heightPt = y1 - y0;
  const setup: DocxPageSetup = {
    widthPt,
    heightPt,
    marginLeftPt: 54,
    marginRightPt: 54,
    marginTopPt: 54,
    marginBottomPt: 54,
  };
  const body = items.filter((i) => i.str.trim() !== "");
  if (!page.fromTextLayer || body.length === 0 || contentLeft === undefined || contentRight === undefined) return setup;
  const topY = Math.max(...body.map((i) => i.y + i.fontHeight));
  const bottomY = Math.min(...body.map((i) => i.y));
  setup.marginLeftPt = clamp(contentLeft - x0, MIN_MARGIN_PT, MAX_MARGIN_PT);
  setup.marginRightPt = clamp(x1 - contentRight, MIN_MARGIN_PT, MAX_MARGIN_PT);
  setup.marginTopPt = clamp(y1 - topY, MIN_MARGIN_PT, MAX_MARGIN_PT);
  setup.marginBottomPt = clamp(bottomY - y0, MIN_MARGIN_PT, MAX_MARGIN_PT);
  return setup;
}

/** 画像を、位置（上からの順）に合わせて本文のブロックの間へ差し込む */
function insertImages(
  blocks: DocumentBlock[],
  images: ExtractedImage[],
  view: number[],
  contentLeft: number | undefined,
  contentRight: number | undefined
): DocumentBlock[] {
  if (images.length === 0) return blocks;
  const sorted = [...images].sort((a, b) => b.top - a.top);
  const result: DocumentBlock[] = [];
  let bi = 0;
  for (const img of sorted) {
    while (bi < blocks.length) {
      const y = (blocks[bi] as { y?: number }).y;
      // 画像の上端より下にあるブロックが来たら、その手前に画像を入れる
      if (y !== undefined && y < img.top - 2) break;
      result.push(blocks[bi]);
      bi++;
    }
    let align: ImageBlock["align"] = "left";
    if (contentLeft !== undefined && contentRight !== undefined && contentRight > contentLeft) {
      const boxWidth = contentRight - contentLeft;
      const center = view[0] + img.x + img.width / 2;
      if (img.width < boxWidth * 0.9 && Math.abs(center - (contentLeft + contentRight) / 2) < boxWidth * 0.06) {
        align = "center";
      }
    }
    result.push({ type: "image", data: img.data, width: img.width, height: img.height, align, y: img.top });
  }
  while (bi < blocks.length) result.push(blocks[bi++]);
  return result;
}

/**
 * 画面のプレビュー用: 先頭ページの文字レイヤーから、Word文書になる段落・見出し・リスト・表を取り出す
 * (変換本体と同じ getPositionedTextItems → reconstructParagraphs を使う)。
 * 文字レイヤーが無いページ(スキャン画像)はOCRが必要で重いため、プレビューでは読み取らず
 * hasTextLayer: false を返す(変換ボタンを押したときにOCRされる)。
 * 色・画像はページを画像にする必要があるため、プレビューでは取り出さない（太字・斜体・リンクは反映する）。
 */
export async function previewPdfToWordBlocks(
  file: File
): Promise<{ pageCount: number; hasTextLayer: boolean; blocks: DocumentBlock[] }> {
  const pdf = await loadPdfDocument(file);
  if (pdf.numPages === 0) throw new Error("このPDFにはページがありません");
  const page = await pdf.getPage(1);
  const textItems = await getPositionedTextItems(page);
  if (!pageHasText(textItems)) return { pageCount: pdf.numPages, hasTextLayer: false, blocks: [] };
  try {
    await applyPageStyles(page, textItems, { withRender: false, withImages: false });
  } catch {
    // 書式が取れなくても、文字のプレビューは出す
  }
  return { pageCount: pdf.numPages, hasTextLayer: true, blocks: reconstructParagraphs(textItems) };
}
