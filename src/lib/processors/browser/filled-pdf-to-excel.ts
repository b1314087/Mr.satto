import { BrowserProcessor } from "../types";
import { closePdfDocument, loadPdfDocument, getPositionedTextItems, pageHasText, type PositionedTextItem } from "@/lib/pdf/pdfjs-client";
import { reconstructTable, groupIntoLines, computeColumnBreaksAcrossPages, type ReconstructedTable } from "@/lib/pdf/table-reconstruction";
import { toExcelWriteCell, type ExcelWriteCell } from "@/lib/pdf/cell-value";
import { getFormFieldItems } from "@/lib/pdf/form-fields";
import type { SheetData } from "write-excel-file/universal";
import { recognizeImageWithWords, ocrWordsToPositionedTextItems, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";

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
 * 工程4での精度の改善（AIは使わない。座標と表記のルールだけで行う）:
 * - 入力フォーム（AcroForm）の値を読む：入力欄・チェックボックス・ラジオボタン・選択欄に記入したPDFは、記入内容が
 *   文字情報に入らないため、注釈から値を取り出して表に入れる（src/lib/pdf/form-fields.ts。チェックは ☑／☐）。
 * - 値の型：全角数字・金額（¥・円・後ろの「-」）・マイナス（−・△・▲・括弧）・小数の桁・割合・和暦の日付を、
 *   確かな表記だけ数値・日付にし、表示形式で元の見た目を保つ（src/lib/pdf/cell-value.ts）。空欄は空欄のまま。
 * - 結合セル：表の推定で見つかった横方向の結合（列をまたぐ項目）を、Excelでも結合する。
 * - 複数ページの表：同じファイルの各ページが同じ列数の表のときは、全ページで列の区切りをそろえ、
 *   2ページ目以降に繰り返される見出しの行は省いて、1つの表として続ける。
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

type ExcelCell = ExcelWriteCell | { value: string | number | Date; type?: unknown; format?: string; columnSpan: number };

/** 表の1行を、Excelの行にする（横方向の結合は columnSpan にし、結合で隠れるセルは null にする） */
export function tableRowToExcelRow(table: Pick<ReconstructedTable, "columnSpans">, rowIndex: number, row: string[]): ExcelCell[] {
  const cells: ExcelCell[] = row.map((text) => toExcelWriteCell(text));
  for (const span of table.columnSpans) {
    if (span.row !== rowIndex || span.span < 2) continue;
    const width = Math.min(span.span, cells.length - span.col);
    if (width < 2) continue;
    // 結合する範囲の、ほかのセルに文字があるときは結合しない（読み取った文字を消さない）
    if (row.slice(span.col + 1, span.col + width).some((t) => t.trim() !== "")) continue;
    const head = cells[span.col];
    const base = head === null || head === "" ? { value: "" } : typeof head === "object" ? head : { value: head };
    cells[span.col] = { ...base, columnSpan: width } as ExcelCell;
    for (let c = span.col + 1; c < span.col + width; c++) cells[c] = null;
  }
  return cells;
}

/** 見出しの行が同じか（前後の空白・全角半角の空白の違いは無視する） */
function sameRow(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b) return false;
  const norm = (r: readonly string[]) => r.map((t) => t.replace(/\s+/g, "")).join("\u0001");
  return norm(a) === norm(b) && a.some((t) => t.trim() !== "");
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
    try {
      for (const file of files) {
        let pdf;
        try {
          pdf = await loadPdfDocument(file);
        } catch {
          throw new Error(`${file.name} の読み込みに失敗しました`);
        }
        // 先に一覧へ入れてから確かめる（途中で止まっても、開いたPDFを全部閉じられるように）
        pdfDocs.push({ file, pdf });
        if (pdf.numPages === 0) {
          throw new Error(`${file.name} にはページがありません`);
        }
      }

      const totalPages = pdfDocs.reduce((sum, d) => sum + d.pdf.numPages, 0);
      const effectiveLimit = Math.min(maxTotalPages ?? MAX_PAGES_HARD_LIMIT, MAX_PAGES_HARD_LIMIT);
      if (totalPages > effectiveLimit) {
        throw new Error(
          `処理できるページ数の上限は合計${effectiveLimit}ページです（選択したファイルの合計は${totalPages}ページです）。`
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

        // まず、すべてのページの文字（文字情報・入力欄の値、なければOCR）を集める
        const pageItems: { pageNumber: number; items: PositionedTextItem[]; method: "text-layer" | "ocr"; confidence: number | null }[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          let page;
          try {
            page = await pdf.getPage(pageNumber);
          } catch {
            throw new Error(`${file.name} の${pageNumber}ページ目の読み込みに失敗しました`);
          }

          // 工程4：入力フォームの値（入力欄・チェックボックス・選択欄）も、文字情報と一緒に使う
          const textItems = [...(await getPositionedTextItems(page)), ...(await getFormFieldItems(page))];
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
            items = ocrWordsToPositionedTextItems(result.words);
          }
          pageItems.push({ pageNumber, items, method, confidence });
        }

        // 複数ページの表：文字情報のページがどれも同じ列数の表なら、全ページで列の区切りをそろえる
        const independent = pageItems.map((p) => reconstructTable(p.items));
        const textPages = pageItems.filter((p) => p.method === "text-layer");
        const textTables = independent.filter((_, i) => pageItems[i].method === "text-layer" && independent[i].rows.length > 0);
        let sharedBreaks: number[] | undefined;
        if (textPages.length >= 2 && textTables.length === textPages.length && textTables.every((t) => t.columnCount === textTables[0].columnCount && t.columnCount >= 2)) {
          const breaks = computeColumnBreaksAcrossPages(textPages.map((p) => groupIntoLines(p.items)));
          if (breaks.length + 1 === textTables[0].columnCount) sharedBreaks = breaks;
        }

        let previousHeader: string[] | undefined;
        for (let i = 0; i < pageItems.length; i++) {
          const { pageNumber, items, method, confidence } = pageItems[i];
          const table = sharedBreaks && method === "text-layer" ? reconstructTable(items, sharedBreaks) : independent[i];
          if (table.rows.length === 0) {
            pages.push({ fileName: file.name, pageNumber, rowCount: 0, columnCount: 0, method, confidence });
            continue;
          }

          // 2ページ目以降で、前のページと同じ見出しの行が繰り返されているときは、続きの表として見出しを省く
          const continued = !!sharedBreaks && sameRow(table.rows[0], previousHeader);
          const startRow = continued ? 1 : 0;
          if (sheetRows.length > 0 && !continued) {
            sheetRows.push(new Array(Math.max(table.columnCount, 1)).fill(""));
          }
          for (let r = startRow; r < table.rows.length; r++) {
            const row = table.rows[r];
            sheetRows.push(tableRowToExcelRow(table, r, row));
            if (previewRows.length < PREVIEW_ROW_LIMIT) previewRows.push(row);
          }
          if (!continued) previousHeader = table.rows[0];

          const rowCount = table.rows.length - startRow;
          pages.push({ fileName: file.name, pageNumber, rowCount, columnCount: table.columnCount, method, confidence });
          totalRowCount += rowCount;
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
        blob = await writeXlsxFile(sheetRows as unknown as SheetData).toBlob();
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
    } finally {
      await Promise.all(pdfDocs.map((d) => closePdfDocument(d.pdf)));
    }
  }
}
