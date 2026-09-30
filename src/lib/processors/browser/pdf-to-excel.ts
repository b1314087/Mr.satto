import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems, renderPageToCanvas, type PdfjsPage } from "@/lib/pdf/pdfjs-client";
import {
  reconstructTable,
  tryParseNumberCell,
  tryParseDateCell,
  type ColumnSpanHint,
} from "@/lib/pdf/table-reconstruction";
import type { Row as ExcelRow, Cell as ExcelCellValue } from "write-excel-file/universal";

/**
 * PDF→Excel Processor（Phase 2-D、外出先PC修正指示書§21-26で罫線・結合セル対応を追加）。
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
 *
 * 罫線・結合セル(§21-26)について: 以前のバージョンはテキストの位置だけから
 * 行・列を推定し、罫線情報も結合セルも一切出力していなかった（write-excel-file
 * 自体はborderColor/borderStyle・columnSpan/rowSpanを既にサポート済みで、
 * 新しい依存の追加は不要）。PDFのテキストレイヤーには罫線の情報が含まれない
 * ため（PDFの罫線は矩形や線分としてベクター描画されているだけで、pdfjsの
 * getTextContent()には現れない）、罫線の有無は「ページを画像として描画し、
 * table-reconstruction.tsが推定した行・列の境界線の位置に、実際に暗い色の
 * 線が引かれているか」をCanvas上でピクセル単位に走査して判定する
 * （detectTableBorders）。結合セルの推定は逆にテキストの位置だけから行う
 * （detectColumnSpanは既にtable-reconstruction.ts側で実施済み。1つのテキスト
 * 項目が、ページ全体から決定的に導出された列区切りを実際にまたいでいる場合、
 * その行だけ列が結合されていたとみなす）。どちらも「実用的な精度を目指す。
 * 100%の再現は保証しない」という開発指示書の方針を踏まえた、決定的
 * （非AI）なヒューリスティックである。
 */

const MAX_PDF_TO_EXCEL_PAGES = 50;
const PREVIEW_ROW_LIMIT = 20;
/** 罫線検出用にページを描画する解像度。OCR用途ほどの高解像度は不要なため控えめにする */
const BORDER_DETECTION_RENDER_SCALE = 1.5;
/** この輝度(0〜255)未満を「線が引かれている(インクがある)」とみなす */
const DARK_LUMINANCE_THRESHOLD = 200;
/** 境界線の位置に実際の直線が引かれていると判定する、走査幅に対する暗ピクセルの最低比率 */
const LINE_COVERAGE_RATIO = 0.6;
/** 境界線の判定位置が数px前後にずれていても検出できるよう、上下(または左右)に許容する幅(px) */
const SAMPLE_TOLERANCE_PX = 2;

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

/** 抽出したセルのテキストを、確信を持てる場合のみ数値・日付型に変換する */
function toExcelCellValue(text: string): ExcelCellValue {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const num = tryParseNumberCell(trimmed);
  if (num !== null) return num;
  const date = tryParseDateCell(trimmed);
  if (date !== null) return { value: date, type: Date, format: "yyyy-mm-dd" };
  return trimmed;
}

interface BorderPresence {
  /** 長さ = 行数+1。rowBorderPresent[i] = 行iの「上」(=行i-1の下)に線があるか */
  rowBorderPresent: boolean[];
  /** 長さ = 列数+1。colBorderPresent[j] = 列jの「左」(=列j-1の右)に線があるか */
  colBorderPresent: boolean[];
}

/**
 * ページを画像化し、table-reconstruction.tsが推定した行・列の境界線の位置に
 * 実際に暗い色の直線が引かれているかをピクセル単位で判定する（§21-26）。
 * 判定できない場合(Canvas初期化失敗等)はnullを返し、呼び出し側は「罫線情報なし」
 * として通常どおり出力する(PDF→Excel自体は止めない)。
 */
