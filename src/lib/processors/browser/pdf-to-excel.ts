import { BrowserProcessor } from "../types";
import {
  loadPdfDocument,
  getPositionedTextItems,
  pageHasText,
  renderPageToCanvas,
  type PdfjsPage,
} from "@/lib/pdf/pdfjs-client";
import { recognizeImageWithWords, ocrWordsToPositionedTextItems, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import {
  reconstructTable,
  groupIntoLines,
  computeColumnBreaksAcrossPages,
  extractVerticalLabels,
  tryParseNumberCell,
  tryParseDateCell,
  type VerticalLabel,
} from "@/lib/pdf/table-reconstruction";
import { buildPageGrid, type BorderPresence, type GridCell, type GridRow, type PageGrid } from "@/lib/pdf/page-grid";
import { removePageFurniture } from "@/lib/pdf/page-furniture";
import type { PositionedTextItem } from "@/lib/pdf/pdfjs-client";
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
 * スキャンした画像のPDF（文字情報を持たないページ）への対応: ページごとにテキスト
 * レイヤーの有無を判定し、無いページだけをページ画像化してOCR(tesseract.js、ブラウザ内)
 * で単語と座標を取得する。取得した座標は、文字情報のあるPDFと同じ決定的な表認識
 * （table-reconstruction.ts）へそのまま渡す（AIによる推測は行わない）。PDF→Wordや
 * 記入済みPDF→Excelで既に使っているOCR基盤(tesseract-client.ts)の共通ヘルパーを再利用している。
 * OCRのページは座標系がPDFと異なる（画像のピクセル）ため、罫線検出(detectTableBorders)は
 * 行わない（誤った位置の罫線を出力するより、罫線なしで出力する）。
 *
 * 複雑な表・複数の独立した表が混在するPDFで100%正しく構造化できることは
 * 保証しない（開発指示書の「どんなPDFでも完全にExcel化できる、という
 * 表現は禁止」を踏まえ、UI側でも実用上の限界を案内する）。
 *
 * 複数ページにまたがる1つの表について: 以前は各ページが独立に
 * reconstructTable(items)を呼んでおり、ページごとに個別に列区切りを
 * 推定していたため、同じ表の続きのはずなのにページごとに列数・区切り
 * 位置が食い違うことがあった。そこで、process()はまず全ページの
 * 座標付きテキストとgroupIntoLinesによる行分割だけを先に集め
 * （Pass 1）、computeColumnBreaksAcrossPagesで全ページの行をまとめて
 * 列区切りを1回だけ推定し、その結果(sharedBreaks)を各ページの
 * reconstructTableへ渡すことで（Pass 2）、全ページで一貫した列数・
 * 区切り位置になるようにしている。
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
 *
 * 【使いやすさのための整形(2026-10追加)】
 * 行・列の推定ができても、PDFの見た目に合わせた表がそのまま「使いやすいExcel」になるとは限らない
 * （例: 号給1〜60の表と61〜120の表が左右に並んでいる給料表、縦書きの区分名、複数行に割れた見出し、
 * ページ番号）。そこで、推定した表をExcelに出力する前に、次の整形を行う(いずれも画面から
 * オン・オフできる)。詳細は src/lib/pdf/page-grid.ts と page-furniture.ts:
 * - 左右に並んだ同じ構成の表を、縦に1つの表へ連結する
 * - 縦書きのラベルを、縦に結合した1つのセルにする
 * - 複数行に割れた見出しを、1行にまとめる(見出しは太字・固定表示にする)
 * - ページ番号・毎ページ繰り返されるヘッダー/フッターを除く
 * - ページごとに別シートに分ける(初期状態は1つのシートに連結)
 */

const MAX_PDF_TO_EXCEL_PAGES = 50;
/** OCRを行うページ数の上限（OCR自体が重く、スマートフォンでのメモリ・処理時間を考慮。他のOCRツールと同じ値） */
const MAX_OCR_PAGES = 20;
/** OCR用にページを描画する倍率と、画像の最長辺の上限(px) */
const OCR_RENDER_SCALE = 2;
const MAX_OCR_DIMENSION = 2000;
const PREVIEW_ROW_LIMIT = 30;
/** 画面の先頭ページのプレビューで見せる行数(変換前の確認用) */
const FILE_PREVIEW_ROW_LIMIT = 40;
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
  /** 文字の取得方法。text-layer=PDF内の文字情報、ocr=画像をOCRで読み取り */
  method: "text-layer" | "ocr";
  /** OCRを行ったページのみ0〜100。テキストレイヤーのページはnull */
  confidence: number | null;
}

