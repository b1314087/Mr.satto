import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { parseWorkbookPageSettings, type SheetPageSettings } from "@/lib/excel/ooxml-page-settings";
import { computePageGrid, type FitPageSettings } from "@/lib/excel/pagination";

/**
 * Excel（XLSX）→ PDF Processor（Phase 9、Phase 18.2 B節で大幅改修）。
 *
 * 対応形式は .xlsx のみ（■20・■35）。read-excel-file（Phase 2-Bで既に採用済み・
 * npm audit 0件）はセルの値のみを返し、印刷範囲・用紙サイズ・向き・余白・
 * Fit to Page・改ページ・非表示行列・セル罫線などの「印刷設定」は取得できない。
 * これらは src/lib/excel/ooxml-page-settings.ts がXLSX内部のOOXML XMLから
 * 直接読み取る（開発指示書B-19。新しい巨大なExcelライブラリは追加せず、
 * 既存のfflate(ZIP)とブラウザ標準DOMParserだけで完結させている）。
 *
 * 目標は「Excelの印刷設定でPDF保存したときの結果にできるだけ近づける」こと
 * （開発指示書B-1）であり、Microsoft Excelとの100%同一を保証するものではない
 * （開発指示書E章）。取得できなかった情報（列の結合・数式の再計算結果・
 * チャート/図形・セルの塗りつぶし色等）は無理に再現しない。
 */

const PAPER_SIZES_PT: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  A5: { width: 419.53, height: 595.28 },
};
const DEFAULT_PAPER_SIZE = "A4";
/** Excel側の余白情報が取得できない場合のフォールバック（既存Phase 9の値を踏襲） */
const DEFAULT_MARGIN_PT = 40;
const MAX_ROWS_TOTAL = 50000;
const MAX_PAGE_COUNT = 500;
const MIN_COL_WIDTH = 24;
const MAX_COL_WIDTH = 220;
const LINE_COLOR: [number, number, number] = [0.35, 0.35, 0.38];
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

/** 列ごとの内容量から列幅を近似する（Excel側の実際の列幅が取得できなかった列のフォールバック） */
function computeFallbackColumnWidths(rows: RawCellValue[][], colIndexes: number[], font: PDFFont, fontSize: number): number[] {
  const widths: number[] = new Array(colIndexes.length).fill(MIN_COL_WIDTH);
  const sampleRows = rows.slice(0, 200); // 巨大シートでの計測コストを抑える
  for (const row of sampleRows) {
    colIndexes.forEach((origCol, i) => {
      const text = cellToDisplayString(row[origCol] ?? null).slice(0, 80);
      if (text === "") return;
      const measured = font.widthOfTextAtSize(text, fontSize);
      widths[i] = Math.max(widths[i], measured);
    });
  }
  // +14: セル内側の左右余白(cellPadding=4pt×2辺=8pt)を確実に上回る余裕を持たせる
  return widths.map((w) => Math.min(Math.max(w + 14, MIN_COL_WIDTH), MAX_COL_WIDTH));
}

export type PageOrientation = "portrait" | "landscape";
/** "auto" = Excel自身のページ設定（取得できた場合）を優先する */
export type OrientationOption = "auto" | PageOrientation;
/**
 * "auto"      : ExcelのFit to Page / Scale設定をそのまま使う（取得できなければ自然な改ページ）
 * "fit-width" : 常に横1ページへ収める（Excelの設定が無い場合の簡易指定。旧仕様の「横幅に合わせる」相当）
 * "multi-page": 内容量なりに複数ページへ分ける（Excelの設定が無い場合の簡易指定。旧仕様のfitToWidth=false相当）
 */
export type FitOption = "auto" | "fit-width" | "multi-page";

export interface ExcelToPdfInput {
  /** OOXML印刷設定（印刷範囲・用紙・向き・余白・Fit to Page・改ページ・非表示行列・罫線）の解析に使う */
  file: File;
  sheets: RawExcelSheet[];
  selectedSheetNames: string[];
  orientation: OrientationOption;
  fitMode: FitOption;
  /** 先頭行を見出し行として各ページ上部に繰り返す */
  repeatHeaderRow: boolean;
}

export interface ExcelToPdfOutput extends PdfProcessorOutput {
  warnings: string[];
  sheetCount: number;
  totalRowCount: number;
}

function inchesToPt(inches: number): number {
  return inches * 72;
}

/** 元の行/列インデックス配列（印刷範囲・非表示行列を反映済み）から、
 *  OOXMLの改ページ位置（元インデックス基準）をローカルインデックス基準へ変換する */
