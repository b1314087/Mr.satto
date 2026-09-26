import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems, pageHasText, type PositionedTextItem } from "@/lib/pdf/pdfjs-client";
import { reconstructTable, tryParseNumberCell, tryParseDateCell } from "@/lib/pdf/table-reconstruction";
import { recognizeImageWithWords, type OcrLanguageOption, type OcrWord } from "@/lib/ocr/tesseract-client";

/**
 * 記入済みPDF→Excel Processor（Phase 11 ツール①）。
 *
 * 既存の「PDF→Excel」（src/lib/processors/browser/pdf-to-excel.ts）は
 * PDFのテキストレイヤーから表を再構成するのみで、スキャンした画像PDF
 * （記入済みの申請書・帳票を紙からスキャンしたもの等）には対応していない
 * （同ファイルのコメント参照）。このProcessorはその欠けている経路を埋める：
 *
 *   ページに文字レイヤーがある   -> そのまま座標付きテキストを使う（速く正確）
 *   ページに文字レイヤーがない   -> ページを画像化し、OCR（tesseract.js、
 *                                   日本語データ組み込み済み）で単語ごとの
 *                                   bounding boxを取得し、PDFのテキストレイヤーと
 *                                   同じ PositionedTextItem 形状へ変換する
 *
 * どちらの経路でも、最終的な行・列への組み立ては
 * src/lib/pdf/table-reconstruction.ts の同じ決定的な座標ベースロジック
 * （y座標クラスタリング＋列間の空白コリドー検出）を使う。
 * 「なんとなくAIが項目を判断する」方式は使わない
 * （Phase 11 開発指示書 0章・14章：AI/LLMは一切使わない）。
 *
 * 複雑な帳票・手書き文字の癖等により、100%正確な項目化を保証するものではない
 * （OCR自体の精度に依存する。開発指示書の「完全に構造化できると言い切らない」
 * 方針を踏まえ、UI側でもその旨を案内する）。
 *
 * 複数ファイル対応（開発指示書5章）：「3ページまで」はファイル数ではなく
 * 選択した全ファイルの合計ページ数を指す（例: 2ページのPDF + 1ページのPDF = 3ページ）。
 * そのため入力は単一ファイルではなく配列とし、ページ数の判定は合計値に対して行う。
 * 複数ファイルを渡した場合、生成されるExcelは1つのシートに、ファイルごとの
 * 見出し行を挟みながら連結される。
 */

const MAX_PAGES_HARD_LIMIT = 20;
const PDF_RENDER_SCALE = 2;
/** OCR用に描画するページ画像の最長辺の上限(px)。スマートフォンでのメモリ超過を防ぐ */
const MAX_OCR_DIMENSION = 2000;

export interface FilledPdfToExcelPageInfo {
  fileName: string;
  pageNumber: number;
  rowCount: number;
  columnCount: number;
  method: "text-layer" | "ocr";
  /** OCRを行ったページのみ0〜100。テキストレイヤー抽出のページはnull */
  confidence: number | null;
}

export interface FilledPdfToExcelInput {
  /** 処理対象のPDFファイル群（1つでも複数でもよい） */
  files: File[];
  language: OcrLanguageOption;
  /**
   * この呼び出しで許可する最大ページ数（全ファイル合計。Free/Standardの
   * 1回あたり3ページ制限等、プラン・利用回数に基づく上限をUI側から渡す）。
   * 省略時は技術上限のみ適用する（Premiumプラン等、回数制限のない場合に使う）。
   */
  maxTotalPages?: number;
  onPageProgress?: (info: {
    fileName: string;
    currentPage: number;
    totalPagesInFile: number;
    fileIndex: number;
    fileCount: number;
    method: "text-layer" | "ocr";
    pageProgress: number;
  }) => void;
}

export interface FilledPdfToExcelOutput {
  blob: Blob;
  sizeBytes: number;
  /** 全ファイル合計のページ数 */
  pageCount: number;
  pages: FilledPdfToExcelPageInfo[];
  totalRowCount: number;
  usedOcr: boolean;
  /** 画面プレビュー用に先頭数行だけ保持する（全データを画面に保持しすぎないため） */
  previewRows: string[][];
}

type ExcelCell = string | number | { value: Date; type: DateConstructor; format: string };

function toExcelCell(text: string): ExcelCell {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const num = tryParseNumberCell(trimmed);
  if (num !== null) return num;
  const date = tryParseDateCell(trimmed);
  if (date !== null) return { value: date, type: Date, format: "yyyy-mm-dd" };
  return trimmed;
}

/**
 * OCRの単語（画像ピクセル座標、原点は左上・下方向がy増加）を、
 * table-reconstruction.ts が期待する PositionedTextItem 形状
 * （行のグルーピングは「上ほど大きいy」を前提にしている）へ変換する。
 * ページごとに単独で使う値のため、PDFの実座標系と一致させる必要はなく、
 * 「同じページ内で一貫している」ことだけが重要。
 */
function ocrWordsToPositionedItems(words: OcrWord[]): PositionedTextItem[] {
  return words.map((w) => ({
    str: w.text,
    x: w.x0,
    y: -w.y0,
    width: Math.max(0, w.x1 - w.x0),
    height: Math.max(1, w.y1 - w.y0),
    fontHeight: Math.max(1, w.y1 - w.y0),
    hasEOL: false,
  }));
}

