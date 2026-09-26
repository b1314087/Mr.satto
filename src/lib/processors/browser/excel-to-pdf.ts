import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";

/**
 * Excel（XLSX）→ PDF Processor（Phase 9）。
 *
 * 対応形式は .xlsx のみ（■20・■35）。read-excel-file（Phase 2-Bで既に採用済み・
 * npm audit 0件・xlsx(SheetJS)やexceljsを見送った経緯はcsv-excel.tsのコメントを
 * 参照）は旧形式の.xlsに対応しておらず(InvalidInputErrorCode: XLS_FILE_NOT_SUPPORTED)、
 * 安全に扱えることを確認できていないため、.xlsは対応外として明示する。
 *
 * 新しいExcelライブラリは追加しない。列幅・結合セル・数式の再計算結果・
 * チャート/図形など、read-excel-fileが取得できない情報は無理に再現しない
 * （■23・■26・■28・■29）。数式は再計算せず、保存済みの値をそのまま表示する。
 */

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 40;
const MAX_ROWS_TOTAL = 50000;
const MAX_PAGE_COUNT = 500;
const MIN_COL_WIDTH = 24;
const MAX_COL_WIDTH = 220;
const HEADER_BG: [number, number, number] = [0.93, 0.94, 0.96];
const LINE_COLOR: [number, number, number] = [0.78, 0.78, 0.8];
const TEXT_COLOR: [number, number, number] = [0.13, 0.13, 0.15];
const MUTED_COLOR: [number, number, number] = [0.45, 0.45, 0.48];

export type RawCellValue = string | number | boolean | Date | null;

export interface RawExcelSheet {
  name: string;
  rows: RawCellValue[][];
}

// ---------------------------------------------------------------------------
// シート一覧の読み込み（UIのシート選択チェックボックス用に1回だけ読む。
// 生成処理でも同じ結果を再利用し、二重読み込み・二重バッファ確保を避ける）
// ---------------------------------------------------------------------------
export async function readExcelSheets(file: File): Promise<RawExcelSheet[]> {
  const isXlsx =
    file.name.toLowerCase().endsWith(".xlsx") ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (!isXlsx) {
    throw new Error("Excelファイル(.xlsx)を選択してください。（.xls形式には対応していません）");
  }

  const { default: readXlsxFile } = await import("read-excel-file/universal");
  let sheetsData: { sheet: string; data: unknown[][] }[];
  try {
    sheetsData = await readXlsxFile(file);
  } catch (e) {
    const code = (e as { code?: string } | undefined)?.code;
    if (code === "XLS_FILE_NOT_SUPPORTED") {
      throw new Error("この形式(.xls)には対応していません。.xlsx形式で保存し直してからお試しください。");
    }
    throw new Error(
      `${file.name} の読み込みに失敗しました。Excelファイルが破損しているか、対応していない形式の可能性があります。`
    );
  }
  if (!sheetsData || sheetsData.length === 0) {
    throw new Error("このExcelファイルには読み取れるシートがありません");
  }
  return sheetsData.map((s) => ({ name: s.sheet, rows: s.data as RawCellValue[][] }));
}

