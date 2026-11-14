import {
  parseWorkbookPageSettings,
  readHiddenSheetNames,
  type BorderLineStyle,
  type BorderSideStyle,
  type CellRangeRef,
  type HeaderFooterSections,
  type RichRun,
  type SheetPageSettings,
} from "@/lib/excel/ooxml-page-settings";
import { evaluateConditionalFormats, type ConditionalResult } from "@/lib/excel/conditional-format";
import { parseRangeRef } from "@/lib/excel/ooxml-charts";
import type { ChartRangeResolver } from "@/lib/excel/chart-render";
import { cellToDisplayString, type RawCellValue } from "@/lib/processors/browser/excel-to-pdf";
import { checkOfficeFile } from "./file-check";
import { renderChartsToPng } from "./chart-image";
import {
  EXCEL_DEFAULT_MARGINS_PT,
  PAPER_SIZES,
  TWIPS_PER_PT,
  excelPrintScale,
  fitColumns,
  fitImageBox,
  pageTwips,
  printableHeightTwips,
  printableWidthTwips,
  scaledFontPt,
  type ColumnGroup,
  type PageGeometry,
} from "./excel-word-fit";
import { inspectDocx, type DocxInspection } from "./docx-inspect";
import { fontMetricsFor } from "@/lib/fonts/office-font-metrics";

/** 数値・日付が列の幅に入らないとき、文字を小さくしてよい下限（pt）。これでも入らなければ折り返す */
const MIN_NUMERIC_FONT_PT = 6;

/** 文字列の幅（pt）。セルのフォントの文字の幅で求める（分からない文字は、全角1・半角0.55の目安） */
function runWidthPt(r: RunSpec): number {
  let sum = 0;
  const metrics = fontMetricsFor(r.font);
  for (const ch of Array.from(r.text)) sum += (metrics.widthPerPt(ch, r.bold) ?? (/[\u0000-\u00ff\uff61-\uff9f]/.test(ch) ? 0.55 : 1)) * r.sizePt;
  return sum;
}

/**
 * Excel→Word変換（ブラウザの中で行う。ファイルはサーバーへ送らない）。
 *
 * 読み取り：セルの値は read-excel-file、書式・印刷設定・結合・画像・グラフは
 *   Excel→PDF変換と同じ解析（src/lib/excel/ooxml-page-settings.ts）を使う。
 * 書き出し：docx パッケージ（すでに使っているもの）で、編集できるWordの表にする。
 * 用紙に収める計算は src/lib/office-convert/excel-word-fit.ts。書き出したファイルを開き直して、
 *   ページの大きさ・表の幅・画像の大きさを確かめる（src/lib/office-convert/docx-inspect.ts）。
 */

export interface ExcelSheetInfo {
  name: string;
  hidden: boolean;
  rowCount: number;
  empty: boolean;
}

export interface ExcelWorkbookInfo {
  sheets: ExcelSheetInfo[];
}

export interface ExcelToWordInput {
  file: File;
  /** 変換するシート（名前）。順番はブックの順のまま */
  sheetNames: string[];
  /** 元が縦向きで、表が収まらないときだけ横向きにしてよいか */
  allowAutoLandscape: boolean;
  onProgress?: (label: string) => void;
}

export interface ConversionCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ExcelToWordSheetReport {
  name: string;
  paper: string;
  orientation: "portrait" | "landscape";
  rotated: boolean;
  /** 列の途中で分けたページの数（1 = 分けていない） */
  columnPages: number;
  shrinkPercent: number;
  rows: number;
  cols: number;
  merges: number;
  images: number;
  charts: number;
}

export interface ExcelToWordOutput {
  blob: Blob;
  sheets: ExcelToWordSheetReport[];
  checks: ConversionCheck[];
  warnings: string[];
  inspection: DocxInspection;
}

const MAX_CELLS = 300_000;
const MAX_ROWS = 20_000;

type ReadXlsx = (file: File) => Promise<{ sheet: string; data: unknown[][] }[]>;

async function readValues(file: File): Promise<{ name: string; rows: RawCellValue[][] }[]> {
  const { default: readXlsxFile } = (await import("read-excel-file/universal")) as unknown as { default: ReadXlsx };
  // .xlsm も中身は同じ形式。読み込みのライブラリが拡張子を見ても困らないよう、.xlsx の名前で渡す
  const asXlsx = new File([file], file.name.replace(/\.xlsm$/i, ".xlsx"), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  let data: { sheet: string; data: unknown[][] }[];
  try {
    data = await readXlsxFile(asXlsx);
  } catch {
    throw new Error(`${file.name} の読み込みに失敗しました。Excelファイルが破損しているか、対応していない形式の可能性があります。`);
  }
  return data.map((s) => ({ name: s.sheet, rows: s.data.map((r) => r.map((v) => (v === undefined ? null : (v as RawCellValue)))) }));
}

/** シートの一覧（画面のシート選択用） */
export async function readExcelWorkbookInfo(file: File): Promise<ExcelWorkbookInfo> {
  await checkOfficeFile(file, "excel");
  const [values, hidden] = await Promise.all([readValues(file), readHiddenSheetNames(file)]);
  return {
    sheets: values.map((s) => ({
      name: s.name,
      hidden: hidden.has(s.name),
      rowCount: s.rows.length,
      empty: s.rows.every((r) => r.every((v) => v === null || v === "")),
    })),
  };
}

const key = (r: number, c: number) => `${r}:${c}`;

function colLetter(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** 使っている範囲（値・結合・塗りつぶし・罫線のある最大の行・列） */
function usedRange(rows: RawCellValue[][], st: SheetPageSettings | undefined): CellRangeRef | null {
  let maxR = -1;
  let maxC = -1;
  let minR = Infinity;
  let minC = Infinity;
  const take = (r: number, c: number) => {
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  };
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v !== null && v !== "") take(r, c);
  }));
  if (st) {
    for (const m of st.merges) {
      take(m.startRow, m.startCol);
      take(m.endRow, m.endCol);
    }
    for (const k of [...st.cellFills.keys(), ...st.cellBorderStyles.keys()]) {
      const [r, c] = k.split(":").map(Number);
      take(r, c);
    }
  }
  if (maxR < 0) return null;
  // 左上は、Excelの印刷と同じく A1 から（左・上の空白の行・列も、元の配置として残す）
  return { startRow: 0, startCol: 0, endRow: maxR, endCol: maxC };
}

function geometryOf(st: SheetPageSettings | undefined, warnings: string[], sheetName: string): PageGeometry {
  let paper = PAPER_SIZES.A4;
  if (st?.paperSize && PAPER_SIZES[st.paperSize]) paper = PAPER_SIZES[st.paperSize];
  else if (st?.paperSizeCode) warnings.push(`「${sheetName}」の用紙の種類（番号${st.paperSizeCode}）には対応していないため、A4にしました。`);
  const m = st?.margins;
  const margins = m
    ? { top: m.top * 72, bottom: m.bottom * 72, left: m.left * 72, right: m.right * 72, header: m.header * 72, footer: m.footer * 72 }
    : { ...EXCEL_DEFAULT_MARGINS_PT };
  // 極端に小さい・大きい余白は、Wordで扱える範囲に整える（ページの幅の4割を超える余白は、表を置けないため）
  const pageW = (st?.orientation === "landscape" ? paper.heightPt : paper.widthPt);
  for (const side of ["left", "right"] as const) margins[side] = Math.min(Math.max(0, margins[side]), pageW * 0.4);
  for (const side of ["top", "bottom", "header", "footer"] as const) margins[side] = Math.max(0, margins[side]);
  return { paper, orientation: st?.orientation ?? "portrait", margins };
}