async function detectTableBorders(
  page: PdfjsPage,
  rowBoundariesY: number[],
  colBoundariesX: number[]
): Promise<BorderPresence | null> {
  if (rowBoundariesY.length < 2 || colBoundariesX.length < 2) return null;
  try {
    const { canvas, scale } = await renderPageToCanvas(page, BORDER_DETECTION_RENDER_SCALE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const viewport = page.getViewport({ scale });

    function luminanceAt(px: number, py: number): number {
      if (px < 0 || py < 0 || px >= width || py >= height) return 255; // ページ外は「白」とみなす
      const idx = (Math.floor(py) * width + Math.floor(px)) * 4;
      return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }

    // convertToViewportPointはPDFページ座標(原点左下)→Canvas/画面座標(原点左上)への
    // 変換を、回転があっても正しく行う（coords.tsの既存の教訓を踏襲し、scaleの
    // 手動再計算ではなくpdfjs自身のviewport変換を使う）。
    function toScreen(x: number, y: number): [number, number] {
      const p = viewport.convertToViewportPoint(x, y) as [number, number];
      return [p[0], p[1]];
    }

    const midX = (colBoundariesX[0] + colBoundariesX[colBoundariesX.length - 1]) / 2;
    const midY = (rowBoundariesY[0] + rowBoundariesY[rowBoundariesY.length - 1]) / 2;
    const [leftScreenX] = toScreen(colBoundariesX[0], midY);
    const [rightScreenX] = toScreen(colBoundariesX[colBoundariesX.length - 1], midY);
    const [, topScreenY] = toScreen(midX, rowBoundariesY[0]);
    const [, bottomScreenY] = toScreen(midX, rowBoundariesY[rowBoundariesY.length - 1]);

    const xStart = Math.min(leftScreenX, rightScreenX);
    const xSpan = Math.max(1, Math.abs(rightScreenX - leftScreenX));
    const yStart = Math.min(topScreenY, bottomScreenY);
    const ySpan = Math.max(1, Math.abs(bottomScreenY - topScreenY));

    const rowBorderPresent = rowBoundariesY.map((y) => {
      const [, sy] = toScreen(midX, y);
      let darkCount = 0;
      for (let dx = 0; dx <= xSpan; dx += 1) {
        let isDark = false;
        for (let dy = -SAMPLE_TOLERANCE_PX; dy <= SAMPLE_TOLERANCE_PX; dy += 1) {
          if (luminanceAt(xStart + dx, sy + dy) < DARK_LUMINANCE_THRESHOLD) {
            isDark = true;
            break;
          }
        }
        if (isDark) darkCount += 1;
      }
      return darkCount / (xSpan + 1) >= LINE_COVERAGE_RATIO;
    });

    const colBorderPresent = colBoundariesX.map((x) => {
      const [sx] = toScreen(x, midY);
      let darkCount = 0;
      for (let dy = 0; dy <= ySpan; dy += 1) {
        let isDark = false;
        for (let dx = -SAMPLE_TOLERANCE_PX; dx <= SAMPLE_TOLERANCE_PX; dx += 1) {
          if (luminanceAt(sx + dx, yStart + dy) < DARK_LUMINANCE_THRESHOLD) {
            isDark = true;
            break;
          }
        }
        if (isDark) darkCount += 1;
      }
      return darkCount / (ySpan + 1) >= LINE_COVERAGE_RATIO;
    });

    return { rowBorderPresent, colBorderPresent };
  } catch {
    return null;
  }
}

const BORDER_LINE_COLOR = "#8a8a8f";

/**
 * table-reconstruction.tsの1行分の文字列配列を、罫線・結合セル情報を反映した
 * write-excel-file用の行(ExcelRow)へ変換する（§21-26）。スタイル指定が
 * 何も無いセルはこれまでどおりプレーンな値のまま出力する
 * (write-excel-fileの Cell = CellObject | Value | null | undefined という
 * 型を活かし、不要な変更を避ける)。
 */
function buildExcelRow(
  row: string[],
  rowIndex: number,
  columnCount: number,
  borders: BorderPresence | null,
  spansInRow: ColumnSpanHint[]
): ExcelRow {
  const spanByCol = new Map<number, number>();
  const spannedAway = new Set<number>();
  for (const s of spansInRow) {
    if (s.span < 2) continue;
    spanByCol.set(s.col, s.span);
    for (let c = s.col + 1; c < s.col + s.span; c++) spannedAway.add(c);
  }

  const cells: ExcelRow = [];
  for (let c = 0; c < columnCount; c++) {
    if (spannedAway.has(c)) {
      // write-excel-fileの仕様: 結合されたセルのうち先頭以外はnullで表現する
      cells.push(null);
      continue;
    }
    const value = toExcelCellValue(row[c] ?? "");
    const span = spanByCol.get(c);
    const b = borders
      ? {
          top: borders.rowBorderPresent[rowIndex],
          bottom: borders.rowBorderPresent[rowIndex + 1],
          left: borders.colBorderPresent[c],
          right: borders.colBorderPresent[c + 1],
        }
      : null;
    const hasBorder = b && (b.top || b.bottom || b.left || b.right);
    if (!span && !hasBorder) {
      cells.push(value);
      continue;
    }
    const base = typeof value === "object" && value !== null ? { ...value } : { value };
    const cellObj: Record<string, unknown> = { ...base };
    if (span) cellObj.columnSpan = span;
    if (b?.top) {
      cellObj.topBorderColor = BORDER_LINE_COLOR;
      cellObj.topBorderStyle = "thin";
    }
    if (b?.bottom) {
      cellObj.bottomBorderColor = BORDER_LINE_COLOR;
      cellObj.bottomBorderStyle = "thin";
    }
    if (b?.left) {
      cellObj.leftBorderColor = BORDER_LINE_COLOR;
      cellObj.leftBorderStyle = "thin";
    }
    if (b?.right) {
      cellObj.rightBorderColor = BORDER_LINE_COLOR;
      cellObj.rightBorderStyle = "thin";
    }
    cells.push(cellObj as ExcelCellValue);
  }
  return cells;
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

    const sheetRows: ExcelRow[] = [];
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

      // 罫線検出(§21-26)は行数が2以上(=表らしい構造)のページに限って行う
      // (1行だけのページに罫線検出コストをかけても実益が薄いため)。
      const borders = table.rows.length >= 2 ? await detectTableBorders(page, table.rowBoundariesY, table.colBoundariesX) : null;

      table.rows.forEach((row, rowIndex) => {
        const spansInRow = table.columnSpans.filter((s) => s.row === rowIndex);
        sheetRows.push(buildExcelRow(row, rowIndex, table.columnCount, borders, spansInRow));
        if (previewRows.length < PREVIEW_ROW_LIMIT) previewRows.push(row);
      });

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