/** 変換の整形オプション。画面のチェックボックスと対応する */
export interface PdfToExcelOptions {
  /** 左右に並んだ同じ構成の表を、縦に1つの表へ連結する */
  stackSideBySide: boolean;
  /** 複数行に割れた見出しを、1行にまとめる */
  collapseHeader: boolean;
  /** ページ番号・毎ページ繰り返されるヘッダー/フッターを除く */
  removePageFurniture: boolean;
  /** ページごとに別のシートへ分ける(オフなら1つのシートに連結する) */
  sheetPerPage: boolean;
}

export const DEFAULT_PDF_TO_EXCEL_OPTIONS: PdfToExcelOptions = {
  stackSideBySide: true,
  collapseHeader: true,
  removePageFurniture: true,
  sheetPerPage: false,
};

/** 整形で何が行われた(または見つかった)かの要約。画面の案内に使う */
export interface PdfToExcelLayoutNotes {
  /** 左右に並んだ表を見つけたページがある(連結するかどうかにかかわらず) */
  sideBySideDetected: boolean;
  /** 実際に連結したページ数 */
  sideBySideStackedPages: number;
  /** 縦書きのラベルをセルにした数 */
  verticalLabels: number;
  /** 1行にまとめた見出しの、元の行数の合計 */
  headerRowsCollapsed: number;
  /** 取り除いたページ番号・ヘッダー/フッターの行数 */
  furnitureLinesRemoved: number;
}

export interface PdfToExcelInput {
  file: File;
  /** スキャンページのOCR言語。省略時は日本語+英数字 */
  ocrLanguage?: OcrLanguageOption;
  /** 整形オプション。省略した項目は DEFAULT_PDF_TO_EXCEL_OPTIONS */
  options?: Partial<PdfToExcelOptions>;
  onPageProgress?: (info: {
    currentPage: number;
    totalPages: number;
    method?: "text-layer" | "ocr";
    /** OCR中のページ内進捗(0〜1) */
    ocrProgress?: number;
  }) => void;
}

export interface PdfToExcelOutput {
  blob: Blob;
  sizeBytes: number;
  pageCount: number;
  pages: PdfToExcelPageInfo[];
  totalRowCount: number;
  /** 画面プレビュー用に先頭数行だけ保持する（全データを画面に保持しすぎないため） */
  previewRows: string[][];
  /** 1ページでもOCRで読み取った場合はtrue（OCRは誤読があり得るため、UIで確認を促す） */
  usedOcr: boolean;
  /** OCRしたページの信頼度の平均(0〜100)。OCRしていなければnull */
  ocrAverageConfidence: number | null;
  layout: PdfToExcelLayoutNotes;
}