const BORDER_MAP: Record<BorderLineStyle, { style: string; size: number }> = {
  hair: { style: "single", size: 2 },
  thin: { style: "single", size: 4 },
  medium: { style: "single", size: 12 },
  thick: { style: "single", size: 18 },
  dotted: { style: "dotted", size: 4 },
  dashed: { style: "dashed", size: 4 },
  dashDot: { style: "dotDash", size: 4 },
  dashDotDot: { style: "dotDotDash", size: 4 },
  mediumDashed: { style: "dashed", size: 12 },
  mediumDashDot: { style: "dotDash", size: 12 },
  mediumDashDotDot: { style: "dotDotDash", size: 12 },
  slantDashDot: { style: "dashDotStroked", size: 12 },
  double: { style: "double", size: 4 },
};

interface RunSpec {
  text: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: "single" | "double" | null;
  strike: boolean;
  color: string | null;
  font: string;
  vertAlign: "super" | "sub" | null;
}

interface CellSpec {
  runs: RunSpec[];
  text: string;
  fill: string | null;
  align: "left" | "center" | "right" | "justify" | "distribute";
  vAlign: "top" | "center" | "bottom";
  indentPt: number;
  rotation: "btLr" | "tbRl" | null;
  borders: { top?: BorderSideStyle; bottom?: BorderSideStyle; left?: BorderSideStyle; right?: BorderSideStyle };
  /** 数値・日付など（Excelでは折り返さず、入らないと「###」になる）。Wordでは、入らないときだけ文字を少し小さくする */
  numeric: boolean;
}

interface SheetModel {
  name: string;
  geometry: PageGeometry;
  /** 表の部分（印刷範囲ごと） */
  areas: AreaModel[];
  header: HeaderFooterSections | null;
  footer: HeaderFooterSections | null;
  horizontalCentered: boolean;
  pictures: { bytes: Uint8Array; mime: "image/png" | "image/jpeg"; widthPt: number; heightPt: number; before: boolean; row: number; col: number }[];
  shapes: { text: string; widthPt: number; fill: string | null; line: string | null; before: boolean; row: number; col: number }[];
  report: ExcelToWordSheetReport;
  /** 表の中で、最初に文字のある行（シートの行番号）。これより上にある画像・グラフは、表の前に置く */
  firstDataRow: number;
}

interface AreaModel {
  /** 表に出す行（シートの行番号。印刷タイトルの行が先頭に来ることがある） */
  rows: number[];
  /** 毎ページ繰り返す行（rows の先頭からの数） */
  headerRowCount: number;
  /** 表に出す列（シートの列番号） */
  cols: number[];
  /** この行の後でページを分ける（rows の添字） */
  breaksAfter: Set<number>;
  fit: { orientation: "portrait" | "landscape"; groups: ColumnGroup[]; rotated: boolean; splitMerges: number };
  cells: Map<string, CellSpec>;
  /** 結合：左上のセル（シートの行・列） → 行数・列数（表に出す行・列で数えた数） */
  merges: Map<string, { rowSpan: number; colSpan: number; colsSheet: number[] }>;
  /** 結合で隠れるセル（シートの行・列） */
  covered: Set<string>;
  rowHeightsPt: Map<number, number>;
  printGridLines: boolean;
  /** 1ページの高さの半分より低い行（行の途中でページを分けない指定にする） */
  shortRows: Set<number>;
  sourceNonEmpty: number;
}

