import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems } from "@/lib/pdf/pdfjs-client";
import {
  reconstructTable,
  tryParseNumberCell,
  tryParseDateCell,
} from "@/lib/pdf/table-reconstruction";

/**
 * PDF→Excel Processor（Phase 2-D）。
 *
 * 「textItems.map(...) → 1行のCSV」という雑な実装ではなく、
 * src/lib/pdf/table-reconstruction.ts の座標ベースの行・列推定を使い、
 * 実際にExcelのセル（行×列）へ配置する。
 *
 * 数値・日付として自信を持って認識できたセルのみ、実際のExcel
 * 数値型・日付型セルとして出力する（曖昧な表記は文字列のまま扱い、
 * 過剰に型変換しない）。
 *
 * 複数ページのPDFは、各ページの表を順番にSheet1へ連結する
 * （ページごとに空行を1行はさみ、区切りが分かるようにする）。
 * 複雑な表・複数の独立した表が混在するPDFで100%正しく構造化できることは
 * 保証しない（開発指示書の「どんなPDFでも完全にExcel化できる、という
 * 表現は禁止」を踏まえ、UI側でも実用上の限界を案内する）。
 */

const MAX_PDF_TO_EXCEL_PAGES = 50;
const PREVIEW_ROW_LIMIT = 20;

export interface PdfToExcelPageInfo {
  pageNumber: number;
  rowCount: number;
  columnCount: number;
}

export interface PdfToExcelInput {
  file: File;
  onPageProgress?: (info: { currentPage: number; totalPages: number }) => void;
}

export interface PdfToExcelOutput {
  blob: Blob;
  sizeBytes: number;
  pageCount: number;
  pages: PdfToExcelPageInfo[];
  totalRowCount: number;
  /** 画面プレビュー用に先頭数行だけ保持する（全データを画面に保持しすぎないため） */
  previewRows: string[][];
}

type ExcelCell = string | number | { value: Date; type: DateConstructor; format: string };

/** 抽出したセルのテキストを、確信を持てる場合のみ数値・日付型に変換する */
function toExcelCell(text: string): ExcelCell {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const num = tryParseNumberCell(trimmed);
  if (num !== null) return num;
  const date = tryParseDateCell(trimmed);
  if (date !== null) return { value: date, type: Date, format: "yyyy-mm-dd" };
  return trimmed;
}

export class PdfToExcelProcessor extends BrowserProcessor<PdfToExcelInput, PdfToExcelOutput> {
  async process({ file, onPageProgress }: PdfToExcelInput): Promise<PdfToExcelOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    const pdf = await loadPdfDocument(file);
    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    if (pdf.numPages > MAX_PDF_TO_EXCEL_PAGES) {
      throw new Error(
        `変換できるページ数の上限は${MAX_PDF_TO_EXCEL_PAGES}ページです（このPDFは${pdf.numPages}ページあります）。ページ数を減らしてから再度お試しください。`
      );
    }

    const sheetRows: ExcelCell[][] = [];
    const pages: PdfToExcelPageInfo[] = [];
    const previewRows: string[][] = [];
    let totalRowCount = 0;
    let anyTextFound = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages });

      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
      }

      const items = await getPositionedTextItems(page);
      if (items.some((i) => i.str.trim() !== "")) anyTextFound = true;

      const table = reconstructTable(items);
      if (table.rows.length === 0) {
        pages.push({ pageNumber, rowCount: 0, columnCount: 0 });
        continue;
      }

      if (sheetRows.length > 0) {
        // ページの切れ目が分かるよう、空行を1行はさんでから連結する
        sheetRows.push(new Array(Math.max(table.columnCount, 1)).fill(""));
      }

      for (const row of table.rows) {
        sheetRows.push(row.map(toExcelCell));
        if (previewRows.length < PREVIEW_ROW_LIMIT) previewRows.push(row);
      }

      pages.push({ pageNumber, rowCount: table.rows.length, columnCount: table.columnCount });
      totalRowCount += table.rows.length;
    }

    if (!anyTextFound) {
      throw new Error(
        "このPDFから文字情報を抽出できませんでした。スキャンした画像のPDFの可能性があります（画像PDFの表認識は今回のバージョンでは未対応です。OCRツールでのテキスト化をお試しください）。"
      );
    }
    if (sheetRows.length === 0) {
      throw new Error("表として認識できる内容が見つかりませんでした。");
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
      pageCount: pdf.numPages,
      pages,
      totalRowCount,
      previewRows,
    };
  }
}