/** 小数点以下の桁数 */
function decimalPlaces(text: string): number {
  const m = text.match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

/** 抽出したセルのテキストを、確信を持てる場合のみ数値・日付型に変換する */
function toExcelCellValue(text: string): ExcelCellValue {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const num = tryParseNumberCell(trimmed);
  if (num !== null) {
    // 元の表記(3桁区切りのカンマ・小数の桁数)をExcel上でも保つ。
    // 数値セルにすると既定では「223000」と表示されてしまい、元の見た目と変わるため。
    const decimals = decimalPlaces(trimmed);
    if (trimmed.includes(",")) {
      return { value: num, type: Number, format: decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0" };
    }
    if (decimals > 0) return { value: num, type: Number, format: `0.${"0".repeat(decimals)}` };
    return num;
  }
  const date = tryParseDateCell(trimmed);
  if (date !== null) return { value: date, type: Date, format: "yyyy-mm-dd" };
  return trimmed;
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
const HEADER_BACKGROUND_COLOR = "#f0f0f3";

/** セル内の文字の表示幅(全角は2、半角は1) */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/**
 * ページのグリッドのセルを、罫線・結合・縦書き・見出しの書式を反映した
 * write-excel-file用のセルへ変換する。スタイル指定が何も無いセルは、
 * これまでどおりプレーンな値のまま出力する(不要な変更を避ける)。
 */
function toExcelCell(cell: GridCell): ExcelCellValue {
  // write-excel-fileの仕様: 結合されたセルのうち先頭以外はnullで表現する
  if (cell.covered) return null;
  const value = toExcelCellValue(cell.text);
  const b = cell.borders;
  const hasBorder = !!b && (b.top || b.bottom || b.left || b.right);
  const styled = !!cell.columnSpan || !!cell.rowSpan || !!cell.vertical || !!cell.header || hasBorder;
  if (!styled) return value;

  const base = typeof value === "object" && value !== null ? { ...value } : { value };
  const obj: Record<string, unknown> = { ...base };
  if (cell.columnSpan) obj.columnSpan = cell.columnSpan;
  if (cell.rowSpan) obj.rowSpan = cell.rowSpan;
  if (cell.vertical) {
    // 縦書きのラベル。上から下へ読む向きに回転し、結合したセルの中央に置く
    obj.textRotation = -90;
    obj.align = "center";
    obj.alignVertical = "center";
  }
  if (cell.header && cell.text.trim() !== "") {
    obj.fontWeight = "bold";
    obj.backgroundColor = HEADER_BACKGROUND_COLOR;
    obj.align = "center";
    obj.alignVertical = "center";
    obj.wrap = true;
  }
  if (b?.top) {
    obj.topBorderColor = BORDER_LINE_COLOR;
    obj.topBorderStyle = "thin";
  }
  if (b?.bottom) {
    obj.bottomBorderColor = BORDER_LINE_COLOR;
    obj.bottomBorderStyle = "thin";
  }
  if (b?.left) {
    obj.leftBorderColor = BORDER_LINE_COLOR;
    obj.leftBorderStyle = "thin";
  }
  if (b?.right) {
    obj.rightBorderColor = BORDER_LINE_COLOR;
    obj.rightBorderStyle = "thin";
  }
  return obj as ExcelCellValue;
}

/** 数値が2つ以上入っている行(表の本体のデータ行) */
function isDataGridRow(row: GridRow | undefined): boolean {
  return !!row && row.filter((c) => !c.covered && tryParseNumberCell(c.text) !== null).length >= 2;
}

function lastNonEmptyRow(rows: GridRow[]): GridRow | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].some((c) => c.text.trim() !== "")) return rows[i];
  return undefined;
}

function firstNonEmptyRow(rows: GridRow[]): GridRow | undefined {
  return rows.find((r) => r.some((c) => c.text.trim() !== ""));
}

interface SheetModel {
  name: string;
  rows: GridRow[];
  columnCount: number;
  /** 見出しとしてまとめた行のうち、先頭のシートで最後のものの行番号+1。固定表示する行数(0なら固定しない) */
  stickyRows: number;
}

/**
 * ページごとのグリッドを、1つ以上のシート(行の並び)にまとめる。
 * 1つのシートに連結する場合、ページの切れ目に空行を1行はさむ。ただし、前のページの最後も
 * 次のページの最初もデータ行の場合(表が次のページへ続いている)は、続けて並べる。
 * 空行が入ると、並べ替えやフィルターが途中で切れてしまうため。
 */
function assembleSheets(grids: { pageNumber: number; grid: PageGrid }[], sheetPerPage: boolean): SheetModel[] {
  const sheets: SheetModel[] = [];
  const startNew = (name: string): SheetModel => {
    const sheet: SheetModel = { name, rows: [], columnCount: 1, stickyRows: 0 };
    sheets.push(sheet);
    return sheet;
  };

  let current: SheetModel | null = null;
  for (const { pageNumber, grid } of grids) {
    if (sheetPerPage || current === null) current = startNew(sheetPerPage ? `${pageNumber}ページ` : "Sheet1");
    if (current.rows.length > 0) {
      const continues = isDataGridRow(lastNonEmptyRow(current.rows)) && isDataGridRow(firstNonEmptyRow(grid.rows));
      if (!continues) current.rows.push([]);
    }
    const offset = current.rows.length;
    grid.rows.forEach((row, i) => {
      current!.rows.push(row);
      // 先頭のページの見出し行まで固定表示する(スクロールしても見出しが見える)
      if (current!.stickyRows === 0 && row.some((c) => c.header && c.text.trim() !== "")) {
        current!.stickyRows = offset + i + 1;
      }
    });
    current.columnCount = Math.max(current.columnCount, grid.columnCount);
  }

  // 右端の、全行で空の列を取り除く
  for (const sheet of sheets) {
    let used = 0;
    for (const row of sheet.rows) {
      row.forEach((cell, c) => {
        if (cell.text.trim() !== "" || cell.vertical) used = Math.max(used, c + 1);
      });
    }
    used = Math.max(1, used);
    sheet.columnCount = used;
    sheet.rows = sheet.rows.map((row) => {
      const trimmed = row.slice(0, used);
      // 取り除いた列にかかる結合は、範囲内に収める
      trimmed.forEach((cell, c) => {
        if (cell.columnSpan && c + cell.columnSpan > used) {
          const clipped = used - c;
          if (clipped >= 2) cell.columnSpan = clipped;
          else delete cell.columnSpan;
        }
      });
      return trimmed;
    });
  }
  return sheets;
}