export class ExcelToWordProcessor {
  async process(input: ExcelToWordInput): Promise<ExcelToWordOutput> {
    const { file, sheetNames, allowAutoLandscape, onProgress } = input;
    if (sheetNames.length === 0) throw new Error("変換するシートを1つ以上選んでください。");
    await checkOfficeFile(file, "excel");
    onProgress?.("Excelファイルを読み込んでいます…");
    const values = await readValues(file);
    let settings: Map<string, SheetPageSettings>;
    try {
      settings = await parseWorkbookPageSettings(file);
    } catch {
      settings = new Map();
    }
    const warnings: string[] = [];
    if (/\.xlsm$/i.test(file.name)) warnings.push("マクロ（VBA）は、Word文書には入りません（変換するのは、セルの値と書式・画像・グラフです）。");
    if (settings.size === 0) warnings.push("書式・印刷設定を読み取れなかったため、文字だけを変換しました（A4縦・標準の余白）。");

    const targets = values.filter((s) => sheetNames.includes(s.name));
    const totalCells = targets.reduce((n, s) => n + s.rows.reduce((m, r) => m + r.length, 0), 0);
    if (totalCells > MAX_CELLS) {
      throw new Error(`セルの数が多すぎるため、ブラウザの中では安全に変換できません（選んだシートの合計${totalCells.toLocaleString()}セル。上限${MAX_CELLS.toLocaleString()}セル）。シートを分けるか、範囲を絞ってからお試しください。`);
    }

    const models: SheetModel[] = [];
    for (const sheet of targets) {
      onProgress?.(`「${sheet.name}」を変換しています…`);
      await yieldToBrowser();
      const st = settings.get(sheet.name);
      const model = buildSheetModel(sheet.name, sheet.rows, st, allowAutoLandscape, warnings);
      if (model) models.push(model);
    }
    if (models.length === 0) throw new Error("変換できる内容がありませんでした（選んだシートはすべて空です）。");

    // グラフを画像にする
    const chartJobs: { sheet: SheetModel; model: NonNullable<SheetPageSettings["charts"][number]["model"]>; widthPt: number; heightPt: number; before: boolean; row: number; col: number; resolve: ChartRangeResolver }[] = [];
    for (const m of models) {
      const st = settings.get(m.name);
      if (!st) continue;
      for (const ch of st.charts) {
        if (!ch.model) {
          warnings.push(`「${m.name}」のグラフ（${colLetter(ch.fromCol)}${ch.fromRow + 1}付近）は、対応していない種類のため入れていません${ch.unsupportedReason ? `（${ch.unsupportedReason}）` : ""}。`);
          continue;
        }
        const box = anchorSize(ch, st);
        chartJobs.push({ sheet: m, model: ch.model, widthPt: box.w, heightPt: box.h, before: ch.fromRow < m.firstDataRow, row: ch.fromRow, col: ch.fromCol, resolve: makeResolver(m.name, values, settings) });
      }
    }
    let chartPngs: (Uint8Array | null)[] = [];
    if (chartJobs.length > 0) {
      onProgress?.("グラフを画像にしています…");
      try {
        chartPngs = await renderChartsToPng(chartJobs.map((j) => ({ model: j.model, widthPt: j.widthPt, heightPt: j.heightPt, resolve: j.resolve })));
      } catch {
        chartPngs = chartJobs.map(() => null);
      }
    }
    chartJobs.forEach((j, i) => {
      const png = chartPngs[i];
      if (!png) {
        warnings.push(`「${j.sheet.name}」のグラフ（${colLetter(j.col)}${j.row + 1}付近）を画像にできなかったため、入れていません。`);
        return;
      }
      j.sheet.pictures.push({ bytes: png, mime: "image/png", widthPt: j.widthPt, heightPt: j.heightPt, before: j.before, row: j.row, col: j.col });
      j.sheet.report.charts++;
    });

    onProgress?.("Word文書を作っています…");
    await yieldToBrowser();
    const blob = await buildDocx(models, file.name);

    onProgress?.("できあがったWord文書を確かめています…");
    const inspection = inspectDocx(new Uint8Array(await blob.arrayBuffer()));
    const checks = buildChecks(models, inspection);
    return { blob, sheets: models.map((m) => m.report), checks, warnings: dedupe(warnings), inspection };
  }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

function yieldToBrowser(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function anchorSize(a: { fromCol: number; fromRow: number; fromColOffPt: number; fromRowOffPt: number; toCol: number | null; toRow: number | null; toColOffPt: number; toRowOffPt: number; extWidthPt: number | null; extHeightPt: number | null }, st: SheetPageSettings): { w: number; h: number } {
  const colW = (c: number) => (st.hiddenCols.has(c) ? 0 : (st.columnWidthsPt.get(c) ?? st.defaultColumnWidthPt ?? 48));
  const rowH = (r: number) => (st.hiddenRows.has(r) ? 0 : (st.rowHeightsPt.get(r) ?? st.defaultRowHeightPt ?? 15));
  if (a.toCol !== null && a.toRow !== null) {
    let w = -a.fromColOffPt + a.toColOffPt;
    for (let c = a.fromCol; c < a.toCol; c++) w += colW(c);
    let h = -a.fromRowOffPt + a.toRowOffPt;
    for (let r = a.fromRow; r < a.toRow; r++) h += rowH(r);
    if (w > 1 && h > 1) return { w, h };
  }
  return { w: Math.max(10, a.extWidthPt ?? 200), h: Math.max(10, a.extHeightPt ?? 150) };
}

function makeResolver(currentSheet: string, values: { name: string; rows: RawCellValue[][] }[], settings: Map<string, SheetPageSettings>): ChartRangeResolver {
  const lookup = settings.get(currentSheet)?.chartLookup;
  const resolveRef = (ref0: string, visibleOnly: boolean, depth: number): ReturnType<ChartRangeResolver> => {
    const ref = ref0.trim().replace(/^=/, "");
    if (depth > 3 || !ref) return null;
    const range = parseRangeRef(ref);
    if (!range) {
      const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?([^!]+)$/.exec(ref);
      if (!m) return null;
      const scope = (m[1] ?? m[2] ?? "").replace(/''/g, "'");
      const nm = m[3].toLowerCase();
      const local = scope ? lookup?.localNames.get(scope)?.get(nm) : lookup?.localNames.get(currentSheet)?.get(nm);
      const target = local ?? lookup?.names.get(nm);
      return target ? resolveRef(target, visibleOnly, depth + 1) : null;
    }
    const name = range.sheet ?? currentSheet;
    const sheet = values.find((s) => s.name === name);
    if (!sheet) return null;
    const st = settings.get(name);
    const vals: (string | number | null)[] = [];
    const display: string[] = [];
    let format: string | null | undefined;
    if ((range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > 100_000) return null;
    for (let r = range.startRow; r <= range.endRow; r++) {
      if (visibleOnly && st?.hiddenRows.has(r) && range.endRow > range.startRow) continue;
      for (let c = range.startCol; c <= range.endCol; c++) {
        if (visibleOnly && st?.hiddenCols.has(c) && range.endCol > range.startCol) continue;
        const raw = sheet.rows[r]?.[c] ?? null;
        vals.push(raw instanceof Date ? raw.getTime() / 86_400_000 + 25569 : typeof raw === "boolean" ? (raw ? 1 : 0) : (raw as string | number | null));
        const dateFmt = st?.cellDateFormat.get(key(r, c)) ?? null;
        const numFmt = st?.cellNumFormat.get(key(r, c)) ?? null;
        if (format === undefined && raw !== null && raw !== "") format = dateFmt ?? numFmt ?? null;
        display.push(cellToDisplayString(raw, dateFmt, numFmt, st?.date1904 ?? false));
      }
    }
    return { values: vals, display, format: format ?? null };
  };
  return (ref, opts) => resolveRef(ref, opts?.visibleOnly ?? true, 0);
}

function buildSheetModel(
  name: string,
  rows: RawCellValue[][],
  st: SheetPageSettings | undefined,
  allowAutoLandscape: boolean,
  warnings: string[]
): SheetModel | null {
  const geometry = geometryOf(st, warnings, name);
  const areasRef: CellRangeRef[] = st?.printAreas && st.printAreas.length > 0 ? st.printAreas : [];
  const used = usedRange(rows, st);
  const ranges = areasRef.length > 0 ? areasRef : used ? [used] : [];
  if (ranges.length === 0 && !(st && (st.pictures.length > 0 || st.charts.length > 0))) {
    warnings.push(`「${name}」は空のシートのため、入れていません。`);
    return null;
  }
  const hiddenRows = st?.hiddenRows ?? new Set<number>();
  const hiddenCols = st?.hiddenCols ?? new Set<number>();
  const colWidth = (c: number) => st?.columnWidthsPt.get(c) ?? st?.defaultColumnWidthPt ?? 48;
  const rowHeight = (r: number) => st?.rowHeightsPt.get(r) ?? st?.defaultRowHeightPt ?? 15;
  let hiddenRowCount = 0;
  let hiddenColCount = 0;

  const report: ExcelToWordSheetReport = {
    name,
    paper: geometry.paper.name,
    orientation: geometry.orientation,
    rotated: false,
    columnPages: 1,
    shrinkPercent: 100,
    rows: 0,
    cols: 0,
    merges: 0,
    images: 0,
    charts: 0,
  };

  const cf: ConditionalResult | null =
    st && st.conditionalRules.length > 0 && rows.length > 0
      ? evaluateConditionalFormats(
          st.conditionalRules,
          (r, c) => rows[r]?.[c] ?? null,
          { startRow: 0, endRow: rows.length - 1, startCol: 0, endCol: Math.max(0, ...rows.map((r) => r.length - 1)) },
        )
      : null;
  if (cf && cf.unsupportedCount > 0) warnings.push(`「${name}」の条件付き書式のうち${cf.unsupportedCount}件は、再現できない種類のため反映していません。`);
  if (cf && cf.dataBars.size > 0) warnings.push(`「${name}」のデータバー（条件付き書式）は、Wordでは再現できないため入れていません（値はそのまま入れています）。`);

  const areas: AreaModel[] = [];
  let printScaleMin = 1;
  for (const range of ranges) {
    const titleRows: number[] = [];
    if (st?.printTitleRows) {
      for (let r = st.printTitleRows.start; r <= st.printTitleRows.end; r++) if (!hiddenRows.has(r)) titleRows.push(r);
    }
    const bodyRows: number[] = [];
    for (let r = range.startRow; r <= range.endRow; r++) {
      if (hiddenRows.has(r)) {
        hiddenRowCount++;
        continue;
      }
      bodyRows.push(r);
    }
    const cols: number[] = [];
    for (let c = range.startCol; c <= range.endCol; c++) {
      if (hiddenCols.has(c)) {
        hiddenColCount++;
        continue;
      }
      cols.push(c);
    }
    if (cols.length === 0 || bodyRows.length === 0) continue;
    if (bodyRows.length > MAX_ROWS) {
      throw new Error(`「${name}」の行が多すぎるため、ブラウザの中では安全に変換できません（${bodyRows.length.toLocaleString()}行。上限${MAX_ROWS.toLocaleString()}行）。`);
    }
    // 印刷タイトルの行が範囲の上にあるとき（範囲の外）は、表の先頭に加える。範囲の中の先頭にあれば、そのまま見出しにする
    let tableRows = bodyRows;
    let headerRowCount = 0;
    if (titleRows.length > 0) {
      const outside = titleRows.filter((r) => r < range.startRow);
      if (outside.length === titleRows.length) {
        tableRows = [...outside, ...bodyRows];
        headerRowCount = outside.length;
      } else {
        const leading = bodyRows.slice(0, titleRows.length);
        if (leading.every((r, i) => r === titleRows[i])) headerRowCount = titleRows.length;
      }
    }

    // Excelの印刷の倍率
    const rawWidths = cols.map(colWidth);
    const totalWidth = rawWidths.reduce((s, w) => s + w, 0);
    const printableW = printableWidthTwips(geometry) / TWIPS_PER_PT;
    const scale = st
      ? excelPrintScale({ fitToPageEnabled: st.fitToPageEnabled, fitToWidth: st.fitToWidth, scalePercent: st.scalePercent, totalWidthPt: totalWidth, printableWidthPt: printableW })
      : 1;
    printScaleMin = Math.min(printScaleMin, scale);
    const widthsPt = rawWidths.map((w) => w * scale);

    // 結合
    const merges = new Map<string, { rowSpan: number; colSpan: number; colsSheet: number[] }>();
    const covered = new Set<string>();
    const rowPos = new Map(tableRows.map((r, i) => [r, i]));
    const colPos = new Map(cols.map((c, i) => [c, i]));
    const mergeColSpans: { start: number; end: number }[] = [];
    for (const m of st?.merges ?? []) {
      const mRows = tableRows.filter((r) => r >= m.startRow && r <= m.endRow);
      const mCols = cols.filter((c) => c >= m.startCol && c <= m.endCol);
      if (mRows.length === 0 || mCols.length === 0) continue;
      if (mRows.length === 1 && mCols.length === 1) continue;
      const anchorKey = key(mRows[0], mCols[0]);
      merges.set(anchorKey, { rowSpan: mRows.length, colSpan: mCols.length, colsSheet: mCols });
      for (const r of mRows) for (const c of mCols) if (r !== mRows[0] || c !== mCols[0]) covered.add(key(r, c));
      // 元の左上のセルの値が隠れた行・列にあるときも、文字を失わない
      if (m.startRow !== mRows[0] || m.startCol !== mCols[0]) {
        const v = rows[m.startRow]?.[m.startCol];
        if (v !== null && v !== undefined && v !== "" && (rows[mRows[0]]?.[mCols[0]] ?? null) === null) {
          (rows[mRows[0]] ??= [])[mCols[0]] = v;
        }
      }
      mergeColSpans.push({ start: colPos.get(mCols[0])!, end: colPos.get(mCols[mCols.length - 1])! });
    }
    void rowPos;

    const forcedColBreaks = (st?.colBreaksAfter ?? []).map((c) => cols.filter((x) => x <= c).length - 1).filter((i) => i >= 0 && i < cols.length - 1);
    const repeatCols = st?.printTitleCols ? cols.map((c, i) => (c >= st.printTitleCols!.start && c <= st.printTitleCols!.end ? i : -1)).filter((i) => i >= 0) : [];
    const fit = fitColumns({ columnWidthsPt: widthsPt, geometry, allowAutoLandscape, mergeColSpans, forcedBreaksAfter: forcedColBreaks, repeatCols });
    if (fit.splitMerges > 0) warnings.push(`「${name}」の表は横幅が大きいため、列の途中でページを分けました。結合したセル${fit.splitMerges}か所が、ページの境目で分かれています（文字は、左側のページの方に入っています）。`);

    // 行の途中で改ページ（Excelの手動の改ページ）
    const breaksAfter = new Set<number>();
    for (const b of st?.rowBreaksAfter ?? []) {
      const idx = tableRows.lastIndexOf(tableRows.filter((r) => r <= b).pop() ?? -1);
      if (idx >= headerRowCount && idx < tableRows.length - 1) breaksAfter.add(idx);
    }

    // セル
    const cells = new Map<string, CellSpec>();
    let sourceNonEmpty = 0;
    const fontScale = scale;
    for (const r of tableRows) {
      for (const c of cols) {
        if (covered.has(key(r, c))) continue;
        const spec = cellSpec(rows, r, c, st, cf, fontScale);
        if (spec.text !== "") sourceNonEmpty++;
        cells.set(key(r, c), spec);
      }
    }
    // 結合したセルの外枠の罫線（右・下は、結合の右端・下端のセルの罫線）
    for (const [k, m] of merges) {
      const [r0, c0] = k.split(":").map(Number);
      const spec = cells.get(k);
      if (!spec || !st) continue;
      const lastRow = tableRows[tableRows.indexOf(r0) + m.rowSpan - 1];
      const lastCol = m.colsSheet[m.colsSheet.length - 1];
      const br = st.cellBorderStyles.get(key(r0, lastCol))?.right ?? st.cellBorderStyles.get(key(r0, lastCol + 1))?.left;
      const bb = st.cellBorderStyles.get(key(lastRow, c0))?.bottom ?? st.cellBorderStyles.get(key(lastRow + 1, c0))?.top;
      if (br) spec.borders.right = br;
      if (bb) spec.borders.bottom = bb;
    }

    const rowHeightsPt = new Map<number, number>();
    const shortRows = new Set<number>();
    const pageH = printableHeightTwips(fit.orientation === geometry.orientation ? geometry : { ...geometry, orientation: fit.orientation }) / TWIPS_PER_PT;
    for (const r of tableRows) {
      const h = rowHeight(r) * scale;
      rowHeightsPt.set(r, h);
      if (h < pageH * 0.5) shortRows.add(r);
    }

    areas.push({
      rows: tableRows,
      headerRowCount,
      cols,
      breaksAfter,
      fit,
      cells,
      merges,
      covered,
      rowHeightsPt,
      printGridLines: st?.printGridLines ?? false,
      shortRows,
      sourceNonEmpty,
    });
    report.rows += bodyRows.length;
    report.cols = Math.max(report.cols, cols.length);
    report.merges += merges.size;
    report.columnPages = Math.max(report.columnPages, fit.groups.length);
    report.shrinkPercent = Math.min(report.shrinkPercent, Math.round(Math.min(...fit.groups.map((g) => g.shrink)) * scale * 100));
    if (fit.rotated) report.rotated = true;
  }
  if (hiddenRowCount > 0 || hiddenColCount > 0) {
    warnings.push(`「${name}」の非表示の${[hiddenRowCount > 0 ? `行（${hiddenRowCount}行）` : "", hiddenColCount > 0 ? `列（${hiddenColCount}列）` : ""].filter(Boolean).join("・")}は、Excelの印刷と同じく入れていません。`);
  }
  const orientation = areas[0]?.fit.orientation ?? geometry.orientation;
  if (areas.some((a) => a.fit.orientation !== orientation)) {
    // 印刷範囲ごとに向きが違う場合は、横向きにそろえる（どちらでも収まる向き）
    for (const a of areas) a.fit.orientation = "landscape";
  }
  const finalGeometry: PageGeometry = { ...geometry, orientation: areas[0]?.fit.orientation ?? geometry.orientation };
  report.orientation = finalGeometry.orientation;
  if (report.rotated) warnings.push(`「${name}」は表の横幅が縦向きのA4などに収まらないため、横向きのページにしました（縦向きのまま縮めると、文字が読みにくくなるため）。`);
  if (report.columnPages > 1) warnings.push(`「${name}」は表の横幅が大きいため、列の途中で${report.columnPages}ページに分けました（列を消したり、切り捨てたりはしていません）。`);
  if (printScaleMin < 1 && st) {
    // 文字の下限を使ったかどうか
    const minSize = Math.min(...[...(st.cellFontSizePt.values() ?? [])], st.defaultFontSizePt ?? 11);
    if (minSize * printScaleMin < 7) warnings.push(`「${name}」はExcelで縮小して印刷する設定ですが、文字が小さくなり過ぎないよう、7pt より小さくはしていません（その分、セルの中で折り返します）。`);
  }

  // 画像・図形：最初に文字のある行より上にあるものは表の前、それ以外は表の後に置く（表と重ねない）
  const firstArea = areas[0];
  const firstRow = firstArea ? (firstArea.rows.find((r) => firstArea.cols.some((c) => (firstArea.cells.get(key(r, c))?.text ?? "") !== "")) ?? firstArea.rows[0]) : 0;
  const pictures: SheetModel["pictures"] = [];
  const shapes: SheetModel["shapes"] = [];
  const scaleForDrawings = printScaleMin;
  if (st) {
    for (const p of st.pictures) {
      const box = anchorSize(p, st);
      pictures.push({ bytes: p.bytes, mime: p.mime, widthPt: box.w * scaleForDrawings, heightPt: box.h * scaleForDrawings, before: p.fromRow < firstRow, row: p.fromRow, col: p.fromCol });
    }
    if (st.otherImages && st.otherImages.length > 0) warnings.push(`「${name}」のPNG・JPEG以外の画像（${st.otherImages.length}個）は入れていません。`);
    for (const s of st.shapes) {
      if (s.text.trim() !== "") {
        const box = anchorSize(s, st);
        shapes.push({ text: s.text, widthPt: box.w * scaleForDrawings, fill: s.fill, line: s.line, before: s.fromRow < firstRow, row: s.fromRow, col: s.fromCol });
      }
    }
    const plainShapes = st.shapes.filter((s) => s.text.trim() === "").length + st.unsupportedDrawingCount;
    if (plainShapes > 0) warnings.push(`「${name}」の図形（文字の無い四角・線など${plainShapes}個）は、Wordの表と重ならないよう入れていません。`);
    if (shapes.length > 0) warnings.push(`「${name}」のテキストボックス・図形の文字（${shapes.length}個）は、枠の付いた文字として表の${shapes.every((s) => s.before) ? "前" : "後"}に入れました（元の位置に重ねては置いていません）。`);
    report.images = pictures.length;
  }
  if (areas.length === 0 && pictures.length === 0 && (!st || st.charts.length === 0)) {
    warnings.push(`「${name}」は表示されているセルが無いため、入れていません。`);
    return null;
  }
  for (const a of areas) a.fit.orientation = finalGeometry.orientation;
  // 表の前に画像・グラフを置くときは、その画像が重なっていた表の先頭の空白の行（文字・塗り・罫線の無い行）を除く（空白が二重にならないように）
  const hasBefore = pictures.some((p) => p.before) || shapes.some((x) => x.before) || (st?.charts ?? []).some((ch) => ch.fromRow < firstRow);
  if (hasBefore && firstArea && firstArea.headerRowCount === 0) {
    const blank = (r: number) =>
      firstArea.cols.every((c) => {
        const cs = firstArea.cells.get(key(r, c));
        return !firstArea.covered.has(key(r, c)) && !firstArea.merges.has(key(r, c)) && (!cs || (cs.text === "" && !cs.fill && !cs.borders.top && !cs.borders.bottom && !cs.borders.left && !cs.borders.right));
      });
    let cut = 0;
    while (cut < firstArea.rows.length - 1 && firstArea.rows[cut] < firstRow && blank(firstArea.rows[cut])) cut++;
    if (cut > 0) {
      firstArea.rows = firstArea.rows.slice(cut);
      firstArea.breaksAfter = new Set([...firstArea.breaksAfter].map((i) => i - cut).filter((i) => i >= 0));
    }
  }
  return {
    firstDataRow: firstRow,
    name,
    geometry: finalGeometry,
    areas,
    header: st?.header ?? null,
    footer: st?.footer ?? null,
    horizontalCentered: st?.horizontalCentered ?? false,
    pictures,
    shapes,
    report,
  };
}

function cellSpec(rows: RawCellValue[][], r: number, c: number, st: SheetPageSettings | undefined, cf: ConditionalResult | null, scale: number): CellSpec {
  const k = key(r, c);
  const raw = rows[r]?.[c] ?? null;
  const dateFmt = st?.cellDateFormat.get(k) ?? null;
  const numFmt = st?.cellNumFormat.get(k) ?? null;
  const text = cellToDisplayString(raw, dateFmt, numFmt, st?.date1904 ?? false);
  const extras = st?.cellFontExtras.get(k);
  const baseSize = st?.cellFontSizePt.get(k) ?? st?.defaultFontSizePt ?? 11;
  const serif = extras?.serif ?? st?.defaultFontSerif ?? false;
  const font = extras?.fontName ?? st?.defaultFontName ?? (serif ? "游明朝" : "游ゴシック");
  const color = (cf?.fontColors.get(k) ?? st?.cellFontColors.get(k) ?? null)?.replace("#", "") ?? null;
  const bold = cf?.bold.get(k) ?? st?.cellBold.get(k) ?? false;
  const italic = cf?.italic.get(k) ?? extras?.italic ?? false;
  const underline = cf?.underline.get(k) ?? extras?.underline ?? null;
  const strike = cf?.strike.get(k) ?? extras?.strike ?? false;
  const base: RunSpec = { text, sizePt: scaledFontPt(baseSize, scale), bold, italic, underline, strike, color, font, vertAlign: extras?.vertAlign ?? null };
  const rich: RichRun[] | undefined = st?.cellRich.get(k);
  const runs: RunSpec[] =
    rich && rich.length > 0 && typeof raw === "string"
      ? rich.map((rr) => ({
          text: rr.text,
          sizePt: scaledFontPt(rr.fontSizePt ?? baseSize, scale),
          bold: rr.bold ?? bold,
          italic: rr.italic ?? italic,
          underline: rr.underline ?? underline,
          strike: rr.strike ?? strike,
          color: rr.color?.replace("#", "") ?? color,
          font: rr.fontName ?? font,
          vertAlign: rr.vertAlign ?? null,
        }))
      : [base];
  const align = st?.cellAlign.get(k);
  const isNumberLike = typeof raw === "number" || raw instanceof Date;
  let h: CellSpec["align"] = isNumberLike ? "right" : typeof raw === "boolean" ? "center" : "left";
  if (align?.horizontal === "center" || align?.centerContinuous) h = "center";
  else if (align?.horizontal === "right") h = "right";
  else if (align?.horizontal === "left") h = "left";
  else if (align?.horizontal === "distributed") h = "distribute";
  const v: CellSpec["vAlign"] = align?.vertical ?? "bottom";
  const rot = align?.textRotation ?? 0;
  const rotation: CellSpec["rotation"] = rot === 255 ? "tbRl" : rot >= 45 && rot <= 90 ? "btLr" : null;
  const ownBorders = { ...(st?.cellBorderStyles.get(k) ?? {}), ...(cf?.borders.get(k) ?? {}) };
  // 隣のセルが共有の辺に持つ罫線も使う（Excelは、どちらかのセルに罫線があれば線を引く）
  const borders = {
    top: ownBorders.top ?? st?.cellBorderStyles.get(key(r - 1, c))?.bottom,
    bottom: ownBorders.bottom ?? st?.cellBorderStyles.get(key(r + 1, c))?.top,
    left: ownBorders.left ?? st?.cellBorderStyles.get(key(r, c - 1))?.right,
    right: ownBorders.right ?? st?.cellBorderStyles.get(key(r, c + 1))?.left,
  };
  return {
    runs,
    text,
    fill: (cf?.fills.get(k) ?? st?.cellFills.get(k) ?? null)?.replace("#", "") ?? null,
    align: h,
    vAlign: v,
    indentPt: (align?.indent ?? 0) * 7.5 * scale,
    rotation,
    borders,
    numeric: (isNumberLike || typeof raw === "boolean") && !text.includes("\n"),
  };
}

// ---------------------------------------------------------------------------
// Word文書を組み立てる
// ---------------------------------------------------------------------------

async function buildDocx(models: SheetModel[], fileName: string): Promise<Blob> {
  const docx = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    TableLayoutType,
    VerticalAlign,
    HeightRule,
    ImageRun,
    Header,
    Footer,
    PageNumber,
    PageOrientation,
    PageBreak,
    ShadingType,
    UnderlineType,
    TabStopType,
    LineRuleType,
  } = docx;

  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const runOf = (r: RunSpec, extra?: { break?: boolean }) =>
    new TextRun({
      text: r.text,
      size: Math.max(2, Math.round(r.sizePt * 2)),
      bold: r.bold || undefined,
      italics: r.italic || undefined,
      underline: r.underline ? { type: r.underline === "double" ? UnderlineType.DOUBLE : UnderlineType.SINGLE } : undefined,
      strike: r.strike || undefined,
      color: r.color ?? undefined,
      font: { ascii: r.font, eastAsia: r.font, hAnsi: r.font, cs: r.font },
      superScript: r.vertAlign === "super" || undefined,
      subScript: r.vertAlign === "sub" || undefined,
      break: extra?.break ? 1 : undefined,
    });

  /** 改行（\n）を含む文字を、Wordの改行つきの文字の並びにする */
  const runsWithBreaks = (runs: RunSpec[]) => {
    const out: InstanceType<typeof TextRun>[] = [];
    for (const r of runs) {
      const parts = r.text.split(/\r\n|\n|\r/);
      parts.forEach((p, i) => out.push(runOf({ ...r, text: p }, { break: i > 0 })));
    }
    return out;
  };

  const alignOf = (a: CellSpec["align"]) =>
    a === "center" ? AlignmentType.CENTER : a === "right" ? AlignmentType.RIGHT : a === "distribute" ? AlignmentType.DISTRIBUTE : a === "justify" ? AlignmentType.JUSTIFIED : AlignmentType.LEFT;
  const vAlignOf = (v: CellSpec["vAlign"]) => (v === "top" ? VerticalAlign.TOP : v === "center" ? VerticalAlign.CENTER : VerticalAlign.BOTTOM);
  const borderOf = (b: BorderSideStyle | undefined, grid: boolean) => {
    if (!b) return grid ? { style: "single" as const, size: 2, color: "BFBFBF" } : { style: "nil" as const, size: 0, color: "auto" };
    const m = BORDER_MAP[b.style] ?? BORDER_MAP.thin;
    return { style: m.style as "single", size: m.size, color: b.color?.replace("#", "") ?? "000000" };
  };
  const tinyParagraph = (children: (InstanceType<typeof TextRun> | InstanceType<typeof PageBreak>)[] = []) =>
    new Paragraph({ children, spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO }, run: { size: 2 } });

  const sections: import("docx").ISectionOptions[] = [];

  for (const m of models) {
    const g = m.geometry;
    const tw = pageTwips(g);
    const printableTw = printableWidthTwips(g);
    const printableHTw = printableHeightTwips(g);
    const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];

    const pictureParagraph = (p: SheetModel["pictures"][number]) => {
      const box = fitImageBox(p.widthPt, p.heightPt, printableTw / TWIPS_PER_PT, (printableHTw / TWIPS_PER_PT) * 0.9);
      // docx の ImageRun の大きさは画素（96dpi）で指定する
      const px = (pt: number) => Math.max(1, Math.floor((pt * 96) / 72));
      return new Paragraph({
        children: [new ImageRun({ type: p.mime === "image/png" ? "png" : "jpg", data: p.bytes, transformation: { width: px(box.widthPt), height: px(box.heightPt) } })],
        // 行の高さは「自動」にする（固定の高さだと、画像が行の高さで切れたり、上にはみ出したりする）
        spacing: { before: 60, after: 60, line: 240, lineRule: LineRuleType.AUTO },
      });
    };
    const shapeTable = (s: SheetModel["shapes"][number]) => {
      const width = Math.min(printableTw, Math.max(400, Math.round(s.widthPt * TWIPS_PER_PT)));
      const line = s.line?.replace("#", "") ?? "808080";
      const side = { style: "single" as const, size: 6, color: line };
      return new Table({
        layout: TableLayoutType.FIXED,
        width: { size: width, type: WidthType.DXA },
        columnWidths: [width],
        indent: { size: 0, type: WidthType.DXA },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: width, type: WidthType.DXA },
                shading: s.fill ? { type: ShadingType.CLEAR, color: "auto", fill: s.fill.replace("#", "") } : undefined,
                borders: { top: side, bottom: side, left: side, right: side },
                margins: { left: 80, right: 80, top: 40, bottom: 40 },
                children: s.text.split(/\r?\n/).map((t) => new Paragraph({ children: [new TextRun({ text: t, size: 20 })], spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } })),
              }),
            ],
          }),
        ],
      });
    };

    const placeDrawings = (before: boolean) => {
      const pics = m.pictures.filter((p) => p.before === before).sort((a, b) => a.row - b.row || a.col - b.col);
      const shs = m.shapes.filter((s) => s.before === before).sort((a, b) => a.row - b.row || a.col - b.col);
      for (const s of shs) {
        children.push(shapeTable(s));
        children.push(tinyParagraph());
      }
      for (const p of pics) children.push(pictureParagraph(p));
    };

    placeDrawings(true);

    m.areas.forEach((area, areaIndex) => {
      if (areaIndex > 0) children.push(tinyParagraph([new PageBreak()]));
      // 手動の改ページで、行のまとまりに分ける
      const chunks: number[][] = [];
      let current: number[] = [];
      area.rows.forEach((r, i) => {
        current.push(i);
        if (area.breaksAfter.has(i)) {
          chunks.push(current);
          current = [];
        }
      });
      if (current.length > 0) chunks.push(current);

      area.fit.groups.forEach((group, groupIndex) => {
        chunks.forEach((chunk, chunkIndex) => {
          if (groupIndex > 0 || chunkIndex > 0) children.push(tinyParagraph([new PageBreak()]));
          // 2つ目以降のまとまりにも、見出しの行（印刷タイトル）を入れる
          const rowIdx = chunkIndex > 0 && area.headerRowCount > 0 ? [...Array.from({ length: area.headerRowCount }, (_, i) => i), ...chunk.filter((i) => i >= area.headerRowCount)] : chunk;
          children.push(buildTable(area, group, rowIdx));
        });
      });
    });

    placeDrawings(false);
    if (children.length === 0) children.push(tinyParagraph());
    // 最後の表の後に、Wordが必要とする段落を小さく置く（空白のページを作らないため）
    if (children[children.length - 1] instanceof Table) children.push(tinyParagraph());

    const hf = (sec: HeaderFooterSections | null, kind: "header" | "footer") => {
      if (!sec || !(sec.left || sec.center || sec.right)) return undefined;
      const parts: (InstanceType<typeof TextRun>)[] = [];
      const pushText = (text: string, size: number) => {
        const tokens = text.split(/(\{\{PAGE\}\}|\{\{PAGES\}\})/);
        for (const t of tokens) {
          if (t === "{{PAGE}}") parts.push(new TextRun({ children: [PageNumber.CURRENT], size }));
          else if (t === "{{PAGES}}") parts.push(new TextRun({ children: [PageNumber.TOTAL_PAGES], size }));
          else if (t) parts.push(new TextRun({ text: t.replace(/\{\{SHEET\}\}/g, m.name).replace(/\{\{FILE\}\}/g, fileName).replace(/\{\{DATE\}\}/g, dateStr).replace(/\{\{TIME\}\}/g, timeStr).replace(/\{\{[A-Z]+\}\}/g, ""), size }));
        }
      };
      const size = (n?: number) => Math.round((n ?? 9) * 2);
      if (sec.left) pushText(sec.left, size(sec.sizes?.left));
      parts.push(new TextRun({ text: "\t" }));
      if (sec.center) pushText(sec.center, size(sec.sizes?.center));
      parts.push(new TextRun({ text: "\t" }));
      if (sec.right) pushText(sec.right, size(sec.sizes?.right));
      const para = new Paragraph({
        children: parts,
        tabStops: [
          { type: TabStopType.CENTER, position: Math.floor(printableTw / 2) },
          { type: TabStopType.RIGHT, position: printableTw },
        ],
      });
      return kind === "header" ? new Header({ children: [para] }) : new Footer({ children: [para] });
    };

    const header = hf(m.header, "header");
    const footer = hf(m.footer, "footer");
    sections.push({
      properties: {
        page: {
          // docx は、横向きのとき幅と高さを入れ替えて書き出す。ここでは縦向きの大きさを渡す
          size: { width: Math.round(g.paper.widthPt * TWIPS_PER_PT), height: Math.round(g.paper.heightPt * TWIPS_PER_PT), orientation: g.orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          margin: {
            top: Math.round(g.margins.top * TWIPS_PER_PT),
            bottom: Math.round(g.margins.bottom * TWIPS_PER_PT),
            left: Math.round(g.margins.left * TWIPS_PER_PT),
            right: Math.round(g.margins.right * TWIPS_PER_PT),
            header: Math.round(g.margins.header * TWIPS_PER_PT),
            footer: Math.round(g.margins.footer * TWIPS_PER_PT),
          },
        },
      },
      headers: header ? { default: header } : undefined,
      footers: footer ? { default: footer } : undefined,
      children,
    });
    void tw;
  }

  function buildTable(area: AreaModel, group: ColumnGroup, rowIdx: number[]) {
    const groupCols = group.cols.map((i) => area.cols[i]);
    const colIndexInGroup = new Map(groupCols.map((c, i) => [c, i]));
    const totalTw = group.widthsTwips.reduce((s, w) => s + w, 0);
    const margin = group.shrink < 0.85 ? 20 : 40;
    const rowSet = new Set(rowIdx);
    // 結合の範囲は、この表に出す行・列の中だけで数え直す
    const tableRowsSheet = rowIdx.map((i) => area.rows[i]);
    const coveredHere = new Set<string>();
    const spanHere = new Map<string, { rowSpan: number; colSpan: number }>();
    for (const [k, m] of area.merges) {
      const [r0] = k.split(":").map(Number);
      const startIdx = area.rows.indexOf(r0);
      const mergeRowsSheet = area.rows.slice(startIdx, startIdx + m.rowSpan).filter((_, j) => rowSet.has(startIdx + j));
      const mergeColsHere = m.colsSheet.filter((c) => colIndexInGroup.has(c));
      if (mergeRowsSheet.length === 0 || mergeColsHere.length === 0) continue;
      const anchor = key(mergeRowsSheet[0], mergeColsHere[0]);
      spanHere.set(anchor, { rowSpan: mergeRowsSheet.length, colSpan: mergeColsHere.length });
      for (const r of mergeRowsSheet) for (const c of mergeColsHere) if (key(r, c) !== anchor) coveredHere.add(key(r, c));
      // 結合の左上のセルがこの表に無い（列の分割で左のページにある・ページの区切りで前のまとまりにある）ときは、左上の書式だけを使う
      if (anchor !== k && !area.cells.has(anchor)) {
        const src = area.cells.get(k);
        if (src) area.cells.set(anchor, { ...src, runs: src.runs.map((r) => ({ ...r, text: "" })), text: "" });
      }
    }
    const rowsOut = tableRowsSheet.map((r, ri) => {
      const isHeader = rowIdx[ri] < area.headerRowCount;
      const cellsOut: InstanceType<typeof TableCell>[] = [];
      for (const c of groupCols) {
        const k = key(r, c);
        if (coveredHere.has(k)) continue;
        const spec = area.cells.get(k);
        const span = spanHere.get(k);
        const ci = colIndexInGroup.get(c)!;
        const widthTw = group.widthsTwips.slice(ci, ci + (span?.colSpan ?? 1)).reduce((s, w) => s + w, 0);
        const b = spec?.borders ?? {};
        // 数値・日付が列の幅に入らないときは、折り返して桁が分かれないよう、文字を少しだけ小さくする
        let runs = spec?.runs ?? [];
        if (spec?.numeric) {
          const avail = widthTw / TWIPS_PER_PT - (2 * margin) / TWIPS_PER_PT - 1.5;
          const w = runs.reduce((s, r) => s + runWidthPt(r), 0);
          if (w > avail && avail > 0) {
            const k = avail / w;
            runs = runs.map((r) => ({ ...r, sizePt: Math.max(Math.min(r.sizePt, MIN_NUMERIC_FONT_PT), r.sizePt * k) }));
          }
        }
        cellsOut.push(
          new TableCell({
            width: { size: widthTw, type: WidthType.DXA },
            columnSpan: span && span.colSpan > 1 ? span.colSpan : undefined,
            rowSpan: span && span.rowSpan > 1 ? span.rowSpan : undefined,
            verticalAlign: vAlignOf(spec?.vAlign ?? "bottom"),
            shading: spec?.fill ? { type: ShadingType.CLEAR, color: "auto", fill: spec.fill } : undefined,
            margins: { left: margin, right: margin, top: 0, bottom: 0 },
            textDirection: spec?.rotation ?? undefined,
            borders: {
              top: borderOf(b.top, area.printGridLines),
              bottom: borderOf(b.bottom, area.printGridLines),
              left: borderOf(b.left, area.printGridLines),
              right: borderOf(b.right, area.printGridLines),
            },
            children: [
              new Paragraph({
                children: spec ? runsWithBreaks(runs) : [],
                alignment: alignOf(spec?.align ?? "left"),
                indent: spec && spec.indentPt > 0 ? { left: Math.round(spec.indentPt * TWIPS_PER_PT) } : undefined,
                spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
                // 表題・見出しの行は、次の行と同じページに置く
                keepNext: isHeader || ri === 0 || undefined,
                run: { size: Math.round((spec?.runs[0]?.sizePt ?? 11) * 2) },
              }),
            ],
          })
        );
      }
      const hPt = area.rowHeightsPt.get(r) ?? 15;
      return new TableRow({
        children: cellsOut,
        tableHeader: isHeader || undefined,
        cantSplit: area.shortRows.has(r) || undefined,
        height: { value: Math.max(1, Math.round(hPt * TWIPS_PER_PT)), rule: HeightRule.ATLEAST },
      });
    });
    return new Table({
      rows: rowsOut,
      columnWidths: group.widthsTwips,
      layout: TableLayoutType.FIXED,
      width: { size: totalTw, type: WidthType.DXA },
      indent: { size: 0, type: WidthType.DXA },
      borders: {
        top: { style: "nil", size: 0, color: "auto" },
        bottom: { style: "nil", size: 0, color: "auto" },
        left: { style: "nil", size: 0, color: "auto" },
        right: { style: "nil", size: 0, color: "auto" },
        insideHorizontal: { style: "nil", size: 0, color: "auto" },
        insideVertical: { style: "nil", size: 0, color: "auto" },
      },
      margins: { left: margin, right: margin, top: 0, bottom: 0 },
    });
  }

  const doc = new Document({
    compatibility: { version: 15 },
    creator: "Mr.Satto",
    title: fileName.replace(/\.(xlsx|xlsm)$/i, ""),
    styles: {
      default: {
        document: { run: { font: { ascii: "游ゴシック", eastAsia: "游ゴシック", hAnsi: "游ゴシック" }, size: 21 }, paragraph: { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO } } },
      },
    },
    sections,
  });
  return Packer.toBlob(doc);
}