function mapBreaksToLocalIndex(breaksAfterOriginal: number[], localToOriginal: number[]): Set<number> {
  const result = new Set<number>();
  for (const orig of breaksAfterOriginal) {
    // 改ページ位置そのものが非表示等で除外されている場合は、直前の含まれる行/列を区切りとみなす
    let localIdx = -1;
    for (let i = 0; i < localToOriginal.length; i++) {
      if (localToOriginal[i] <= orig) localIdx = i;
      else break;
    }
    if (localIdx >= 0) result.add(localIdx);
  }
  return result;
}

export class ExcelToPdfProcessor extends BrowserProcessor<ExcelToPdfInput, ExcelToPdfOutput> {
  async process({ file, sheets, selectedSheetNames, orientation, fitMode, repeatHeaderRow }: ExcelToPdfInput): Promise<ExcelToPdfOutput> {
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

    // Excel印刷設定の取得(取得できなければ空のMap。以後は全てフォールバックへ進む。開発指示書B-19)
    let pageSettingsBySheet: Map<string, SheetPageSettings>;
    try {
      pageSettingsBySheet = await parseWorkbookPageSettings(file);
    } catch {
      pageSettingsBySheet = new Map();
    }

    const warnings: string[] = [];

    /**
     * 1文字ずつdrawTextを呼び出す（Phase 9で判明した重要な問題への対処）。
     * pdf-lib+fontkitで、既存の日本語フォント資産(Noto Sans JP)をsubset:falseで
     * 埋め込んだ状態で、英字に数字が直接続く文字列を1回のdrawText呼び出しで
     * 描画すると、PDFのテキスト情報だけが無関係な文字に化ける現象への対処
     * （実機検証済み、Phase 9からの既存の対処をそのまま踏襲）。
     */
    function drawTextRobust(page: PDFPage, text: string, x: number, y: number, size: number, color: ReturnType<typeof rgb>, embedFont: PDFFont): number {
      let cx = x;
      for (const ch of Array.from(text)) {
        page.drawText(ch, { x: cx, y, size, font: embedFont, color });
        cx += embedFont.widthOfTextAtSize(ch, size);
      }
      return cx - x;
    }

    let sheetCount = 0;
    const sheetsToRender = targetSheets.filter((s) => {
      if (s.rows.length === 0) {
        warnings.push(`「${s.name}」は空のシートのため省略しました`);
        return false;
      }
      return true;
    });
    if (sheetsToRender.length === 0) {
      throw new Error("変換できる内容がありませんでした（選択したシートはすべて空です）。");
    }

    sheetsToRender.forEach((sheet) => {
      sheetCount++;
      const settings = pageSettingsBySheet.get(sheet.name) ?? null;

      // --- 1. 印刷範囲(B-5): Excel側で明示的に指定されていればその範囲だけを対象にする ---
      const totalColCount = Math.max(...sheet.rows.map((r) => r.length), 1);
      const rangeStartRow = settings?.printArea ? Math.max(0, settings.printArea.startRow) : 0;
      const rangeEndRow = settings?.printArea ? Math.min(sheet.rows.length - 1, settings.printArea.endRow) : sheet.rows.length - 1;
      const rangeStartCol = settings?.printArea ? Math.max(0, settings.printArea.startCol) : 0;
      const rangeEndCol = settings?.printArea ? Math.min(totalColCount - 1, settings.printArea.endCol) : totalColCount - 1;
      if (settings?.printArea) {
        warnings.push(`「${sheet.name}」はExcelの印刷範囲(${rangeStartRow + 1}〜${rangeEndRow + 1}行目)だけをPDF化しました`);
      }

      // --- 非表示行・列を除外(B-16) ---
      const localToOriginalRow: number[] = [];
      for (let r = rangeStartRow; r <= rangeEndRow; r++) {
        if (!settings?.hiddenRows.has(r)) localToOriginalRow.push(r);
      }
      const localToOriginalCol: number[] = [];
      for (let c = rangeStartCol; c <= rangeEndCol; c++) {
        if (!settings?.hiddenCols.has(c)) localToOriginalCol.push(c);
      }
      if (localToOriginalRow.length === 0 || localToOriginalCol.length === 0) {
        warnings.push(`「${sheet.name}」は印刷対象の行・列がありませんでした（印刷範囲・非表示設定をご確認ください）`);
        return;
      }

      // --- 2. 用紙サイズ・3. 向き(B-10/B-11) ---
      const effectiveOrientation: PageOrientation = orientation !== "auto" ? orientation : settings?.orientation ?? "portrait";
      const paperKey = settings?.paperSize ?? DEFAULT_PAPER_SIZE;
      const paper = PAPER_SIZES_PT[paperKey] ?? PAPER_SIZES_PT[DEFAULT_PAPER_SIZE];
      const pageWidth = effectiveOrientation === "landscape" ? paper.height : paper.width;
      const pageHeight = effectiveOrientation === "landscape" ? paper.width : paper.height;

      // --- 4. 余白(B-12) ---
      const marginLeft = settings?.margins ? inchesToPt(settings.margins.left) : DEFAULT_MARGIN_PT;
      const marginRight = settings?.margins ? inchesToPt(settings.margins.right) : DEFAULT_MARGIN_PT;
      const marginTop = settings?.margins ? inchesToPt(settings.margins.top) : DEFAULT_MARGIN_PT;
      const marginBottom = settings?.margins ? inchesToPt(settings.margins.bottom) : DEFAULT_MARGIN_PT;
      const contentWidth = Math.max(50, pageWidth - marginLeft - marginRight);
      // シート名の自動タイトル(旧titleBlock)を撤廃した(B-9)ため、その分の予約高さも
      // 差し引かない。これによりFit to Page計算がExcelの実際の余白設定とより一致する。
      const contentHeightForData = Math.max(50, pageHeight - marginTop - marginBottom);

      // --- 列幅: Excel実測値があれば使い、無ければ内容量から近似する ---
      const fallbackWidths = computeFallbackColumnWidths(sheet.rows, localToOriginalCol, font, 9);
      const colWidths = localToOriginalCol.map((origCol, i) => settings?.columnWidthsPt.get(origCol) ?? fallbackWidths[i]);

      // --- 5〜7. Fit to Width/Height/Scale(B-13/B-14) ---
      const fit: FitPageSettings =
        fitMode === "fit-width"
          ? { fitToPageEnabled: true, fitToWidth: 1, fitToHeight: null, scalePercent: null }
          : fitMode === "multi-page"
            ? { fitToPageEnabled: false, fitToWidth: null, fitToHeight: null, scalePercent: null }
            : {
                fitToPageEnabled: settings?.fitToPageEnabled ?? false,
                fitToWidth: settings?.fitToWidth ?? null,
                fitToHeight: settings?.fitToHeight ?? null,
                scalePercent: settings?.scalePercent ?? null,
              };

      const fontSize = 9;
      const cellPadding = 4;
      const lineHeight = fontSize + 3;

      // 行の高さ: Excel実測値があれば使い、無ければラップ後の行数から見積もる
      const rowHeights = localToOriginalRow.map((origRow) => {
        const known = settings?.rowHeightsPt.get(origRow);
        if (known) return known;
        const row = sheet.rows[origRow] ?? [];
        const lineCount = Math.max(
          1,
          ...localToOriginalCol.map((origCol, i) => wrapByWidth(cellToDisplayString(row[origCol] ?? null), font, fontSize, colWidths[i] - cellPadding * 2).length)
        );
        return lineCount * lineHeight + cellPadding * 2;
      });

      // 見出し行の繰り返し(repeatHeaderRow)は、印刷範囲の最初の行を毎ページの先頭に
      // 追加で描画する。ページ分割の計算(computePageGrid)へは見出し行を含めず、
      // その代わり見出し行の高さぶんを事前にcontentHeightから差し引いておくことで、
      // 「本文行を目一杯詰めてから見出し分だけページをはみ出す」事態を防ぐ
      // （開発指示書B-2〜B-4の「Excel印刷ページ=PDFページ」という前提を崩さないため）。
      const headerLocalRowIndex = repeatHeaderRow ? 0 : -1;
      const bodyLocalRowIndexes = repeatHeaderRow ? localToOriginalRow.map((_, i) => i).slice(1) : localToOriginalRow.map((_, i) => i);
      const bodyRowSizes = bodyLocalRowIndexes.map((i) => rowHeights[i]);
      const headerRowHeightPt = headerLocalRowIndex >= 0 ? rowHeights[headerLocalRowIndex] : 0;
      const contentHeightForBody = Math.max(20, contentHeightForData - headerRowHeightPt);

      // --- 8. 改ページ(B-15): 取得できれば反映、取得できなければ上記の自然な分割のまま ---
      const rowBreaksLocalAll = mapBreaksToLocalIndex(settings?.rowBreaksAfter ?? [], localToOriginalRow);
      // 見出し行を除いたbodyLocalRowIndexes基準のインデックスへ変換する
      const rowBreaksLocal = new Set(
        Array.from(rowBreaksLocalAll)
          .map((idx) => bodyLocalRowIndexes.indexOf(idx))
          .filter((idx) => idx >= 0)
      );
      const colBreaksLocal = mapBreaksToLocalIndex(settings?.colBreaksAfter ?? [], localToOriginalCol);

      const grid = computePageGrid({
        colSizesPt: colWidths,
        rowSizesPt: bodyRowSizes,
        contentWidthPt: contentWidth,
        contentHeightPt: contentHeightForBody,
        fit,
        colBreaksAfterIndex: colBreaksLocal,
        rowBreaksAfterIndex: rowBreaksLocal,
      });
      // grid.rowGroups の各要素は bodyLocalRowIndexes 配列内でのインデックスなので、
      // 描画時には元のローカル行インデックス（localToOriginalRow基準）へ戻す
      const rowGroupsInLocalRowIndex = grid.rowGroups.map((group) => group.map((i) => bodyLocalRowIndexes[i]));

      if (grid.colGroups.length * rowGroupsInLocalRowIndex.length > 1) {
        warnings.push(
          `「${sheet.name}」は${grid.colGroups.length}(横)×${rowGroupsInLocalRowIndex.length}(縦)ページに分割しました（Excelの印刷ページ数に合わせています）`
        );
      }

      function borderFor(origRow: number, origCol: number) {
        return settings?.cellBorders.get(`${origRow}:${origCol}`) ?? null;
      }

      function drawCellBorders(page: PDFPage, x: number, yTop: number, width: number, height: number, origRow: number, origCol: number, s: number) {
        const b = borderFor(origRow, origCol);
        if (!b) return;
        const yBottom = yTop - height;
        const color = rgb(...LINE_COLOR);
        const thickness = Math.max(0.4, 0.6 * s);
        if (b.top) page.drawLine({ start: { x, y: yTop }, end: { x: x + width, y: yTop }, thickness, color });
        if (b.bottom) page.drawLine({ start: { x, y: yBottom }, end: { x: x + width, y: yBottom }, thickness, color });
        if (b.left) page.drawLine({ start: { x, y: yBottom }, end: { x, y: yTop }, thickness, color });
        if (b.right) page.drawLine({ start: { x: x + width, y: yBottom }, end: { x: x + width, y: yTop }, thickness, color });
      }

      function drawRow(page: PDFPage, localRowIdx: number, colGroup: number[], top: number, isHeader: boolean) {
        const origRow = localToOriginalRow[localRowIdx];
        const row = sheet.rows[origRow] ?? [];
        const s = grid.scale;
        const rowH = rowHeights[localRowIdx] * s;
        let x = marginLeft;
        const color = isHeader ? rgb(...TEXT_COLOR) : rgb(...MUTED_COLOR);
        colGroup.forEach((localColIdx) => {
          const origCol = localToOriginalCol[localColIdx];
          const w = colWidths[localColIdx] * s;
          const text = cellToDisplayString(row[origCol] ?? null);
          const wrapped = wrapByWidth(text, font, fontSize * s, w - cellPadding * 2 * s);
          wrapped.slice(0, Math.max(1, Math.floor(rowH / (lineHeight * s)))).forEach((line, li) => {
            drawTextRobust(page, line, x + cellPadding * s, top - cellPadding * s - (li + 1) * lineHeight * s + 3 * s, fontSize * s, color, font);
          });
          drawCellBorders(page, x, top, w, rowH, origRow, origCol, s);
          x += w;
        });
        return top - rowH;
      }

      // --- ページ順序: Excelの既定(down, then over) = 同じ列グループ内で縦方向に進み、
      //     縦方向を使い切ってから次の列グループへ進む ---
      // シート名を自動でページ上部へ表示する処理(旧titleBlock)は、開発指示書B-9
      // (Phase 22)により撤廃した。「Excel側で設定されていないシート名をMr.Sattoが
      // 勝手にページへ追加しない」ことが「非常に重要」と明記されているため、
      // Excelの実際のHeader/Footer設定を取得できない現状の実装では、
      // 何も追加しない(=B-10「設定がなければ勝手に追加しない」を満たす)方を優先する。
      grid.colGroups.forEach((colGroup) => {
        rowGroupsInLocalRowIndex.forEach((rowGroup) => {
          if (doc.getPageCount() >= MAX_PAGE_COUNT) {
            throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
          }
          const page = doc.addPage([pageWidth, pageHeight]);
          let cursorY = pageHeight - marginTop;

          // 見出し行(headerLocalRowIndex)はページ分割の計算から除外しているため、
          // repeatHeaderRow有効時は毎ページ無条件で先頭に描画する。
          if (headerLocalRowIndex >= 0) {
            cursorY = drawRow(page, headerLocalRowIndex, colGroup, cursorY, true);
          }
          rowGroup.forEach((localRowIdx) => {
            cursorY = drawRow(page, localRowIdx, colGroup, cursorY, false);
          });
        });
      });
    });

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