/** 内容に合わせた列幅を求める(結合・縦書きのセルと、極端に長い文は含めない) */
function computeColumnWidths(sheet: SheetModel): { width: number }[] {
  const widths: number[] = new Array(sheet.columnCount).fill(6);
  for (const row of sheet.rows) {
    row.forEach((cell, c) => {
      if (cell.covered || cell.columnSpan || cell.vertical || cell.text === "") return;
      widths[c] = Math.max(widths[c], Math.min(displayWidth(cell.text) + 2, 40));
    });
  }
  return widths.map((width) => ({ width }));
}

function sheetToExcelRows(sheet: SheetModel): ExcelRow[] {
  return sheet.rows.map((row) => {
    const cells: ExcelRow = [];
    for (let c = 0; c < sheet.columnCount; c++) cells.push(row[c] ? toExcelCell(row[c]) : "");
    return cells;
  });
}

function gridRowToStrings(row: GridRow, columnCount: number): string[] {
  const out: string[] = [];
  for (let c = 0; c < columnCount; c++) out.push(row[c]?.covered ? "" : (row[c]?.text ?? ""));
  return out;
}

interface PageData {
  pageNumber: number;
  page: PdfjsPage;
  items: PositionedTextItem[];
  method: "text-layer" | "ocr";
  confidence: number | null;
}

interface PreparedPage {
  items: PositionedTextItem[];
  labels: VerticalLabel[];
  furnitureRemoved: number;
}

/**
 * 表の推定の前に、ページ番号・ヘッダー/フッターの除去と、縦書きラベルの取り出しを行う。
 * どちらも文字情報のあるPDFのページだけが対象(OCRのページは座標系が画像のピクセルで、
 * 余白の位置の判定が使えないため行わない)。
 */
function prepareItems(pageData: PageData[], options: PdfToExcelOptions): PreparedPage[] {
  const prepared: PreparedPage[] = pageData.map((p) => ({ items: p.items, labels: [], furnitureRemoved: 0 }));
  const textIndexes = pageData.map((p, i) => (p.method === "text-layer" ? i : -1)).filter((i) => i >= 0);

  if (options.removePageFurniture && textIndexes.length > 0) {
    const results = removePageFurniture(
      textIndexes.map((i) => {
        const [, y0, , y1] = pageData[i].page.view;
        return { items: pageData[i].items, pageHeight: y1 - y0, pageBottom: y0 };
      })
    );
    textIndexes.forEach((i, k) => {
      prepared[i].items = results[k].items;
      prepared[i].furnitureRemoved = results[k].removedLines;
    });
  }

  for (const i of textIndexes) {
    const extracted = extractVerticalLabels(prepared[i].items);
    prepared[i].items = extracted.items;
    prepared[i].labels = extracted.labels;
  }
  return prepared;
}

/**
 * 全ページのテキストから、整形したページごとのグリッドを作る(変換本体と画面のプレビューで共通)。
 * detectBordersがtrueのとき、文字情報のあるページは画像化して罫線も調べる。
 */