// ---------------------------------------------------------------------------
// 変換後の確認
// ---------------------------------------------------------------------------

function buildChecks(models: SheetModel[], ins: DocxInspection): ConversionCheck[] {
  const checks: ConversionCheck[] = [];
  const sectionsOk = ins.sections.length === models.length;
  checks.push({ label: "シートごとのページ設定", ok: sectionsOk, detail: sectionsOk ? `${models.length}シート` : `シート${models.length}・ページ設定${ins.sections.length}` });
  const paperOk = models.every((m, i) => {
    const s = ins.sections[i];
    if (!s) return false;
    const t = pageTwips(m.geometry);
    return Math.abs(s.pageWidthTw - t.width) <= 2 && Math.abs(s.pageHeightTw - t.height) <= 2;
  });
  checks.push({
    label: "用紙の大きさ・向き",
    ok: paperOk,
    detail: models.map((m) => `${m.name}：${m.geometry.paper.name}${m.geometry.orientation === "landscape" ? "横" : "縦"}`).join("、"),
  });
  const over = ins.tables.filter((t) => t.overflowTw > 0);
  checks.push({
    label: "表がページの横幅に収まっている（左右のはみ出しなし）",
    ok: over.length === 0 && ins.tables.every((t) => t.indentTw >= 0),
    detail: over.length === 0 ? `表${ins.tables.length}個すべて` : `${over.length}個の表がはみ出しています`,
  });
  const imgOver = ins.images.filter((im) => im.overflowWidthEmu > 0 || im.overflowHeightEmu > 0);
  checks.push({ label: "画像・グラフがページに収まっている", ok: imgOver.length === 0, detail: ins.images.length === 0 ? "画像なし" : `画像${ins.images.length}個` });
  const expectedCells = models.reduce((n, m) => n + m.areas.reduce((k, a) => k + a.sourceNonEmpty, 0), 0);
  const repeatedHeaderCells = 0;
  checks.push({
    label: "セルの文字の欠け",
    ok: ins.nonEmptyCells >= expectedCells - repeatedHeaderCells,
    detail: `元の文字のあるセル${expectedCells.toLocaleString()}個 → Wordの表の文字のあるセル${ins.nonEmptyCells.toLocaleString()}個（見出しの繰り返し・列の分割の分を含む）`,
  });
  const expectedMerges = models.reduce((n, m) => n + m.report.merges, 0);
  checks.push({ label: "結合したセル", ok: ins.mergedCells >= expectedMerges, detail: `元${expectedMerges}か所 → Word${ins.mergedCells}か所` });
  checks.push({ label: "空白のページになる改ページの重なり", ok: ins.consecutivePageBreaks === 0, detail: ins.consecutivePageBreaks === 0 ? "なし" : `${ins.consecutivePageBreaks}か所` });
  return checks;
}

