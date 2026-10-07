import {
  clip,
  endPath,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setLineWidth,
  setStrokingRgbColor,
  setTextRenderingMode,
  TextRenderingMode,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { parseWorkbookPageSettings, type CellRangeRef, type SheetPageSettings } from "@/lib/excel/ooxml-page-settings";
import { formatExcelDate } from "@/lib/excel/excel-date-format";
import { formatExcelNumber } from "@/lib/excel/excel-number-format";
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
 * チャート/図形等）は無理に再現しない。
 *
 * セルの背景色・文字色・太字（外出先PC修正指示書§29-31）: 以前のバージョンは
 * これらを一切読み取らずLINE_COLOR/TEXT_COLOR/MUTED_COLORの3色固定で描画していた
 * （＝Excel側でどんな色を設定してもPDFには反映されなかった）。styles.xmlの
 * <fills>/<fonts>と各セルのスタイル番号(s属性)から、ooxml-page-settings.ts
 * (parseCellStyles)が実際の背景色(patternType="solid"のfgColorのみ対応)・
 * 文字色・太字を解決するようにし、ここではその結果をセル背景の矩形描画・
 * 文字色・疑似ボールド(word-to-pdf.tsと同じFillAndOutlineによる近似。太字専用の
 * フォント資産が無いため)へ反映する。indexed color・theme colorによる色指定、
 * パターン塗りつぶし(縞模様等)は今回は対象外（明示的なrgb値を持つ色のみ対応）。
 *
 * 結合セル・配置・文字サイズ・日付の表示書式・行の標準の高さ（外出先PC修正指示書
 * 「Excel→PDFがまだ綺麗に反映できていない」対応）: 以前のバージョンはこれらを
 * 一切読み取らず、(1)結合セル(A1:J1等)の中央揃えタイトルが最初の1セル分の幅で
 * 切れる、(2)全セル9ptの左上揃えで見出し(14pt・12pt)の大きさも中央/右揃えも
 * 反映されない、(3)日付が「2026-09-25 09:00:00」のように日本時間でずれた形式に
 * なる、(4)行に高さが保存されていない行がExcelの標準の高さより高く見積もられ、
 * 表全体が縦に伸びてページ下端からはみ出す、という状態だった。
 * ooxml-page-settings.tsが<mergeCells>・<alignment>・フォントのsz・numFmt・
 * sheetFormatPr@defaultRowHeightを読み取り、ここでそれを描画へ反映する。
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

function cellToDisplayString(
  value: RawCellValue,
  dateFormatCode: string | null = null,
  numFormatCode: string | null = null
): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // read-excel-fileはExcelの日付をUTC基準のDateで返す。ローカル時刻(getHours等)で読むと
    // 日本時間では9時間ずれて「09:00:00」が付いてしまうため、UTCで読み、Excelの表示書式で整形する。
    return formatExcelDate(value, dateFormatCode);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // 数値はExcelの表示書式(桁区切り・小数桁・%・通貨記号など)で整形する。解釈できない書式は元の値のまま。
  if (typeof value === "number" && numFormatCode) {
    const formatted = formatExcelNumber(value, numFormatCode);
    if (formatted !== null) return formatted;
  }
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

export interface ExcelToPdfOutput extends Omit<PdfProcessorOutput, "url"> {
  warnings: string[];
  sheetCount: number;
  totalRowCount: number;
}

function inchesToPt(inches: number): number {
  return inches * 72;
}

/** "#RRGGBB" を pdf-lib の rgb() が使う0〜1範囲へ変換する（開発指示書§29-31） */
function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return TEXT_COLOR;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
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

    // ヘッダー/フッター(B-9・B-10)の&D(日付)・&T(時刻)トークン解決用に、
    // 変換実行時刻を1回だけ取得する(ページごとに変わると使いにくいため)。
    const now = new Date();
    const nowDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const nowTimeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

    /**
     * ooxml-page-settings.tsが返すヘッダー/フッター文字列内の{{PAGE}}等の
     * プレースホルダーを、実際の値へ解決する(B-9・B-10)。&P(ページ番号)・
     * &N(総ページ数)はページ分割が確定するここでしか分からないため、
     * シートごとの描画ループの中で解決する。
     */
    function resolveHeaderFooterTokens(text: string, ctx: { pageInSheet: number; totalPagesInSheet: number; sheetName: string }): string {
      return text
        .replace(/\{\{PAGE\}\}/g, String(ctx.pageInSheet))
        .replace(/\{\{PAGES\}\}/g, String(ctx.totalPagesInSheet))
        .replace(/\{\{DATE\}\}/g, nowDateStr)
        .replace(/\{\{TIME\}\}/g, nowTimeStr)
        .replace(/\{\{SHEET\}\}/g, ctx.sheetName)
        .replace(/\{\{FILE\}\}/g, file.name);
    }

    /**
     * 1文字ずつdrawTextを呼び出す（Phase 9で判明した重要な問題への対処）。
     * pdf-lib+fontkitで、既存の日本語フォント資産(Noto Sans JP)をsubset:falseで
     * 埋め込んだ状態で、英字に数字が直接続く文字列を1回のdrawText呼び出しで
     * 描画すると、PDFのテキスト情報だけが無関係な文字に化ける現象への対処
     * （実機検証済み、Phase 9からの既存の対処をそのまま踏襲）。
     */
    function drawTextRobust(
      page: PDFPage,
      text: string,
      x: number,
      y: number,
      size: number,
      color: ReturnType<typeof rgb>,
      embedFont: PDFFont,
      bold = false
    ): number {
      // 太字フォント資産は無い(既存資産はNoto Sans JP Regularのみ)ため、word-to-pdf.tsと
      // 同じ「塗り+縁取り(FillAndOutline)」による疑似ボールドで近似する(開発指示書§29-31)。
      if (bold) {
        page.pushOperators(
          setLineWidth(size * 0.028),
          setStrokingRgbColor(color.red, color.green, color.blue),
          setTextRenderingMode(TextRenderingMode.FillAndOutline)
        );
      }
      let cx = x;
      for (const ch of Array.from(text)) {
        page.drawText(ch, { x: cx, y, size, font: embedFont, color });
        cx += embedFont.widthOfTextAtSize(ch, size);
      }
      if (bold) {
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
      }
      return cx - x;
    }

    /**
     * ヘッダー/フッターの左/中央/右セクションを1行で描画する(B-9・B-10)。
     * Excel側で実際に設定されている場合のみ呼び出す側で呼ぶため、ここでは
     * 「与えられたセクションをそのまま描く」ことだけに責務を絞っている。
     */
    function drawHeaderFooterSections(
      page: PDFPage,
      sections: { left: string; center: string; right: string },
      baselineY: number,
      areaLeft: number,
      areaRight: number,
      embedFont: PDFFont
    ) {
      const size = 8;
      const color = rgb(...MUTED_COLOR);
      if (sections.left) {
        drawTextRobust(page, sections.left, areaLeft, baselineY, size, color, embedFont);
      }
      if (sections.center) {
        const w = embedFont.widthOfTextAtSize(sections.center, size);
        drawTextRobust(page, sections.center, areaLeft + (areaRight - areaLeft - w) / 2, baselineY, size, color, embedFont);
      }
      if (sections.right) {
        const w = embedFont.widthOfTextAtSize(sections.right, size);
        drawTextRobust(page, sections.right, areaRight - w, baselineY, size, color, embedFont);
      }
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
      // read-excel-fileは末尾の空行・空列(値が無いセル)を返さないが、罫線や背景色だけが設定された
      // セルはExcelでは印刷される(例: 表の最終行の下罫線が、値の無い最後の行にだけ引かれている)。
      // 印刷範囲が指定されている場合は、書式が設定されたセルの範囲までを描画対象に含める。
      let styledLastRow = -1;
      let styledLastCol = -1;
      for (const map of [settings?.cellBorders, settings?.cellFills]) {
        if (!map) continue;
        for (const key of map.keys()) {
          const [r, c] = key.split(":").map(Number);
          if (r > styledLastRow) styledLastRow = r;
          if (c > styledLastCol) styledLastCol = c;
        }
      }
      const contentLastRow = Math.max(sheet.rows.length - 1, styledLastRow);
      const contentLastCol = Math.max(totalColCount - 1, styledLastCol);
      const rangeStartRow = settings?.printArea ? Math.max(0, settings.printArea.startRow) : 0;
      const rangeEndRow = settings?.printArea ? Math.min(contentLastRow, settings.printArea.endRow) : sheet.rows.length - 1;
      const rangeStartCol = settings?.printArea ? Math.max(0, settings.printArea.startCol) : 0;
      const rangeEndCol = settings?.printArea ? Math.min(contentLastCol, settings.printArea.endCol) : totalColCount - 1;
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

      // 文字サイズ: セルごとの実際のサイズ(styles.xmlのfonts[]のsz)を使う。取得できなければ
      // ブック既定フォントのサイズ、それも無ければ従来どおり9pt。
      const fallbackFontSize = 9;
      const defaultFontSize = settings?.defaultFontSizePt ?? fallbackFontSize;
      const cellPadding = 4;
      const defaultRowPt = settings?.defaultRowHeightPt ?? null;

      function fontSizeFor(origRow: number, origCol: number): number {
        return settings?.cellFontSizePt.get(`${origRow}:${origCol}`) ?? defaultFontSize;
      }
      /** 1行ぶんの高さ。Excelの標準の行の高さ(defaultRowHeight)があれば文字サイズに比例させ、無ければ従来の「文字サイズ+3」 */
      function lineHeightFor(fs: number): number {
        return defaultRowPt ? (defaultRowPt * fs) / defaultFontSize : fs + 3;
      }
      function cellDisplayText(row: RawCellValue[], origRow: number, origCol: number): string {
        return cellToDisplayString(
          row[origCol] ?? null,
          settings?.cellDateFormat.get(`${origRow}:${origCol}`) ?? null,
          settings?.cellNumFormat.get(`${origRow}:${origCol}`) ?? null
        );
      }

      // --- 結合セル: アンカー(左上)セルの文字を結合範囲全体にまたがって描画する ---
      const mergeByCell = new Map<string, { range: CellRangeRef; isAnchor: boolean }>();
      for (const range of settings?.merges ?? []) {
        // 極端に巨大な結合範囲(列全体・シート全体等)は、セルごとの索引を作るコストが
        // 大きいため対象外とする(通常の帳票の結合セルは数十セル程度)。
        if ((range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > 20000) continue;
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            mergeByCell.set(`${r}:${c}`, { range, isAnchor: r === range.startRow && c === range.startCol });
          }
        }
      }

      // 行の高さ: Excel実測値があれば使い、無ければラップ後の行数から見積もる。
      // 結合セルの文字は、Excelでも行の自動の高さには影響しない(結合セルは自動調整の対象外)ため除外する。
      const rowHeights = localToOriginalRow.map((origRow) => {
        const known = settings?.rowHeightsPt.get(origRow);
        if (known) return known;
        const row = sheet.rows[origRow] ?? [];
        let needed = 0;
        localToOriginalCol.forEach((origCol, i) => {
          if (mergeByCell.has(`${origRow}:${origCol}`)) return;
          const text = cellDisplayText(row, origRow, origCol);
          if (text === "") return;
          const fs = fontSizeFor(origRow, origCol);
          const wrap = settings?.cellAlign.get(`${origRow}:${origCol}`)?.wrapText ?? false;
          const lineCount = wrap ? wrapByWidth(text, font, fs, colWidths[i] - cellPadding * 2).length : 1;
          needed = Math.max(needed, lineCount * lineHeightFor(fs));
        });
        // 標準の行の高さが取得できた場合はそれを下限にする(Excelは何も保存されていない行を標準の高さで描く)。
        // 取得できない場合は従来の見積もり(行数×行の高さ+上下の余白)を維持する。
        if (defaultRowPt) return Math.max(defaultRowPt, needed);
        return Math.max(1, needed / lineHeightFor(defaultFontSize)) * lineHeightFor(defaultFontSize) + cellPadding * 2;
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
      function fillFor(origRow: number, origCol: number): string | null {
        return settings?.cellFills.get(`${origRow}:${origCol}`) ?? null;
      }
      function fontColorFor(origRow: number, origCol: number): string | null {
        return settings?.cellFontColors.get(`${origRow}:${origCol}`) ?? null;
      }
      function boldFor(origRow: number, origCol: number): boolean {
        return settings?.cellBold.get(`${origRow}:${origCol}`) ?? false;
      }

      function drawCellFill(page: PDFPage, x: number, yTop: number, width: number, height: number, origRow: number, origCol: number) {
        const fill = fillFor(origRow, origCol);
        if (!fill) return;
        page.drawRectangle({ x, y: yTop - height, width, height, color: rgb(...hexToRgb01(fill)) });
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

      /** テキスト行(1行ぶん)を、指定の横揃えで描く。textWidthは行の描画幅 */
      function lineStartX(h: "left" | "center" | "right", boxX: number, boxW: number, textW: number, pad: number): number {
        if (h === "center") return boxX + (boxW - textW) / 2;
        if (h === "right") return boxX + boxW - pad - textW;
        return boxX + pad;
      }

      /**
       * ページ内の全セルの背景色を、文字より先にまとめて塗る。セルごとに「塗る→文字」を繰り返すと、
       * 結合セルの文字(右隣・下隣のセルへまたがる部分)を、後から塗る隣のセルの背景色が上から隠してしまう。
       */
      function drawPageFills(page: PDFPage, colGroup: number[], rowsOnPage: number[], startTop: number, startX: number) {
        let top = startTop;
        const s = grid.scale;
        for (const localRowIdx of rowsOnPage) {
          const origRow = localToOriginalRow[localRowIdx];
          const rowH = rowHeights[localRowIdx] * s;
          let fx = startX;
          for (const localColIdx of colGroup) {
            const origCol = localToOriginalCol[localColIdx];
            const w = colWidths[localColIdx] * s;
            drawCellFill(page, fx, top, w, rowH, origRow, origCol);
            fx += w;
          }
          top -= rowH;
        }
      }

      /**
       * rowGroupLocalIdxs: このページに描画する行(localToOriginalRow基準のローカル行番号)。
       * 縦方向に結合されたセルの高さを、ページ内に実際に含まれる行だけで合計するために使う。
       */
      function drawRow(
        page: PDFPage,
        localRowIdx: number,
        colGroup: number[],
        top: number,
        isHeader: boolean,
        rowGroupLocalIdxs: number[],
        startX: number
      ) {
        const origRow = localToOriginalRow[localRowIdx];
        const row = sheet.rows[origRow] ?? [];
        const s = grid.scale;
        const rowH = rowHeights[localRowIdx] * s;
        const pad = cellPadding * s;
        let x = startX;
        // 既定の文字色: Excelの「自動」(黒)。以前は本文を薄いグレーで描いていた
        void isHeader;
        const color = rgb(...TEXT_COLOR);
        // 背景色は、ページ全体ぶんを先にまとめて塗ってある(drawPageFills)。
        colGroup.forEach((localColIdx, groupPos) => {
          const origCol = localToOriginalCol[localColIdx];
          const key = `${origRow}:${origCol}`;
          const w = colWidths[localColIdx] * s;

          // 結合セル: アンカー以外は文字を描かない。アンカーは結合範囲(このページに含まれる分)全体を文字の領域にする。
          const merge = mergeByCell.get(key);
          let boxW = w;
          let boxH = rowH;
          let drawText = true;
          if (merge) {
            if (!merge.isAnchor) {
              drawText = false;
            } else {
              boxW = colGroup.reduce((sum, lc) => {
                const oc = localToOriginalCol[lc];
                return oc >= merge.range.startCol && oc <= merge.range.endCol ? sum + colWidths[lc] * s : sum;
              }, 0);
              boxH = rowGroupLocalIdxs.reduce((sum, lr) => {
                const orow = localToOriginalRow[lr];
                return orow >= merge.range.startRow && orow <= merge.range.endRow ? sum + rowHeights[lr] * s : sum;
              }, 0);
            }
          }

          const text = drawText ? cellDisplayText(row, origRow, origCol) : "";
          if (text !== "") {
            const value = row[origCol] ?? null;
            const align = settings?.cellAlign.get(key) ?? null;
            let fs = fontSizeFor(origRow, origCol) * s;
            const lh = lineHeightFor(fontSizeFor(origRow, origCol)) * s;
            const wrap = align?.wrapText ?? false;
            // 「縮小して全体を表示」のセルは幅が狭いことが多い(1文字ぶんの欄など)ため、左右の余白を小さくして文字を大きく保つ
            const padH = align?.shrinkToFit ? Math.min(pad, 1.5 * s) : pad;
            // 横揃えの既定(general): 文字は左、数値・日付は右(Excelと同じ)
            const horizontalRaw = align?.horizontal ?? (typeof value === "number" || value instanceof Date ? "right" : "left");
            // 均等割り付け(distributed)は、文字を領域の幅いっぱいに均等に並べる(下の描画で処理する)。ここでは左寄せ扱い。
            const distributed = horizontalRaw === "distributed";
            const horizontal: "left" | "center" | "right" = distributed ? "left" : horizontalRaw;
            const vertical = align?.vertical ?? "bottom"; // Excelの既定の縦位置は「下揃え」

            let lines: string[];
            // 折り返さないセルで文字が描画領域に収まらないとき、文字は削らず全文を描き、はみ出し部分だけクリップで隠す
            // (Excelの表示と同じ。文字そのものはPDFに残るので、検索・コピーでも欠けない)。
            let clipWidth: number | null = null;
            if (wrap) {
              lines = wrapByWidth(text, font, fs, boxW - padH * 2);
            } else {
              // 折り返さないセルは1行で描く。左揃えの文字は、右隣の空セルへはみ出して表示される(Excelと同じ)。
              let avail = boxW - padH * 2;
              if (!merge && horizontal === "left") {
                for (let gp = groupPos + 1; gp < colGroup.length; gp++) {
                  const nextOrigCol = localToOriginalCol[colGroup[gp]];
                  if (cellDisplayText(row, origRow, nextOrigCol) !== "" || mergeByCell.has(`${origRow}:${nextOrigCol}`)) break;
                  avail += colWidths[colGroup[gp]] * s;
                }
              }
              const oneLine = text.replace(/\r\n|\r|\n/g, " ");
              lines = [oneLine];
              const oneLineW = font.widthOfTextAtSize(oneLine, fs);
              if (oneLineW > avail && align?.shrinkToFit && avail > 0) {
                // 「縮小して全体を表示」: セルの幅に収まるよう文字を小さくする(Excelと同じ。小さくしすぎないよう下限あり)
                fs = Math.max(fs * 0.3, (fs * avail) / oneLineW);
              }
              if (font.widthOfTextAtSize(oneLine, fs) > avail + 0.01) clipWidth = avail;
            }

            const fits = Math.max(1, Math.floor(boxH / lh));
            const visible = lines.slice(0, fits);
            const blockH = visible.length * lh;
            let blockTop: number;
            if (blockH >= boxH - pad || vertical === "top") blockTop = top - (vertical === "top" ? pad : 0);
            else if (vertical === "center") blockTop = top - (boxH - blockH) / 2;
            else blockTop = top - boxH + pad + blockH;

            const explicitFontColor = fontColorFor(origRow, origCol);
            const cellColor = explicitFontColor ? rgb(...hexToRgb01(explicitFontColor)) : color;
            const cellBoldFlag = boldFor(origRow, origCol);
            if (clipWidth !== null) {
              // クリップ範囲はセルの左端(x)から、文字領域の右端(左右の余白ぶんを含む)まで。
              // 余白ぶんを含めないと、右揃えの文字(例: 幅の狭いセルの「年」「月」)の端が欠ける。
              page.pushOperators(pushGraphicsState(), rectangle(x, top - boxH, clipWidth + padH, boxH), clip(), endPath());
            }
            visible.forEach((line, li) => {
              const lineW = font.widthOfTextAtSize(line, fs);
              const baseline = blockTop - li * lh - (lh - fs) / 2 - 0.88 * fs;
              const chars = Array.from(line);
              if (distributed && !wrap && chars.length > 1 && lineW < boxW - padH * 2) {
                // 均等割り付け: 文字の間隔を均等にあけて、領域の幅いっぱいに並べる
                const gap = (boxW - padH * 2 - lineW) / (chars.length - 1);
                let cx = x + padH;
                for (const ch of chars) {
                  drawTextRobust(page, ch, cx, baseline, fs, cellColor, font, cellBoldFlag);
                  cx += font.widthOfTextAtSize(ch, fs) + gap;
                }
              } else {
                drawTextRobust(page, line, lineStartX(horizontal, x, boxW, lineW, padH), baseline, fs, cellColor, font, cellBoldFlag);
              }
            });
            if (clipWidth !== null) page.pushOperators(popGraphicsState());
          }
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
      // シート名は表示しない。一方でExcel側に実際のHeader/Footer設定(&L/&C/&R)が
      // 存在する場合はB-10に基づきそれを反映する(settings?.header/footerは
      // Excel側で明示的に設定されている場合のみ値を持つため、これを描画しても
      // B-9「勝手にシート名を追加しない」とは矛盾しない)。
      const totalPagesForSheet = grid.colGroups.length * rowGroupsInLocalRowIndex.length;
      let pageInSheet = 0;
      const headerMarginPt = settings?.margins ? inchesToPt(settings.margins.header) : DEFAULT_MARGIN_PT / 2;
      const footerMarginPt = settings?.margins ? inchesToPt(settings.margins.footer) : DEFAULT_MARGIN_PT / 2;

      grid.colGroups.forEach((colGroup) => {
        rowGroupsInLocalRowIndex.forEach((rowGroup) => {
          if (doc.getPageCount() >= MAX_PAGE_COUNT) {
            throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
          }
          pageInSheet++;
          const page = doc.addPage([pageWidth, pageHeight]);
          let cursorY = pageHeight - marginTop;

          if (settings?.header) {
            const ctx = { pageInSheet, totalPagesInSheet: totalPagesForSheet, sheetName: sheet.name };
            drawHeaderFooterSections(
              page,
              {
                left: resolveHeaderFooterTokens(settings.header.left, ctx),
                center: resolveHeaderFooterTokens(settings.header.center, ctx),
                right: resolveHeaderFooterTokens(settings.header.right, ctx),
              },
              pageHeight - headerMarginPt,
              marginLeft,
              pageWidth - marginRight,
              font
            );
          }
          if (settings?.footer) {
            const ctx = { pageInSheet, totalPagesInSheet: totalPagesForSheet, sheetName: sheet.name };
            drawHeaderFooterSections(
              page,
              {
                left: resolveHeaderFooterTokens(settings.footer.left, ctx),
                center: resolveHeaderFooterTokens(settings.footer.center, ctx),
                right: resolveHeaderFooterTokens(settings.footer.right, ctx),
              },
              Math.max(footerMarginPt - 10, 8),
              marginLeft,
              pageWidth - marginRight,
              font
            );
          }

          // 見出し行(headerLocalRowIndex)はページ分割の計算から除外しているため、
          // repeatHeaderRow有効時は毎ページ無条件で先頭に描画する。
          const rowsOnPage = headerLocalRowIndex >= 0 ? [headerLocalRowIndex, ...rowGroup] : rowGroup;

          // 「ページ中央に配置」(printOptions)。表の幅・高さをページの印刷領域内で中央へ寄せる。
          const tableWidthOnPage = colGroup.reduce((sum, lc) => sum + colWidths[lc] * grid.scale, 0);
          const startX = settings?.horizontalCentered ? marginLeft + Math.max(0, (contentWidth - tableWidthOnPage) / 2) : marginLeft;
          if (settings?.verticalCentered) {
            const tableHeightOnPage = rowsOnPage.reduce((sum, lr) => sum + rowHeights[lr] * grid.scale, 0);
            cursorY -= Math.max(0, (contentHeightForData - tableHeightOnPage) / 2);
          }

          drawPageFills(page, colGroup, rowsOnPage, cursorY, startX);
          if (headerLocalRowIndex >= 0) {
            cursorY = drawRow(page, headerLocalRowIndex, colGroup, cursorY, true, rowsOnPage, startX);
          }
          rowGroup.forEach((localRowIdx) => {
            cursorY = drawRow(page, localRowIdx, colGroup, cursorY, false, rowsOnPage, startX);
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
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
      warnings: Array.from(new Set(warnings)),
      sheetCount,
      totalRowCount: totalRows,
    };
  }
}