async function buildGrids(
  pageData: PageData[],
  options: PdfToExcelOptions,
  detectBorders: boolean
): Promise<{ pageNumber: number; method: "text-layer" | "ocr"; confidence: number | null; grid: PageGrid | null }[]> {
  const prepared = prepareItems(pageData, options);

  // 列区切りの共有は、座標系が同じページ同士(文字情報のページ=PDFの座標、OCRのページ=画像のピクセル座標)
  // でだけ行う。文字情報のあるページとスキャンのページが混在するPDFで、座標系の違うページの
  // 位置を混ぜて推定しないため、方式ごとに別々に推定する。
  const sharedBreaksByMethod = new Map<"text-layer" | "ocr", ReturnType<typeof computeColumnBreaksAcrossPages>>();
  for (const m of ["text-layer", "ocr"] as const) {
    const indexes = pageData.map((p, i) => (p.method === m ? i : -1)).filter((i) => i >= 0);
    if (indexes.length > 0) {
      sharedBreaksByMethod.set(
        m,
        computeColumnBreaksAcrossPages(indexes.map((i) => groupIntoLines(prepared[i].items)))
      );
    }
  }

  // 全ページで共通の列区切りを使って各ページの表を再構築する。これにより、あるページでは
  // 記入が少なく単独では十分な根拠が得られない列でも、他のページの内容と合わせて正しく
  // 列として検出され、かつ全ページで同じ列数・区切り位置になる。
  const out: { pageNumber: number; method: "text-layer" | "ocr"; confidence: number | null; grid: PageGrid | null }[] = [];
  for (let i = 0; i < pageData.length; i++) {
    const { pageNumber, page, method, confidence } = pageData[i];
    const table = reconstructTable(prepared[i].items, sharedBreaksByMethod.get(method));
    if (table.rows.length === 0) {
      out.push({ pageNumber, method, confidence, grid: null });
      continue;
    }
    // 罫線検出(§21-26)は行数が2以上(=表らしい構造)のページに限って行う
    // (OCRのページは座標系が画像のピクセルでPDFの座標と一致しないため、罫線検出は行わない)
    const borders =
      detectBorders && table.rows.length >= 2 && method === "text-layer"
        ? await detectTableBorders(page, table.rowBoundariesY, table.colBoundariesX)
        : null;
    const grid = buildPageGrid(table, prepared[i].labels, borders, options);
    grid.furnitureRemoved = prepared[i].furnitureRemoved;
    out.push({ pageNumber, method, confidence, grid });
  }
  return out;
}

function summarizeLayout(grids: { grid: PageGrid | null }[]): PdfToExcelLayoutNotes {
  const notes: PdfToExcelLayoutNotes = {
    sideBySideDetected: false,
    sideBySideStackedPages: 0,
    verticalLabels: 0,
    headerRowsCollapsed: 0,
    furnitureLinesRemoved: 0,
  };
  for (const { grid } of grids) {
    if (!grid) continue;
    if (grid.sideBySideDetected) notes.sideBySideDetected = true;
    if (grid.stacked) notes.sideBySideStackedPages++;
    notes.verticalLabels += grid.verticalLabelCount;
    notes.headerRowsCollapsed += grid.collapsedHeaderRows;
    notes.furnitureLinesRemoved += grid.furnitureRemoved;
  }
  return notes;
}

function resolveOptions(partial?: Partial<PdfToExcelOptions>): PdfToExcelOptions {
  return { ...DEFAULT_PDF_TO_EXCEL_OPTIONS, ...partial };
}

/**
 * 画面のプレビュー用: 先頭ページ(など)の文字情報から、Excelの表になる行を取り出す
 * (変換本体と同じ getPositionedTextItems → 表の推定 → 整形 を使う。列の区切りは先頭3ページ分から推定)。
 * 文字情報が無いページ(スキャン画像)はOCRが必要で重いため、プレビューでは読み取らず
 * hasTextLayer: false を返す(変換を実行したときにOCRされる)。
 * 左右に並んだ表の連結など、整形の結果が見えるよう、変換と同じオプションを渡せる。
 */
export async function previewPdfToExcelRows(
  file: File,
  optionsInput?: Partial<PdfToExcelOptions>
): Promise<{ pageCount: number; hasTextLayer: boolean; rows: string[][]; layout: PdfToExcelLayoutNotes | null }> {
  const options = resolveOptions(optionsInput);
  const pdf = await loadPdfDocument(file);
  if (pdf.numPages === 0) throw new Error("このPDFにはページがありません");
  const pageData: PageData[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 3); n++) {
    const page = await pdf.getPage(n);
    pageData.push({ pageNumber: n, page, items: await getPositionedTextItems(page), method: "text-layer", confidence: null });
  }
  if (!pageHasText(pageData[0].items)) return { pageCount: pdf.numPages, hasTextLayer: false, rows: [], layout: null };
  const textPages = pageData.filter((p) => pageHasText(p.items));
  const grids = await buildGrids(textPages, options, false);
  const sheets = assembleSheets(
    grids.filter((g): g is typeof g & { grid: PageGrid } => g.grid !== null).map((g) => ({ pageNumber: g.pageNumber, grid: g.grid })),
    false
  );
  const first = sheets[0];
  const rows = first
    ? first.rows.slice(0, FILE_PREVIEW_ROW_LIMIT).map((row) => gridRowToStrings(row, first.columnCount))
    : [];
  return { pageCount: pdf.numPages, hasTextLayer: true, rows, layout: summarizeLayout(grids) };
}