function cellToDisplayString(value: RawCellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    const hh = value.getHours();
    const mm = value.getMinutes();
    const ss = value.getSeconds();
    const datePart = `${y}-${m}-${d}`;
    if (hh === 0 && mm === 0 && ss === 0) return datePart;
    return `${datePart} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // 文字列として保存されている「先頭ゼロ」等の値は、read-excel-fileが返した
  // 型(string)をそのまま尊重する（勝手にNumber()変換しない）。
  return String(value);
}

function wrapByWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const candidate = current + ch;
      if (current !== "" && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/** 列ごとの内容量から列幅を決める（read-excel-fileは実際の列幅を提供しないため、
 *  代わりにセル内容の実測フォント幅から近似値を求める）。
 *
 * 以前は文字数×係数という単純な近似だったが、日本語（全角・fontSizeとほぼ同じ幅）と
 * 半角の数字・英字（全角の半分程度の幅）が同じ列に混在するケース
 * （例:「郵便番号」という見出しと「00123」という値）で、文字数だけでは
 * 幅を大きく見誤り、セル内で文字が不自然に途中改行される不具合があった。
 * そのため、実際にPDF埋め込みフォントの widthOfTextAtSize() で計測した
 * 文字列の実測幅の最大値を使う。 */
function computeColumnWidths(rows: RawCellValue[][], colCount: number, font: PDFFont, fontSize: number): number[] {
  const widths: number[] = new Array(colCount).fill(MIN_COL_WIDTH);
  const sampleRows = rows.slice(0, 200); // 巨大シートでの計測コストを抑える
  for (const row of sampleRows) {
    for (let c = 0; c < colCount; c++) {
      const text = cellToDisplayString(row[c] ?? null).slice(0, 80);
      if (text === "") continue;
      const measured = font.widthOfTextAtSize(text, fontSize);
      widths[c] = Math.max(widths[c], measured);
    }
  }
  // +14: セル内側の左右余白(cellPadding=4pt×2辺=8pt)を確実に上回る余裕を持たせ、
  // ぴったりの幅で実測した文字列が1文字だけ折り返される事態を防ぐ。
  return widths.map((w) => Math.min(Math.max(w + 14, MIN_COL_WIDTH), MAX_COL_WIDTH));
}

/** 列を「1ページの横幅に収まる列グループ」へ分割する（fitToWidth=falseのとき、
 *  Excel実機の「複数ページに分けて印刷」に近い挙動になる） */
function splitIntoColumnGroups(widths: number[], contentWidth: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let currentWidth = 0;
  widths.forEach((w, idx) => {
    if (current.length > 0 && currentWidth + w > contentWidth) {
      groups.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push(idx);
    currentWidth += w;
  });
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [widths.map((_, i) => i)];
}

export type PageOrientation = "portrait" | "landscape";

export interface ExcelToPdfInput {
  sheets: RawExcelSheet[];
  selectedSheetNames: string[];
  orientation: PageOrientation;
  /** true: 列幅を縮小してでも1ページ幅に収める / false: 内容量に応じた幅を優先し、
   *  収まらない場合は列を複数ページグループへ分割する */
  fitToWidth: boolean;
  /** 先頭行を見出し行として各ページ上部に繰り返す */
  repeatHeaderRow: boolean;
}

export interface ExcelToPdfOutput extends PdfProcessorOutput {
  warnings: string[];
  sheetCount: number;
  totalRowCount: number;
}

export class ExcelToPdfProcessor extends BrowserProcessor<ExcelToPdfInput, ExcelToPdfOutput> {
  async process({
    sheets,
    selectedSheetNames,
    orientation,
    fitToWidth,
    repeatHeaderRow,
  }: ExcelToPdfInput): Promise<ExcelToPdfOutput> {
    const targetSheets = sheets.filter((s) => selectedSheetNames.includes(s.name));
    if (targetSheets.length === 0) {
      throw new Error("変換するシートを1つ以上選択してください。");
    }

    const totalRows = targetSheets.reduce((sum, s) => sum + s.rows.length, 0);
    if (totalRows > MAX_ROWS_TOTAL) {
      throw new Error(
        `変換できる行数の上限は合計${MAX_ROWS_TOTAL.toLocaleString()}行です（選択中のシートは合計${totalRows.toLocaleString()}行あります）。シートの選択数を減らすか、行数を減らしてからお試しください。`
      );
    }

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }

    let doc: PDFDocument;
    let font: PDFFont;
    try {
      doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    const pageWidth = orientation === "landscape" ? A4_HEIGHT : A4_WIDTH;
    const pageHeight = orientation === "landscape" ? A4_WIDTH : A4_HEIGHT;
    const contentWidth = pageWidth - MARGIN * 2;
    const bottomLimit = MARGIN + 16;

    const warnings: string[] = [];
    let page: PDFPage = doc.addPage([pageWidth, pageHeight]);
    let cursorY = pageHeight - MARGIN;

    function newPage() {
      if (doc.getPageCount() >= MAX_PAGE_COUNT) {
        throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
      }
      page = doc.addPage([pageWidth, pageHeight]);
      cursorY = pageHeight - MARGIN;
    }

    function ensureSpace(height: number) {
      if (cursorY - height < bottomLimit) newPage();
    }

    /**
     * 1文字ずつdrawTextを呼び出す（Phase 9で判明した重要な問題への対処）。
     *
     * pdf-lib（内部でfontkitのfont.layout()を使用）に、既存の日本語フォント資産
     * (Noto Sans JP)をsubset:falseで埋め込んだ状態で、英字に数字が直接続く文字列
     * （例:"Sheet1"「A9」等。日本語+数字や、数字だけの文字列では発生しない）を
     * 1回のdrawText呼び出しで描画すると、表示される見た目（グリフの形）自体は
     * 正しいまま保たれる一方で、PDFのテキスト情報（ToUnicode、コピー&ペースト・
     * 検索・スクリーンリーダー等が参照する文字情報）だけが無関係な文字に化ける、
     * という現象を実機検証で発見した（pdf-lib/fontkit側の挙動に起因する既存の
     * 制約で、Phase 9で新たに埋め込みロジックを変えたことによる問題ではない）。
     * 1文字ずつ描画すると、1回のdrawText呼び出しの中で複数文字にまたがる
     * 変換が発生しないため、この問題を回避できる（実機検証済み）。
     * Excelの既定のシート名(Sheet1等)はこのパターンに該当するため、この
     * ツールで実際に発生しうる不具合として、表示される文字列すべてに適用する。
     */
    function drawTextRobust(text: string, x: number, y: number, size: number, color: ReturnType<typeof rgb>): number {
      let cx = x;
      for (const ch of Array.from(text)) {
        page.drawText(ch, { x: cx, y, size, font, color });
        cx += font.widthOfTextAtSize(ch, size);
      }
      return cx - x;
    }

    function drawSheetTitle(name: string) {
      ensureSpace(24);
      drawTextRobust(name, MARGIN, cursorY - 14, 13, rgb(...TEXT_COLOR));
      cursorY -= 26;
    }

    function drawColumnGroup(rows: RawCellValue[][], colIndexes: number[], widths: number[], sheetHasHeader: boolean) {
      const fontSize = fitToWidth ? computeFitFontSize(widths, contentWidth) : 9;
      const cellPadding = 4;
      const lineHeight = fontSize + 3;

      function drawHeaderRow(headerRow: RawCellValue[]) {
        const wrapped = colIndexes.map((c, i) =>
          wrapByWidth(cellToDisplayString(headerRow[c] ?? null), font, fontSize, widths[i] - cellPadding * 2)
        );
        const lineCount = Math.max(1, ...wrapped.map((w) => w.length));
        const rowHeight = lineCount * lineHeight + cellPadding * 2;
        ensureSpace(rowHeight);
        const top = cursorY;
        let x = MARGIN;
        colIndexes.forEach((_, i) => {
          page.drawRectangle({ x, y: top - rowHeight, width: widths[i], height: rowHeight, color: rgb(...HEADER_BG) });
          page.drawRectangle({
            x,
            y: top - rowHeight,
            width: widths[i],
            height: rowHeight,
            borderColor: rgb(...LINE_COLOR),
            borderWidth: 0.6,
          });
          wrapped[i].forEach((line, li) => {
            drawTextRobust(line, x + cellPadding, top - cellPadding - (li + 1) * lineHeight + 3, fontSize, rgb(...TEXT_COLOR));
          });
          x += widths[i];
        });
        cursorY = top - rowHeight;
      }

      const startRow = sheetHasHeader && repeatHeaderRow ? 1 : 0;
      if (sheetHasHeader && repeatHeaderRow && rows[0]) {
        drawHeaderRow(rows[0]);
      }

      for (let r = startRow; r < rows.length; r++) {
        const row = rows[r];
        const wrapped = colIndexes.map((c, i) =>
          wrapByWidth(cellToDisplayString(row[c] ?? null), font, fontSize, widths[i] - cellPadding * 2)
        );
        const lineCount = Math.max(1, ...wrapped.map((w) => w.length));
        const rowHeight = lineCount * lineHeight + cellPadding * 2;

        const beforeBreakY = cursorY;
        ensureSpace(rowHeight);
        if (cursorY !== beforeBreakY && sheetHasHeader && repeatHeaderRow && rows[0]) {
          drawHeaderRow(rows[0]);
        }

        const top = cursorY;
        let x = MARGIN;
        colIndexes.forEach((_, i) => {
          page.drawRectangle({
            x,
            y: top - rowHeight,
            width: widths[i],
            height: rowHeight,
            borderColor: rgb(...LINE_COLOR),
            borderWidth: 0.6,
          });
          wrapped[i].forEach((line, li) => {
            drawTextRobust(line, x + cellPadding, top - cellPadding - (li + 1) * lineHeight + 3, fontSize, rgb(...MUTED_COLOR));
          });
          x += widths[i];
        });
        cursorY = top - rowHeight;
      }
      cursorY -= 10;
    }

    function computeFitFontSize(widths: number[], maxTotal: number): number {
      const total = widths.reduce((a, b) => a + b, 0);
      if (total <= maxTotal) return 9;
      const ratio = maxTotal / total;
      return Math.max(6, Math.round(9 * ratio * 10) / 10);
    }

    let sheetCount = 0;
    const sheetsToRender = targetSheets.filter((s) => {
      if (s.rows.length === 0) {
        warnings.push(`「${s.name}」は空のシートのため省略しました`);
        return false;
      }
      return true;
    });

    sheetsToRender.forEach((sheet, sheetIdx) => {
      if (sheetIdx > 0) newPage();
      sheetCount++;
      drawSheetTitle(sheet.name);

      const colCount = Math.max(...sheet.rows.map((r) => r.length), 1);
      let widths = computeColumnWidths(sheet.rows, colCount, font, 9);

      if (fitToWidth) {
        const total = widths.reduce((a, b) => a + b, 0);
        if (total > contentWidth) {
          const scale = contentWidth / total;
          widths = widths.map((w) => Math.max(w * scale, 4));
        }
        drawColumnGroup(sheet.rows, widths.map((_, i) => i), widths, true);
      } else {
        const groups = splitIntoColumnGroups(widths, contentWidth);
        if (groups.length > 1) {
          warnings.push(
            `「${sheet.name}」は列数が多いため、列を${groups.length}つのグループに分けて出力しました（Excel印刷の複数ページ分割に相当）`
          );
        }
        groups.forEach((colIndexes, groupIdx) => {
          if (groupIdx > 0) newPage();
          const groupWidths = colIndexes.map((c) => widths[c]);
          drawColumnGroup(sheet.rows, colIndexes, groupWidths, true);
        });
      }
    });

    if (sheetsToRender.length === 0) {
      throw new Error("変換できる内容がありませんでした（選択したシートはすべて空です）。");
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return {
      blob,
      url: URL.createObjectURL(blob),
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
      warnings: Array.from(new Set(warnings)),
      sheetCount,
      totalRowCount: totalRows,
    };
  }
}