export class FilledPdfToExcelProcessor extends BrowserProcessor<FilledPdfToExcelInput, FilledPdfToExcelOutput> {
  async process({ files, language, maxTotalPages, onPageProgress }: FilledPdfToExcelInput): Promise<FilledPdfToExcelOutput> {
    if (files.length === 0) {
      throw new Error("PDFファイルを選択してください");
    }
    if (files.some((f) => f.size === 0)) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    // 先に全ファイルを読み込み、合計ページ数を確定させてから上限判定する
    // （「3ページ」はファイル数ではなく全ファイル合計ページ数のため）。
    const pdfDocs: { file: File; pdf: Awaited<ReturnType<typeof loadPdfDocument>> }[] = [];
    for (const file of files) {
      let pdf;
      try {
        pdf = await loadPdfDocument(file);
      } catch {
        throw new Error(`${file.name} の読み込みに失敗しました`);
      }
      if (pdf.numPages === 0) {
        throw new Error(`${file.name} にはページがありません`);
      }
      pdfDocs.push({ file, pdf });
    }

    const totalPages = pdfDocs.reduce((sum, d) => sum + d.pdf.numPages, 0);
    const effectiveLimit = Math.min(maxTotalPages ?? MAX_PAGES_HARD_LIMIT, MAX_PAGES_HARD_LIMIT);
    if (totalPages > effectiveLimit) {
      throw new Error(
        `このプラン・利用条件で処理できるページ数の上限は合計${effectiveLimit}ページです（選択したファイルの合計は${totalPages}ページです）。`
      );
    }

    const sheetRows: ExcelCell[][] = [];
    const pages: FilledPdfToExcelPageInfo[] = [];
    const previewRows: string[][] = [];
    let totalRowCount = 0;
    let usedOcr = false;
    const PREVIEW_ROW_LIMIT = 20;

    for (let fileIndex = 0; fileIndex < pdfDocs.length; fileIndex++) {
      const { file, pdf } = pdfDocs[fileIndex];

      if (pdfDocs.length > 1) {
        if (sheetRows.length > 0) sheetRows.push([""]);
        sheetRows.push([`--- ${file.name} ---`]);
      }

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        let page;
        try {
          page = await pdf.getPage(pageNumber);
        } catch {
          throw new Error(`${file.name} の${pageNumber}ページ目の読み込みに失敗しました`);
        }

        const textItems = await getPositionedTextItems(page);
        let items: PositionedTextItem[];
        let method: "text-layer" | "ocr";
        let confidence: number | null = null;

        if (pageHasText(textItems)) {
          items = textItems;
          method = "text-layer";
          onPageProgress?.({
            fileName: file.name,
            currentPage: pageNumber,
            totalPagesInFile: pdf.numPages,
            fileIndex,
            fileCount: pdfDocs.length,
            method,
            pageProgress: 1,
          });
        } else {
          // 文字情報を持たないページ（スキャンした記入済み帳票の画像等）は
          // ページ全体を画像化してOCRする。全ページ分の画像を同時に保持せず、
          // 1ページ処理するごとにcanvasの参照を手放す。
          usedOcr = true;
          method = "ocr";
          let canvas: HTMLCanvasElement;
          try {
            const baseViewport = page.getViewport({ scale: PDF_RENDER_SCALE });
            const longest = Math.max(baseViewport.width, baseViewport.height);
            const renderScale =
              longest > MAX_OCR_DIMENSION ? PDF_RENDER_SCALE * (MAX_OCR_DIMENSION / longest) : PDF_RENDER_SCALE;
            const viewport = page.getViewport({ scale: renderScale });
            canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const canvasContext = canvas.getContext("2d");
            if (!canvasContext) throw new Error("Canvasの初期化に失敗しました");
            await page.render({ canvasContext, viewport }).promise;
          } catch {
            throw new Error(`${file.name} の${pageNumber}ページ目の画像化に失敗しました`);
          }

          const result = await recognizeImageWithWords(canvas, language, (p) => {
            onPageProgress?.({
              fileName: file.name,
              currentPage: pageNumber,
              totalPagesInFile: pdf.numPages,
              fileIndex,
              fileCount: pdfDocs.length,
              method,
              pageProgress: p.progress,
            });
          });
          confidence = result.confidence;
          items = ocrWordsToPositionedItems(result.words);
        }

        const table = reconstructTable(items);
        if (table.rows.length === 0) {
          pages.push({ fileName: file.name, pageNumber, rowCount: 0, columnCount: 0, method, confidence });
          continue;
        }

        if (sheetRows.length > 0) {
          sheetRows.push(new Array(Math.max(table.columnCount, 1)).fill(""));
        }
        for (const row of table.rows) {
          sheetRows.push(row.map(toExcelCell));
          if (previewRows.length < PREVIEW_ROW_LIMIT) previewRows.push(row);
        }

        pages.push({ fileName: file.name, pageNumber, rowCount: table.rows.length, columnCount: table.columnCount, method, confidence });
        totalRowCount += table.rows.length;
      }
    }

    if (sheetRows.length === 0) {
      throw new Error(
        "項目として認識できる内容が見つかりませんでした。文字がはっきり読み取れるスキャン画像かご確認ください。"
      );
    }

    const { default: writeXlsxFile } = await import("write-excel-file/universal");
    let blob: Blob;
    try {
      blob = await writeXlsxFile(sheetRows).toBlob();
    } catch {
      throw new Error("Excelファイルの生成に失敗しました");
    }

    return {
      blob,
      sizeBytes: blob.size,
      pageCount: totalPages,
      pages,
      totalRowCount,
      usedOcr,
      previewRows,
    };
  }
}