export class PdfToExcelProcessor extends BrowserProcessor<PdfToExcelInput, PdfToExcelOutput> {
  async process({ file, ocrLanguage, options: optionsInput, onPageProgress }: PdfToExcelInput): Promise<PdfToExcelOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }
    const options = resolveOptions(optionsInput);

    const pdf = await loadPdfDocument(file);
    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    if (pdf.numPages > MAX_PDF_TO_EXCEL_PAGES) {
      throw new Error(
        `変換できるページ数の上限は${MAX_PDF_TO_EXCEL_PAGES}ページです（このPDFは${pdf.numPages}ページあります）。ページ数を減らしてから再度お試しください。`
      );
    }

    const pages: PdfToExcelPageInfo[] = [];
    const ocrConfidences: number[] = [];
    const language = ocrLanguage ?? "ja+en";

    // Pass 1: 全ページの座標付きテキストを先に集める。複数ページにまたがる
    // 1つの表で、ページごとに列数・区切り位置がばらつかないようにするには
    // 列区切りを全ページの行をまとめて1回だけ推定する必要がある
    // (computeColumnBreaksAcrossPages)ため、ここでは各ページのテキスト取得・
    // 進捗通知・文字有無の判定のみ行い、表への再構築は Pass 2 (buildGrids) にまわす。
    const pageData: PageData[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages });

      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
      }

      let items = await getPositionedTextItems(page);
      let method: "text-layer" | "ocr" = "text-layer";
      let confidence: number | null = null;
      if (!pageHasText(items)) {
        // 文字情報を持たないページ（スキャン画像等）は、ページを画像化してOCRで文字と座標を取得する。
        // 全ページ分の画像を同時に保持せず、1ページずつ処理する。
        if (ocrConfidences.length >= MAX_OCR_PAGES) {
          throw new Error(
            `スキャン画像(文字情報のないページ)のOCR変換は最大${MAX_OCR_PAGES}ページまでです。ページ数を減らしてから再度お試しください。`
          );
        }
        method = "ocr";
        onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method, ocrProgress: 0 });
        let canvas: HTMLCanvasElement;
        try {
          canvas = (await renderPageToCanvas(page, OCR_RENDER_SCALE, MAX_OCR_DIMENSION)).canvas;
        } catch {
          throw new Error(`${pageNumber}ページ目の画像化に失敗しました`);
        }
        const result = await recognizeImageWithWords(canvas, language, (p) => {
          onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method, ocrProgress: p.progress });
        });
        confidence = result.confidence;
        ocrConfidences.push(result.confidence);
        items = ocrWordsToPositionedTextItems(result.words);
      }

      pageData.push({ pageNumber, page, items, method, confidence });
    }

    const built = await buildGrids(pageData, options, true);

    const gridsForSheet: { pageNumber: number; grid: PageGrid }[] = [];
    let totalRowCount = 0;
    for (const { pageNumber, method, confidence, grid } of built) {
      if (!grid || grid.rows.length === 0) {
        pages.push({ pageNumber, rowCount: 0, columnCount: 0, method, confidence });
        continue;
      }
      gridsForSheet.push({ pageNumber, grid });
      pages.push({ pageNumber, rowCount: grid.rows.length, columnCount: grid.columnCount, method, confidence });
      totalRowCount += grid.rows.length;
    }

    if (gridsForSheet.length === 0) {
      throw new Error(
        ocrConfidences.length > 0
          ? "スキャン画像から表として認識できる文字を読み取れませんでした。画像が鮮明か、傾きや影が大きくないかをご確認ください。"
          : "表として認識できる内容が見つかりませんでした。"
      );
    }

    const sheets = assembleSheets(gridsForSheet, options.sheetPerPage);
    const previewRows = sheets[0].rows
      .slice(0, PREVIEW_ROW_LIMIT)
      .map((row) => gridRowToStrings(row, sheets[0].columnCount));

    const { default: writeXlsxFile } = await import("write-excel-file/universal");
    let blob: Blob;
    try {
      const sheetDefs = sheets.map((sheet) => ({
        data: sheetToExcelRows(sheet),
        sheet: sheet.name,
        columns: computeColumnWidths(sheet),
        ...(sheet.stickyRows > 0 ? { stickyRowsCount: sheet.stickyRows } : {}),
      }));
      blob = await writeXlsxFile(sheetDefs).toBlob();
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
      usedOcr: ocrConfidences.length > 0,
      ocrAverageConfidence:
        ocrConfidences.length > 0 ? ocrConfidences.reduce((a, b) => a + b, 0) / ocrConfidences.length : null,
      layout: summarizeLayout(built),
    };
  }
}
