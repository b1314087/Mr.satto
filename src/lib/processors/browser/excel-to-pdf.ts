import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes, loadJapaneseSerifFontBytes } from "@/lib/pdf/japanese-font";
import {
  parseWorkbookPageSettings,
  type BorderLineStyle,
  type BorderSideStyle,
  type CellRangeRef,
  type GradientFillSpec,
  type HeaderFooterSections,
  type SheetPageSettings,
  type SheetPicture,
} from "@/lib/excel/ooxml-page-settings";
import { evaluateConditionalFormats } from "@/lib/excel/conditional-format";
import { drawChart, type ChartRangeResolver, type ChartTextApi } from "@/lib/excel/chart-render";
import { parseRangeRef } from "@/lib/excel/ooxml-charts";
import { excelSerialToDate, formatExcelDate } from "@/lib/excel/excel-date-format";
import { excelNumberFormatColor, excelTextFormatColor, formatExcelNumber, formatExcelText, formatGeneralNumber } from "@/lib/excel/excel-number-format";
import { computePageGrid, type FitPageSettings } from "@/lib/excel/pagination";
import { checkChart, sortIssues, type ChartPageCheckResult, type ChartPageIssue, type CheckArea, type CheckPage } from "@/lib/excel/chart-page-check";
import type * as PdfLibTypes from "pdf-lib";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";

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
 * （開発指示書E章）。数式の再計算・ピボット/グラフ・複雑な図形は再現せず、警告で知らせる。
 *
 * 反映する書式（すべてブラウザ内で完結）:
 *  - セルの背景色・文字色・太字・斜体・下線・取り消し線・上付き/下付き・明朝体/ゴシック体
 *  - セル内の部分的な書式（リッチテキスト）
 *  - 罫線の種類（極細・点線・破線・二重線・太線など）・斜めの罫線・結合セルの外周
 *  - 条件付き書式（数式・値の比較・文字列・重複・上位下位・平均・色スケール・データバー）
 *  - 結合セル・横/縦位置・折り返し・縮小して全体を表示・字下げ・均等割り付け・選択範囲内で中央・
 *    文字の回転・縦書き
 *  - 数値・日付・文字列の表示形式
 *  - 印刷範囲（複数可）・印刷タイトル・用紙・向き・余白・拡大縮小・改ページ・ヘッダー/フッター
 *    （先頭ページ/偶数ページ別）・枠線の印刷・白黒印刷・ページ中央配置
 *  - 画像と単純な図形（四角・角丸・楕円・直線）
 */

/**
 * 用紙の大きさ(pt。縦向き)。キーは ooxml-page-settings.ts の PAPER_SIZE_MAP の用紙名。
 * B4・B5・B6 はExcelと同じ日本のJIS規格（257×364mm・182×257mm・128×182mm）。
 * 以前はB4だけISO規格(250×353mm)の大きさで出力していた（B5はJIS）。ISO規格のB列は「B4-ISO」「B5-ISO」。
 */
const mm = (v: number) => Math.round((v * 72 * 100) / 25.4) / 100;
const PAPER_SIZES_PT: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  A3: { width: 841.89, height: 1190.55 },
  A2: { width: 1190.55, height: 1683.78 },
  A5: { width: 419.53, height: 595.28 },
  A6: { width: 297.64, height: 419.53 },
  B4: { width: mm(257), height: mm(364) },
  B5: { width: mm(182), height: mm(257) },
  B6: { width: mm(128), height: mm(182) },
  "B4-ISO": { width: mm(250), height: mm(353) },
  "B5-ISO": { width: mm(176), height: mm(250) },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
  Tabloid: { width: 792, height: 1224 },
  Ledger: { width: 1224, height: 792 },
  Statement: { width: 396, height: 612 },
  Executive: { width: 522, height: 756 },
  Folio: { width: 612, height: 936 },
  Quarto: { width: mm(215), height: mm(275) },
  Postcard: { width: mm(100), height: mm(148) },
  DoublePostcard: { width: mm(200), height: mm(148) },
};
const DEFAULT_PAPER_SIZE = "A4";
/**
 * Excel側の余白の指定(<pageMargins>)が無い場合の余白(pt)。Excelの「標準」の余白と同じ
 * (左右0.7インチ・上下0.75インチ・ヘッダー/フッター0.3インチ)。Excelは余白の指定が無いシートをこの余白で印刷する。
 */
const DEFAULT_MARGINS_PT = { left: 50.4, right: 50.4, top: 54, bottom: 54, header: 21.6, footer: 21.6 };
const MAX_ROWS_TOTAL = 50000;
const MAX_PAGE_COUNT = 500;
const MIN_COL_WIDTH = 24;
const MAX_COL_WIDTH = 220;
const TEXT_COLOR: [number, number, number] = [0.13, 0.13, 0.15];
/** 上付き・下付き文字の大きさの比率 */
const SCRIPT_SIZE_RATIO = 0.65;
/** 斜体: 文字を右へ傾ける角度(度)。日本語フォントには斜体がないため、文字を傾けて近似する */
const ITALIC_SKEW_DEG = 12;

/**
 * 罫線の種類ごとの描画仕様。widthはExcelで印刷したときの線の太さ(pt。ページの縮小率を掛けて使う)、
 * dashは線と空白の長さ(pt。実線はnull)、doubleは二重線(2本の細い線を、間をあけて引く)。
 * rankは、隣り合うセルが同じ辺に別々の罫線を持つとき、強い方だけを描くための強さの順位。
 */
const BORDER_SPECS: Record<BorderLineStyle, { width: number; dash: number[] | null; double?: boolean; rank: number }> = {
  hair: { width: 0.25, dash: null, rank: 1 },
  dotted: { width: 0.5, dash: [1, 1], rank: 2 },
  dashDotDot: { width: 0.5, dash: [3, 1.5, 1, 1.5, 1, 1.5], rank: 3 },
  dashDot: { width: 0.5, dash: [3, 1.5, 1, 1.5], rank: 3 },
  dashed: { width: 0.5, dash: [3, 1.5], rank: 3 },
  thin: { width: 0.5, dash: null, rank: 4 },
  mediumDashDotDot: { width: 1, dash: [4, 2, 1, 2, 1, 2], rank: 5 },
  slantDashDot: { width: 1, dash: [4, 2, 1, 2], rank: 5 },
  mediumDashDot: { width: 1, dash: [4, 2, 1, 2], rank: 5 },
  mediumDashed: { width: 1, dash: [4, 2], rank: 5 },
  medium: { width: 1, dash: null, rank: 6 },
  double: { width: 0.5, dash: null, double: true, rank: 7 },
  thick: { width: 1.75, dash: null, rank: 8 },
};
const BORDER_FALLBACK: BorderSideStyle = { style: "thin", color: null };

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
  numFormatCode: string | null = null,
  date1904 = false
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && dateFormatCode) {
    // 日付の書式なのに数値のまま読み込まれたセル(読み込みライブラリが日付の書式と判定できない、和暦
    // 「[$-ja-JP]ggge"年"m"月"d"日"」など)。以前は「46332」のような日数のまま表示していた。日付に直して整形する。
    const date = excelSerialToDate(value, date1904);
    if (date) return formatExcelDate(date, dateFormatCode);
  }
  if (value instanceof Date) {
    // read-excel-fileはExcelの日付をUTC基準のDateで返す。ローカル時刻(getHours等)で読むと
    // 日本時間では9時間ずれて「09:00:00」が付いてしまうため、UTCで読み、Excelの表示書式で整形する。
    return formatExcelDate(value, dateFormatCode);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    // 数値はExcelの表示書式(桁区切り・小数桁・%・通貨記号など)で整形する。解釈できない書式は標準の表示。
    if (numFormatCode) {
      const formatted = formatExcelNumber(value, numFormatCode);
      if (formatted !== null) return formatted;
    }
    return formatGeneralNumber(value);
  }
  // 文字列: 「@"様"」のような文字列用の表示形式があれば適用する。
  // 文字列として保存されている「先頭ゼロ」等の値は、read-excel-fileが返した型(string)をそのまま尊重する。
  if (numFormatCode) {
    const formatted = formatExcelText(String(value), numFormatCode);
    if (formatted !== null) return formatted;
  }
  return String(value);
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
  /**
   * 先頭行を見出し行として各ページ上部に繰り返す。
   * Excelの「印刷タイトル」(行)が設定されているシートでは、そちらを優先する(この設定は使わない)。
   */
  repeatHeaderRow: boolean;
}

export interface ExcelToPdfOutput extends Omit<PdfProcessorOutput, "url"> {
  warnings: string[];
  sheetCount: number;
  totalRowCount: number;
  /** グラフとページの境目の関係(このPDFのページの分け方で調べたもの) */
  chartPageCheck: ChartPageCheckResult;
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

/** グラデーションの位置t(0〜1)の色。区切り(stop)の間は直線的に混ぜる */
function gradientColorAt(spec: GradientFillSpec, t: number): [number, number, number] {
  const stops = spec.stops;
  if (t <= stops[0].position) return hexToRgb01(stops[0].color);
  const last = stops[stops.length - 1];
  if (t >= last.position) return hexToRgb01(last.color);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (t >= a.position && t <= b.position) {
      const u = b.position > a.position ? (t - a.position) / (b.position - a.position) : 0;
      const ca = hexToRgb01(a.color);
      const cb = hexToRgb01(b.color);
      return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u];
    }
  }
  return hexToRgb01(last.color);
}

/**
 * 線形グラデーションを、細い色の帯を並べて描く（pdf-libにはグラデーションの塗りの機能が無いため）。
 * 向きはExcelのdegree: 0=左→右、90=上→下、180=右→左、270=下→上。斜め(45°など)は近い方の向き(横か縦)で描く。
 * span: 結合セル全体の中でのこのセルの位置(倍率をかける前のpt)。結合範囲全体で1本のグラデーションにする。
 */
function drawGradientCell(
  page: PDFPage,
  spec: GradientFillSpec,
  box: { x: number; yTop: number; width: number; height: number },
  span: { offX: number; totalW: number; offY: number; totalH: number },
  scale: number
) {
  const d = spec.degree;
  const horizontal = d < 45 || d >= 315 || (d >= 135 && d < 225);
  const reversed = horizontal ? d >= 135 && d < 225 : d >= 225 && d < 315;
  const cellLen = horizontal ? box.width : box.height;
  const totalLen = (horizontal ? span.totalW : span.totalH) * scale;
  const offset = (horizontal ? span.offX : span.offY) * scale;
  if (cellLen <= 0 || totalLen <= 0) return;
  // 帯の数：範囲全体で約48本（1本あたり最低1.5pt）。帯の継ぎ目に隙間が見えないよう、少しだけ重ねる
  const bands = Math.max(2, Math.min(96, Math.round((48 * cellLen) / totalLen), Math.ceil(cellLen / 1.5)));
  const step = cellLen / bands;
  for (let k = 0; k < bands; k++) {
    const mid = offset + step * (k + 0.5);
    const t = Math.min(1, Math.max(0, mid / totalLen));
    const color = pdfLib().rgb(...gradientColorAt(spec, reversed ? 1 - t : t));
    const overlap = k < bands - 1 ? 0.3 : 0;
    if (horizontal) {
      page.drawRectangle({ x: box.x + step * k, y: box.yTop - box.height, width: step + overlap, height: box.height, color });
    } else {
      page.drawRectangle({ x: box.x, y: box.yTop - step * (k + 1) - overlap, width: box.width, height: step + overlap, color });
    }
  }
}

/** 昇順の元インデックス配列に対して、OOXMLの改ページ位置（元インデックス基準）をローカルインデックス基準へ変換する */
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

// ---------------------------------------------------------------------------
// 文字の書式と折り返し(リッチテキスト・斜体・下線などを1文字ずつ持つ)
// ---------------------------------------------------------------------------
interface TextStyle {
  /** 文字サイズ(pt。ページの縮小前) */
  fs: number;
  bold: boolean;
  italic: boolean;
  underline: "single" | "double" | null;
  strike: boolean;
  /** "#RRGGBB"。nullはセルの既定の文字色(自動) */
  color: string | null;
  serif: boolean;
  vertAlign: "super" | "sub" | null;
}

interface Glyph {
  ch: string;
  style: TextStyle;
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2e80;
}

/** 行頭に置かない文字(句読点・閉じ括弧・長音など)。折り返し位置がここになるときは1文字前で折る */
const NO_LINE_START = new Set(Array.from("、。，．）〕］｝〉》」』】！？ー・…ぁぃぅぇぉっゃゅょァィゥェォッャュョ)]},.!?:;"));

/** 1段落ぶんの文字列を、幅(maxWidth)に収まるよう行へ分ける。半角英数は単語単位、日本語は文字単位で折り返す */
function wrapParagraph(glyphs: Glyph[], maxWidth: number, measure: (g: Glyph) => number): Glyph[][] {
  const lines: Glyph[][] = [];
  let start = 0;
  let width = 0;
  let lastBreak = -1;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const w = measure(g);
    if (i > start && width + w > maxWidth && g.ch !== " ") {
      let brk = lastBreak > start ? lastBreak : i;
      // 行頭禁則: 句読点などが行頭に来ないよう、1文字前で折る
      while (brk > start + 1 && brk < glyphs.length && NO_LINE_START.has(glyphs[brk].ch)) brk--;
      lines.push(glyphs.slice(start, brk));
      start = brk;
      width = 0;
      for (let j = start; j < i; j++) width += measure(glyphs[j]);
      lastBreak = -1;
    }
    width += w;
    if (isCjk(g.ch)) {
      if (i > start) lastBreak = Math.max(lastBreak, i);
      lastBreak = Math.max(lastBreak, i + 1);
    } else if (g.ch === " " || g.ch === "-" || g.ch === "/") {
      lastBreak = i + 1;
    }
  }
  lines.push(glyphs.slice(start));
  return lines;
}

/** 文字列を、改行で段落に分け、さらに幅で折り返した行の配列にする(wrapWidthがnullなら折り返さず、改行は無視して1行) */
function layoutGlyphs(glyphs: Glyph[], wrapWidth: number | null, measure: (g: Glyph) => number): Glyph[][] {
  if (wrapWidth === null) return [glyphs.filter((g) => g.ch !== "\n")];
  const paragraphs: Glyph[][] = [[]];
  for (const g of glyphs) {
    if (g.ch === "\n") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(g);
  }
  const lines: Glyph[][] = [];
  for (const p of paragraphs) {
    if (p.length === 0) lines.push([]);
    else lines.push(...wrapParagraph(p, Math.max(1, wrapWidth), measure));
  }
  return lines.length > 0 ? lines : [[]];
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

/** 描画できない文字(フォントに無い文字)でも落ちないよう、幅の計算を保護する */
/**
 * 外字(私用領域の文字 U+E000〜U+F8FF)かどうか。
 * 学校・役所などで、人名の異体字のために各パソコンへ登録した「外字」がここに入る。
 * 外字はそのパソコンの中にしか字形が無いため、Excelファイルには文字コードしか残らず、
 * 別のパソコンやこのツールでは正しい字形を表示できない(どのフォントにも字形が無い)。
 */
function isPrivateUseChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && code <= 0xffffd) || (code >= 0x100000 && code <= 0x10fffd);
}

/** 外字は「〓(げた)」で表示する。印刷物で「字形が出せない文字」を表す慣習の記号で、空白や四角の欠けより見落としにくい */
const GAIJI_PLACEHOLDER = "〓";
function displayCharOf(ch: string): string {
  return isPrivateUseChar(ch) ? GAIJI_PLACEHOLDER : ch;
}

function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function safeUnitWidth(font: PDFFont, ch: string): number {
  try {
    return font.widthOfTextAtSize(ch, 1000) / 1000;
  } catch {
    return 0.5;
  }
}

/** PNG・JPEG以外の画像(GIF・BMP等)を、ブラウザの機能でPNGへ変換する。変換できなければnull */
async function convertImageToPng(bytes: Uint8Array, ext: string): Promise<Uint8Array | null> {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
    const mimeByExt: Record<string, string> = { gif: "image/gif", bmp: "image/bmp", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff" };
    const mime = mimeByExt[ext.toLowerCase()];
    if (!mime) return null;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    const canvas = document.createElement("canvas");
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
    } finally {
      // 描画が終われば ImageBitmap は不要。失敗したときも必ず解放する
      bitmap.close();
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

type Side = "top" | "bottom" | "left" | "right";

interface PictureAnchorLike {
  fromCol: number;
  fromRow: number;
  fromColOffPt: number;
  fromRowOffPt: number;
  toCol: number | null;
  toRow: number | null;
  toColOffPt: number;
  toRowOffPt: number;
  extWidthPt: number | null;
  extHeightPt: number | null;
}

export class ExcelToPdfProcessor extends BrowserProcessor<ExcelToPdfInput, ExcelToPdfOutput> {
  async process(input: ExcelToPdfInput): Promise<ExcelToPdfOutput> {
    return this.run(input, false);
  }

  /**
   * 変換の前の確認：グラフがページの境目にかかっていないかを調べる。
   * PDFを作るときと同じ処理(印刷範囲・余白・倍率・改ページ・何も無いページの省略)でページの分け方を決め、
   * ページを描く手前で止める(ページの分け方を別に計算しないので、実際のPDFと食い違わない)。PDFは作らない
   */
  async analyzeChartPages(input: ExcelToPdfInput): Promise<ChartPageCheckResult> {
    return (await this.run(input, true)).chartPageCheck;
  }

  private async run({ file, sheets, selectedSheetNames, orientation, fitMode, repeatHeaderRow }: ExcelToPdfInput, analyzeOnly: boolean): Promise<ExcelToPdfOutput> {
    await ensurePdfLib({ fontkit: true });
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

    let doc: PdfLibTypes.PDFDocument;
    let font: PDFFont;
    try {
      doc = await pdfLib().PDFDocument.create();
      doc.registerFontkit(fontkitLib());
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }
    let serifFont: PDFFont | null = null;

    // Excel印刷設定の取得(取得できなければ空のMap。以後は全てフォールバックへ進む。開発指示書B-19)
    let pageSettingsBySheet: Map<string, SheetPageSettings>;
    try {
      pageSettingsBySheet = await parseWorkbookPageSettings(file);
    } catch {
      pageSettingsBySheet = new Map();
    }

    const warnings: string[] = [];

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

    // 外字(そのパソコン専用の文字)を含むセルは、PDFでは正しい字形にならないため、場所を知らせる
    for (const sheet of sheetsToRender) {
      const cells: string[] = [];
      let total = 0;
      sheet.rows.forEach((row, r) => {
        row.forEach((value, c) => {
          if (typeof value !== "string" || !Array.from(value).some(isPrivateUseChar)) return;
          total++;
          if (cells.length < 8) cells.push(`${columnLetters(c)}${r + 1}`);
        });
      });
      if (total > 0) {
        warnings.push(
          `「${sheet.name}」の${cells.join("・")}${total > cells.length ? `など${total}か所` : ""}に外字(そのパソコン専用の文字)が含まれています。外字はExcelファイルに字形が保存されていないため、PDFでは「〓」で表示されます。正しい字形で出したい場合は、Excelで印刷して「Microsoft Print to PDF」などでPDFにしてください。`
        );
      }
    }

    // 明朝体を使うセルがあるときだけ、明朝体フォント(約3MB。JIS X 0208の漢字・かな・英数字に絞ったもの)を読み込んで埋め込む。
    const needsSerif = sheetsToRender.some((s) => {
      const st = pageSettingsBySheet.get(s.name);
      if (!st) return false;
      if (st.defaultFontSerif) return true;
      for (const ex of st.cellFontExtras.values()) if (ex.serif === true) return true;
      for (const runs of st.cellRich.values()) if (runs.some((r) => r.serif === true)) return true;
      return false;
    });
    if (needsSerif) {
      try {
        const serifBytes = await loadJapaneseSerifFontBytes();
        serifFont = await doc.embedFont(new Uint8Array(serifBytes), { subset: false });
      } catch {
        serifFont = null;
        warnings.push("明朝体フォントの読み込みに失敗したため、明朝体のセルも標準の書体で出力しました");
      }
    }
    const fontOf = (serif: boolean): PDFFont => (serif && serifFont ? serifFont : font);

    // 文字幅のキャッシュ(1文字ずつの幅を何度も計算しない)
    const unitWidthCache = new Map<PDFFont, Map<string, number>>();
    const unitWidth = (f: PDFFont, ch: string): number => {
      let m = unitWidthCache.get(f);
      if (!m) {
        m = new Map();
        unitWidthCache.set(f, m);
      }
      let w = m.get(ch);
      if (w === undefined) {
        w = safeUnitWidth(f, ch);
        m.set(ch, w);
      }
      return w;
    };
    const textWidth = (f: PDFFont, text: string, size: number): number => {
      let sum = 0;
      for (const ch of Array.from(text)) sum += unitWidth(f, ch);
      return sum * size;
    };
    /** 文字1つの幅(sizeFactor = ページの縮小率×「縮小して全体を表示」の倍率) */
    const glyphWidth = (g: Glyph, sizeFactor: number): number =>
      unitWidth(fontOf(g.style.serif), g.ch) * g.style.fs * (g.style.vertAlign ? SCRIPT_SIZE_RATIO : 1) * sizeFactor;
    const lineWidthOf = (line: Glyph[], sizeFactor: number): number => line.reduce((sum, g) => sum + glyphWidth(g, sizeFactor), 0);

    // グラフの文字(chart-render.ts)。セルと同じフォントで、1文字ずつ描く(drawTextRobust)
    const chartText: ChartTextApi = {
      width: (str, size) => textWidth(font, str, size),
      draw: (page, str, x, y, size, color, bold, angleDeg = 0) => {
        drawTextRobust(page, str, x, y, size, pdfLib().rgb(...hexToRgb01(color)), font, bold, false, angleDeg);
      },
    };
    /** グラフに値が保存されていないとき、参照先のセル範囲(例: 'Sheet1'!$B$2:$B$7)の値をシートから読む */
    const makeChartResolver = (currentSheet: string): ChartRangeResolver => {
      const lookup = pageSettingsBySheet.get(currentSheet)?.chartLookup;
      const resolveRef = (ref0: string, visibleOnly: boolean, depth: number): ReturnType<ChartRangeResolver> => {
        const ref = ref0.trim().replace(/^=/, "");
        if (depth > 3 || !ref) return null;
        // 別のブック([1]Sheet1!$B$2:$B$5 / '[1]Sheet 1'!…)：ブックの中に保存されている値の控え(externalLink)から読む
        const ext = /^'?\[(\d+)\]((?:[^'!]|'')*)'?!(.+)$/.exec(ref);
        if (ext) {
          const cells = lookup?.external.get(ext[1])?.get(ext[2].replace(/''/g, "'").toLowerCase());
          const range = parseRangeRef(ext[3]);
          if (!cells || !range) return null;
          const values: (string | number | null)[] = [];
          for (let r = range.startRow; r <= range.endRow; r++) {
            for (let c = range.startCol; c <= range.endCol; c++) {
              let col = "";
              for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) col = String.fromCharCode(65 + ((n - 1) % 26)) + col;
              values.push(cells.get(`${col}${r + 1}`) ?? null);
            }
          }
          if (values.every((v) => v === null)) return null;
          return { values, display: values.map((v) => (v === null ? "" : String(v))) };
        }
        const range = parseRangeRef(ref);
        if (!range) {
          // 名前の定義(Sheet1!売上データ・売上データ・Book1.xlsx!売上データ・[0]!売上データ)
          const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?([^!]+)$/.exec(ref);
          if (!m) return null;
          const scope = (m[1] ?? m[2] ?? "").replace(/''/g, "'");
          const nm = m[3].toLowerCase();
          const local = scope && !/^\[0\]$|\.xls[xmb]?$/i.test(scope) ? lookup?.localNames.get(scope)?.get(nm) : lookup?.localNames.get(currentSheet)?.get(nm);
          const target = local ?? lookup?.names.get(nm);
          return target ? resolveRef(target, visibleOnly, depth + 1) : null;
        }
        return readCells(range, visibleOnly);
      };
      const readCells = (range: NonNullable<ReturnType<typeof parseRangeRef>>, visibleOnly: boolean): ReturnType<ChartRangeResolver> => {
        const name = range.sheet ?? currentSheet;
        const target = sheets.find((sh) => sh.name === name);
        if (!target) return null;
        const st = pageSettingsBySheet.get(name) ?? null;
        const values: (string | number | null)[] = [];
        const display: string[] = [];
        let format: string | null | undefined;
        const cellCount = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
        if (cellCount > 100_000) return null;
        for (let r = range.startRow; r <= range.endRow; r++) {
          // 非表示の行・列は、グラフの「表示されているセルだけ」(既定)では使わない
          if (visibleOnly && st?.hiddenRows.has(r) && range.endRow > range.startRow) continue;
          for (let c = range.startCol; c <= range.endCol; c++) {
            if (visibleOnly && st?.hiddenCols.has(c) && range.endCol > range.startCol) continue;
            const raw = target.rows[r]?.[c] ?? null;
            values.push(raw instanceof Date ? raw.getTime() / 86_400_000 + 25569 : typeof raw === "boolean" ? (raw ? 1 : 0) : raw === undefined ? null : (raw as string | number | null));
            const dateFmt = st?.cellDateFormat.get(`${r}:${c}`) ?? null;
            const numFmt = st?.cellNumFormat.get(`${r}:${c}`) ?? null;
            if (format === undefined && raw !== null && raw !== "") format = dateFmt ?? numFmt ?? null;
            display.push(cellToDisplayString(raw, dateFmt, numFmt, st?.date1904 ?? false));
          }
        }
        return { values, display, format: format ?? null };
      };
      return (ref, opts) => resolveRef(ref, opts?.visibleOnly ?? true, 0);
    };
    /** 値を読めない系列があったグラフ(グラフごとに1回だけ数える。ページをまたいで何度描いても同じ) */
    const unresolvedCharts = new Map<object, { sheet: string; series: number }>();
    let chartsDrawn = 0;
    let chartDrawFailures = 0;
    /** 何も無いため出力しなかったページの数 */
    let skippedBlankPages = 0;
    /** グラフとページの境目の確認の結果 */
    const chartIssues: ChartPageIssue[] = [];
    let checkedCharts = 0;
    /** 確認だけのとき(ページを作らない)に、作るはずのページを数える */
    let analyzedPageCount = 0;
    /**
     * 描けないグラフの場所に、薄い灰色の点線の枠と説明を出す(グラフが黙って消えた状態のPDFにしない)。
     * 別の種類のグラフとして描き替えることはしない。
     */
    const drawChartPlaceholder = (page: PDFPage, p: { x: number; y: number; w: number; h: number }, reason: string, k: number) => {
      const gray = pdfLib().rgb(0.55, 0.55, 0.55);
      page.drawRectangle({ x: p.x, y: p.y, width: p.w, height: p.h, color: pdfLib().rgb(0.97, 0.97, 0.97), borderColor: gray, borderWidth: 0.75 * k, borderDashArray: [3 * k, 2 * k] });
      const size = Math.max(5, Math.min(10 * k, p.w / 22));
      const lines = ["このグラフは表示できません", `（${reason}）`];
      let y = p.y + p.h / 2 + size * 0.6;
      for (const ln of lines) {
        const w = textWidth(font, ln, size);
        drawTextRobust(page, ln, p.x + Math.max(2, (p.w - w) / 2), y - size * 0.35, size, gray, font);
        y -= size * 1.5;
      }
    };

    // ヘッダー/フッター(B-9・B-10)の&D(日付)・&T(時刻)トークン解決用に、
    // 変換実行時刻を1回だけ取得する(ページごとに変わると使いにくいため)。
    const now = new Date();
    // &D(日付)は、日本語のWindowsのExcelと同じ「yyyy/mm/dd」（OSの短い日付の形式）で表示する
    const nowDateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
    const nowTimeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

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
     * 文字列を1文字ずつdrawTextで描く（Phase 9で判明した重要な問題への対処）。
     * pdf-lib+fontkitで、英字に数字が直接続く文字列を1回のdrawText呼び出しで描画すると、
     * PDFのテキスト情報だけが無関係な文字に化ける現象への対処（実機検証済み）。
     * angleDegは文字列の進む向き(反時計回りの角度)。italicは文字を傾けて近似する。
     * 戻り値は、文字列全体の進んだ長さ。
     */
    function drawTextRobust(
      page: PDFPage,
      text: string,
      x: number,
      y: number,
      size: number,
      color: ReturnType<typeof PdfLibTypes.rgb>,
      embedFont: PDFFont,
      bold = false,
      italic = false,
      angleDeg = 0
    ): number {
      // 太字フォント資産は無い(既存資産はRegularのみ)ため、word-to-pdf.tsと
      // 同じ「塗り+縁取り(FillAndOutline)」による疑似ボールドで近似する(開発指示書§29-31)。
      if (bold) {
        page.pushOperators(
          pdfLib().setLineWidth(size * 0.028),
          pdfLib().setStrokingRgbColor(color.red, color.green, color.blue),
          pdfLib().setTextRenderingMode(pdfLib().TextRenderingMode.FillAndOutline)
        );
      }
      const rad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      // pdf-libは、drawTextにfontを渡すたびに(さらに描いたあと元のフォントへ戻すときにも)、ページのフォントの一覧へ
      // 新しい名前を追加する。1文字ずつ描くため、1ページに数千〜数万の名前ができ、PDFが大きく重くなり、
      // PDFを開くソフトによっては(popplerを使うものなど)、メモリが足りなくなって開けなかった。
      // ページのフォントが違うときだけ1回設定し、drawTextにはfontを渡さない(同じ名前を使い回す)。
      if ((page as unknown as { font?: PDFFont }).font !== embedFont) page.setFont(embedFont);
      let advance = 0;
      for (const ch of Array.from(text)) {
        try {
          page.drawText(ch, {
            x: x + advance * cos,
            y: y + advance * sin,
            size,
            color,
            ...(angleDeg !== 0 ? { rotate: pdfLib().degrees(angleDeg) } : {}),
            ...(italic ? { ySkew: pdfLib().degrees(ITALIC_SKEW_DEG) } : {}),
          });
        } catch {
          // フォントに無い文字は描かない(幅だけ進める)
        }
        advance += unitWidth(embedFont, ch) * size;
      }
      if (bold) {
        page.pushOperators(pdfLib().setTextRenderingMode(pdfLib().TextRenderingMode.Fill));
      }
      return advance;
    }

    /**
     * 同じ書式が続く文字のまとまりごとに、1行ぶんの文字を描く。下線・取り消し線もここで引く。
     * (x, y)は行の左端のベースライン。angleDegは行の向き(反時計回り)。戻り値は行の長さ。
     */
    function drawGlyphLine(
      page: PDFPage,
      line: Glyph[],
      x: number,
      y: number,
      sizeFactor: number,
      defaultColor: ReturnType<typeof PdfLibTypes.rgb>,
      blackAndWhite: boolean,
      angleDeg = 0
    ): number {
      const rad = (angleDeg * Math.PI) / 180;
      const ux = Math.cos(rad);
      const uy = Math.sin(rad);
      const nx = -uy;
      const ny = ux;
      let advance = 0;
      let i = 0;
      while (i < line.length) {
        const style = line[i].style;
        let j = i;
        let text = "";
        while (j < line.length && line[j].style === style) {
          text += line[j].ch;
          j++;
        }
        const size = style.fs * (style.vertAlign ? SCRIPT_SIZE_RATIO : 1) * sizeFactor;
        const f = fontOf(style.serif);
        // 上付きは基準より上へ、下付きは下へずらす
        const shift = style.vertAlign === "super" ? style.fs * 0.33 * sizeFactor : style.vertAlign === "sub" ? -style.fs * 0.12 * sizeFactor : 0;
        const bx = x + advance * ux + shift * nx;
        const by = y + advance * uy + shift * ny;
        const color = style.color && !blackAndWhite ? pdfLib().rgb(...hexToRgb01(style.color)) : defaultColor;
        const len = drawTextRobust(page, text, bx, by, size, color, f, style.bold, style.italic, angleDeg);
        if (style.underline || style.strike) {
          const thickness = Math.max(0.3, size * 0.06);
          const lineAt = (offset: number) => {
            page.drawLine({
              start: { x: bx + offset * nx, y: by + offset * ny },
              end: { x: bx + len * ux + offset * nx, y: by + len * uy + offset * ny },
              thickness,
              color,
            });
          };
          if (style.underline) {
            lineAt(-size * 0.12);
            if (style.underline === "double") lineAt(-size * 0.12 - thickness * 2.2);
          }
          if (style.strike) lineAt(size * 0.3);
        }
        advance += len;
        i = j;
      }
      return advance;
    }

    /**
     * ヘッダー/フッターの左/中央/右セクションを1行で描画する(B-9・B-10)。
     * Excel側で実際に設定されている場合のみ呼び出す側で呼ぶため、ここでは
     * 「与えられたセクションをそのまま描く」ことだけに責務を絞っている。
     */
    /**
     * ヘッダー/フッターを描く。文字サイズは &nn の指定があればそれ、無ければブックの標準の文字サイズ(Excelと同じ。通常11pt)。
     * 色はExcelの既定(自動＝黒)。scaleWithDoc(既定オン)のときは、表と同じ倍率で拡大縮小する。
     */
    function drawHeaderFooterSections(
      page: PDFPage,
      sections: HeaderFooterSections,
      baselineY: number,
      areaLeft: number,
      areaRight: number,
      baseSize: number,
      scaleFactor: number
    ) {
      const color = pdfLib().rgb(...TEXT_COLOR);
      const sizeOf = (key: "left" | "center" | "right") => Math.max(4, (sections.sizes?.[key] ?? baseSize) * scaleFactor);
      if (sections.left) {
        drawTextRobust(page, sections.left, areaLeft, baselineY, sizeOf("left"), color, font);
      }
      if (sections.center) {
        const size = sizeOf("center");
        const w = textWidth(font, sections.center, size);
        drawTextRobust(page, sections.center, areaLeft + (areaRight - areaLeft - w) / 2, baselineY, size, color, font);
      }
      if (sections.right) {
        const size = sizeOf("right");
        const w = textWidth(font, sections.right, size);
        drawTextRobust(page, sections.right, areaRight - w, baselineY, size, color, font);
      }
    }

    let sheetCount = 0;

    for (const sheet of sheetsToRender) {
      sheetCount++;
      const settings = pageSettingsBySheet.get(sheet.name) ?? null;
      const blackAndWhite = settings?.blackAndWhite ?? false;

      // ---- シート全体の準備 ----------------------------------------------------
      const totalColCount = Math.max(...sheet.rows.map((r) => r.length), 1);
      // read-excel-fileは末尾の空行・空列(値が無いセル)を返さないが、罫線や背景色だけが設定された
      // セルはExcelでは印刷される(例: 表の最終行の下罫線が、値の無い最後の行にだけ引かれている)。
      // 印刷範囲が指定されている場合は、書式が設定されたセルの範囲までを描画対象に含める。
      let styledLastRow = -1;
      let styledLastCol = -1;
      for (const map of [settings?.cellBorders, settings?.cellFills, settings?.cellDiagonals]) {
        if (!map) continue;
        for (const key of map.keys()) {
          const [r, c] = key.split(":").map(Number);
          if (r > styledLastRow) styledLastRow = r;
          if (c > styledLastCol) styledLastCol = c;
        }
      }
      let contentLastRow = Math.max(sheet.rows.length - 1, styledLastRow);
      let contentLastCol = Math.max(totalColCount - 1, styledLastCol);
      // 画像・図形だけがある範囲も、印刷範囲の指定が無ければ印刷される(下で求める)
      let drawingLastRow = -1;
      let drawingLastCol = -1;

      const areas: (CellRangeRef | null)[] =
        settings && settings.printAreas.length > 0 ? settings.printAreas : [settings?.printArea ?? null];

      // --- 用紙サイズ・向き・余白(シート共通) ---
      const effectiveOrientation: PageOrientation = orientation !== "auto" ? orientation : settings?.orientation ?? "portrait";
      const paperKey = settings?.paperSize ?? DEFAULT_PAPER_SIZE;
      const paper = PAPER_SIZES_PT[paperKey] ?? PAPER_SIZES_PT[DEFAULT_PAPER_SIZE];
      if (settings && settings.paperSize === null && settings.paperSizeCode !== null && settings.paperSizeCode !== 9) {
        warnings.push(`「${sheet.name}」の用紙サイズ(Excelの用紙番号${settings.paperSizeCode})は未対応のため、A4で出力しました`);
      }
      const pageWidth = effectiveOrientation === "landscape" ? paper.height : paper.width;
      const pageHeight = effectiveOrientation === "landscape" ? paper.width : paper.height;
      const marginLeft = settings?.margins ? inchesToPt(settings.margins.left) : DEFAULT_MARGINS_PT.left;
      const marginRight = settings?.margins ? inchesToPt(settings.margins.right) : DEFAULT_MARGINS_PT.right;
      const marginTop = settings?.margins ? inchesToPt(settings.margins.top) : DEFAULT_MARGINS_PT.top;
      const marginBottom = settings?.margins ? inchesToPt(settings.margins.bottom) : DEFAULT_MARGINS_PT.bottom;
      const contentWidth = Math.max(50, pageWidth - marginLeft - marginRight);
      // シート名の自動タイトル(旧titleBlock)を撤廃した(B-9)ため、その分の予約高さも差し引かない。
      const contentHeightForData = Math.max(50, pageHeight - marginTop - marginBottom);
      const headerMarginPt = settings?.margins ? inchesToPt(settings.margins.header) : DEFAULT_MARGINS_PT.header;
      const footerMarginPt = settings?.margins ? inchesToPt(settings.margins.footer) : DEFAULT_MARGINS_PT.footer;

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

      const fontSizeFor = (origRow: number, origCol: number): number =>
        settings?.cellFontSizePt.get(`${origRow}:${origCol}`) ?? defaultFontSize;
      /** 1行ぶんの高さ。Excelの標準の行の高さ(defaultRowHeight)があれば文字サイズに比例させ、無ければ従来の「文字サイズ+3」 */
      const lineHeightFor = (fs: number): number => (defaultRowPt ? (defaultRowPt * fs) / defaultFontSize : fs + 3);
      const cellDisplayText = (row: RawCellValue[], origRow: number, origCol: number): string =>
        cellToDisplayString(
          row[origCol] ?? null,
          settings?.cellDateFormat.get(`${origRow}:${origCol}`) ?? null,
          settings?.cellNumFormat.get(`${origRow}:${origCol}`) ?? null,
          settings?.date1904 ?? false
        );

      // --- 結合セル: アンカー(左上)セルの文字を結合範囲全体にまたがって描画する ---
      const mergeByCell = new Map<string, { range: CellRangeRef; isAnchor: boolean }>();
      for (const range of settings?.merges ?? []) {
        // 極端に巨大な結合範囲(列全体・シート全体等)は、セルごとの索引を作るコストが大きいため対象外とする。
        if ((range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1) > 20000) continue;
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            mergeByCell.set(`${r}:${c}`, { range, isAnchor: r === range.startRow && c === range.startCol });
          }
        }
      }

      // --- 列幅・行の高さ(印刷範囲の外の行・列も、画像の位置計算のために求められるようにしておく) ---
      const fallbackColCache = new Map<number, number>();
      const fallbackColWidth = (origCol: number): number => {
        let v = fallbackColCache.get(origCol);
        if (v === undefined) {
          let widest = MIN_COL_WIDTH;
          for (const row of sheet.rows.slice(0, 200)) {
            const text = cellToDisplayString(row[origCol] ?? null).slice(0, 80);
            if (text !== "") widest = Math.max(widest, textWidth(font, text, 9));
          }
          v = Math.min(Math.max(widest + 14, MIN_COL_WIDTH), MAX_COL_WIDTH);
          fallbackColCache.set(origCol, v);
        }
        return v;
      };
      const colWidthOf = (origCol: number): number => {
        if (settings?.hiddenCols.has(origCol)) return 0;
        const known = settings?.columnWidthsPt.get(origCol);
        if (known !== undefined) return known;
        if (settings?.defaultColumnWidthPt) return settings.defaultColumnWidthPt;
        return origCol <= contentLastCol ? fallbackColWidth(origCol) : MIN_COL_WIDTH * 2;
      };

      /** セルに設定された書式と値から、文字ごとの書式つきの文字列を作る */
      const formatKey = (origRow: number, origCol: number): string => {
        const m = mergeByCell.get(`${origRow}:${origCol}`);
        return m ? `${m.range.startRow}:${m.range.startCol}` : `${origRow}:${origCol}`;
      };

      // 条件付き書式の評価は、シートの描画対象の範囲に対して1回だけ行う
      let cfStartRow = 0;
      let cfEndRow = sheet.rows.length - 1;
      let cfStartCol = 0;
      let cfEndCol = totalColCount - 1;
      if (areas.some((a) => a !== null)) {
        cfStartRow = Math.min(...areas.map((a) => (a ? Math.max(0, a.startRow) : 0)));
        cfEndRow = Math.max(...areas.map((a) => (a ? Math.min(contentLastRow, a.endRow) : sheet.rows.length - 1)));
        cfStartCol = Math.min(...areas.map((a) => (a ? Math.max(0, a.startCol) : 0)));
        cfEndCol = Math.max(...areas.map((a) => (a ? Math.min(contentLastCol, a.endCol) : totalColCount - 1)));
      }
      const cf =
        settings && settings.conditionalRules.length > 0
          ? evaluateConditionalFormats(
              settings.conditionalRules,
              (r, c) => sheet.rows[r]?.[c] ?? null,
              { startRow: cfStartRow, endRow: cfEndRow, startCol: cfStartCol, endCol: cfEndCol },
              { startRow: 0, endRow: Math.max(0, sheet.rows.length - 1), startCol: 0, endCol: Math.max(0, totalColCount - 1) }
            )
          : null;
      if (cf && cf.unsupportedCount > 0) {
        warnings.push(`「${sheet.name}」のExcelの条件付き書式のうち${cf.unsupportedCount}件は、再現できない種類（未対応の数式や関数など）のため反映していません`);
      }
      if (settings && settings.unsupportedDrawingCount > 0) {
        warnings.push(`「${sheet.name}」の複雑な図形など${settings.unsupportedDrawingCount}個は、再現できないため表示していません`);
      }
      if (settings && settings.charts.length > 0) {
        const unsupportedCharts = settings.charts.filter((c) => !c.model);
        if (unsupportedCharts.length > 0) {
          const reasons = Array.from(new Set(unsupportedCharts.map((c) => c.unsupportedReason ?? "不明な形式")));
          warnings.push(
            `「${sheet.name}」のグラフ${unsupportedCharts.length}個は、対応していない種類（${reasons.join("・")}）のため描けません。PDFでは、その場所に枠と説明を表示しています`
          );
        }
        const decorations = Array.from(new Set(settings.charts.flatMap((c) => c.model?.unsupportedDecorations ?? [])));
        if (decorations.length > 0) warnings.push(`「${sheet.name}」のグラフの一部の装飾（${decorations.join("・")}）は再現していません`);
      }

      const fillFor = (origRow: number, origCol: number): string | null => {
        if (blackAndWhite) return null; // 白黒印刷では背景色を印刷しない
        const key = formatKey(origRow, origCol);
        return cf?.fills.get(key) ?? settings?.cellFills.get(key) ?? null;
      };
      /** グラデーションの塗りつぶし（線形のみ。条件付き書式の背景色・白黒印刷のときは使わない） */
      const gradientFor = (origRow: number, origCol: number): GradientFillSpec | null => {
        if (blackAndWhite) return null;
        const key = formatKey(origRow, origCol);
        if (cf?.fills.has(key)) return null;
        const spec = settings?.cellGradients.get(key);
        return spec && spec.type === "linear" ? spec : null;
      };
      /**
       * グラデーションを描く範囲（結合セルなら結合範囲全体）の中で、このセルがどこにあるか(pt。倍率をかける前)。
       * 結合セルは各セルを順に塗るため、範囲全体で1本のグラデーションになるよう、位置をずらして色を決める。
       */
      const gradientSpanOf = (origRow: number, origCol: number) => {
        const merge = mergeByCell.get(`${origRow}:${origCol}`);
        if (!merge) return { offX: 0, totalW: colWidthOf(origCol), offY: 0, totalH: rowHeightOf(origRow) };
        const { startRow, endRow, startCol, endCol } = merge.range;
        let offX = 0;
        let totalW = 0;
        for (let c = startCol; c <= endCol; c++) {
          if (settings?.hiddenCols.has(c)) continue;
          if (c < origCol) offX += colWidthOf(c);
          totalW += colWidthOf(c);
        }
        let offY = 0;
        let totalH = 0;
        for (let r = startRow; r <= endRow; r++) {
          if (settings?.hiddenRows.has(r)) continue;
          if (r < origRow) offY += rowHeightOf(r);
          totalH += rowHeightOf(r);
        }
        return { offX, totalW: Math.max(totalW, colWidthOf(origCol)), offY, totalH: Math.max(totalH, rowHeightOf(origRow)) };
      };
      const borderFor = (origRow: number, origCol: number) => {
        const key = `${origRow}:${origCol}`;
        return settings?.cellBorders.get(key) ?? (cf?.borders.has(key) ? { top: true, bottom: true, left: true, right: true } : null);
      };

      /** セルの基本の書式(文字サイズ・太字・斜体・下線・色・書体) */
      /** 書式の色指定（[Red]など）。日付の書式には色を付けない */
      const formatColorOf = (origRow: number, origCol: number): string | null => {
        const key = `${origRow}:${origCol}`;
        const code = settings?.cellNumFormat.get(key) ?? null;
        if (!code || settings?.cellDateFormat.get(key)) return null;
        const v = sheet.rows[origRow]?.[origCol] ?? null;
        if (typeof v === "number") return excelNumberFormatColor(v, code);
        if (typeof v === "string") return excelTextFormatColor(code);
        return null;
      };
      const baseStyleOf = (origRow: number, origCol: number): TextStyle => {
        const fkey = formatKey(origRow, origCol);
        const extras = settings?.cellFontExtras.get(fkey);
        return {
          fs: fontSizeFor(origRow, origCol),
          bold: cf?.bold.get(fkey) ?? settings?.cellBold.get(fkey) ?? false,
          italic: cf?.italic.get(fkey) ?? extras?.italic ?? false,
          underline: cf?.underline.get(fkey) ?? extras?.underline ?? null,
          strike: cf?.strike.get(fkey) ?? extras?.strike ?? false,
          color: cf?.fontColors.get(fkey) ?? formatColorOf(origRow, origCol) ?? settings?.cellFontColors.get(fkey) ?? null,
          serif: extras?.serif ?? settings?.defaultFontSerif ?? false,
          vertAlign: extras?.vertAlign ?? null,
        };
      };
      const glyphsOf = (text: string, base: TextStyle, origRow: number, origCol: number, value: RawCellValue): Glyph[] => {
        const normalized = normalizeNewlines(text);
        const runs = typeof value === "string" ? settings?.cellRich.get(`${origRow}:${origCol}`) : undefined;
        if (runs && normalizeNewlines(runs.map((r) => r.text).join("")) === normalized) {
          const out: Glyph[] = [];
          for (const run of runs) {
            const style: TextStyle = {
              fs: run.fontSizePt ?? base.fs,
              bold: run.bold ?? base.bold,
              italic: run.italic ?? base.italic,
              underline: run.underline ?? base.underline,
              strike: run.strike ?? base.strike,
              color: run.color ?? base.color,
              serif: run.serif ?? base.serif,
              vertAlign: run.vertAlign ?? base.vertAlign,
            };
            for (const ch of Array.from(normalizeNewlines(run.text))) out.push({ ch: displayCharOf(ch), style });
          }
          return out;
        }
        return Array.from(normalized).map((ch) => ({ ch: displayCharOf(ch), style: base }));
      };
      const maxFontSizeOf = (line: Glyph[], fallback: number): number =>
        line.length === 0 ? fallback : Math.max(...line.map((g) => g.style.fs));

      const rowHeightCache = new Map<number, number>();
      const rowHeightOf = (origRow: number): number => {
        if (settings?.hiddenRows.has(origRow)) return 0;
        const cached = rowHeightCache.get(origRow);
        if (cached !== undefined) return cached;
        let height: number;
        const known = settings?.rowHeightsPt.get(origRow);
        if (known) {
          height = known;
        } else {
          // 行の高さ: Excel実測値があれば使い、無ければ折り返し後の行数から見積もる。
          // 結合セルの文字は、Excelでも行の自動の高さには影響しない(結合セルは自動調整の対象外)ため除外する。
          const row = sheet.rows[origRow] ?? [];
          let needed = 0;
          for (let origCol = 0; origCol <= contentLastCol; origCol++) {
            if (settings?.hiddenCols.has(origCol) || mergeByCell.has(`${origRow}:${origCol}`)) continue;
            const text = cellDisplayText(row, origRow, origCol);
            if (text === "") continue;
            const align = settings?.cellAlign.get(`${origRow}:${origCol}`);
            const wrap = align?.wrapText ?? false;
            const rotated = (align?.textRotation ?? 0) !== 0;
            const base = baseStyleOf(origRow, origCol);
            const glyphs = glyphsOf(text, base, origRow, origCol, row[origCol] ?? null);
            const lines = wrap && !rotated ? layoutGlyphs(glyphs, colWidthOf(origCol) - cellPadding * 2, (g) => glyphWidth(g, 1)) : [glyphs];
            let h = 0;
            for (const line of lines) h += lineHeightFor(maxFontSizeOf(line, base.fs));
            needed = Math.max(needed, h);
          }
          // 標準の行の高さが取得できた場合はそれを下限にする(Excelは何も保存されていない行を標準の高さで描く)。
          // 取得できない場合は従来の見積もり(行数×行の高さ+上下の余白)を維持する。
          height = defaultRowPt
            ? Math.max(defaultRowPt, needed)
            : Math.max(1, needed / lineHeightFor(defaultFontSize)) * lineHeightFor(defaultFontSize) + cellPadding * 2;
        }
        rowHeightCache.set(origRow, height);
        return height;
      };

      // 画像・図形の位置計算用: シート上の座標(左上が原点、縮小前のpt)
      const colLeftPrefix: number[] = [0];
      const rowTopPrefix: number[] = [0];
      const colLeftSheet = (c: number): number => {
        for (let i = colLeftPrefix.length - 1; i < Math.min(c, 20000); i++) colLeftPrefix.push(colLeftPrefix[i] + colWidthOf(i));
        return colLeftPrefix[Math.min(c, colLeftPrefix.length - 1)];
      };
      const rowTopSheet = (r: number): number => {
        for (let i = rowTopPrefix.length - 1; i < Math.min(r, 20000); i++) rowTopPrefix.push(rowTopPrefix[i] + rowHeightOf(i));
        return rowTopPrefix[Math.min(r, rowTopPrefix.length - 1)];
      };
      const anchorRect = (a: PictureAnchorLike) => {
        const x1 = colLeftSheet(a.fromCol) + a.fromColOffPt;
        const y1 = rowTopSheet(a.fromRow) + a.fromRowOffPt;
        const x2 = a.toCol !== null ? colLeftSheet(a.toCol) + a.toColOffPt : x1 + (a.extWidthPt ?? 0);
        const y2 = a.toRow !== null ? rowTopSheet(a.toRow) + a.toRowOffPt : y1 + (a.extHeightPt ?? 0);
        return { x1, y1, x2: Math.max(x2, x1), y2: Math.max(y2, y1) };
      };

      // 画像の読み込み(PNG・JPEGはそのまま、GIF・BMP等はブラウザの機能でPNGへ変換)
      const embeddedImages = new Map<object, PDFImage>();
      let imageFailures = 0;
      if (settings) {
        for (const pic of settings.pictures) {
          try {
            embeddedImages.set(pic, pic.mime === "image/png" ? await doc.embedPng(pic.bytes) : await doc.embedJpg(pic.bytes));
          } catch {
            imageFailures++;
          }
        }
        for (const other of settings.otherImages) {
          const png = await convertImageToPng(other.bytes, other.ext);
          if (!png) {
            imageFailures++;
            continue;
          }
          try {
            const pic: SheetPicture = { ...other.picture, mime: "image/png", bytes: png };
            embeddedImages.set(pic, await doc.embedPng(png));
            settings.pictures.push(pic);
          } catch {
            imageFailures++;
          }
        }
        settings.otherImages = [];
      }
      if (imageFailures > 0) warnings.push(`「${sheet.name}」の画像のうち${imageFailures}個は、形式が未対応のため表示していません`);

      // 画像・図形が置かれているセルの範囲(印刷範囲の指定が無いときは、そこまでを印刷の対象にする)
      if (settings) {
        const lastIndexBefore = (limit: number, startOf: (i: number) => number): number => {
          let i = 0;
          while (i < 2000 && startOf(i + 1) < limit - 0.5) i++;
          return i;
        };
        for (const a of [...settings.pictures, ...settings.shapes, ...settings.charts]) {
          const r = anchorRect(a);
          drawingLastCol = Math.max(drawingLastCol, lastIndexBefore(r.x2, colLeftSheet));
          drawingLastRow = Math.max(drawingLastRow, lastIndexBefore(r.y2, rowTopSheet));
        }
        contentLastRow = Math.max(contentLastRow, drawingLastRow);
        contentLastCol = Math.max(contentLastCol, drawingLastCol);
      }

      // 最後の列にある長い文字列は、右隣の空き列にはみ出して印刷される(Excelと同じ)。
      // 値のある最終列より右に何列ぶん必要かを求め、印刷範囲の指定が無いときだけ描画対象に加える。
      let overflowLastCol = -1;
      {
        const MAX_EXTRA_COLS = 40;
        for (let r = 0; r < sheet.rows.length; r++) {
          const row = sheet.rows[r];
          if (settings?.hiddenRows.has(r)) continue;
          let lc = row.length - 1;
          while (lc >= 0 && cellDisplayText(row, r, lc) === "") lc--;
          if (lc < 0) continue;
          const value = row[lc] ?? null;
          if (typeof value === "number" || value instanceof Date || typeof value === "boolean") continue;
          if (mergeByCell.has(`${r}:${lc}`)) continue;
          const align = settings?.cellAlign.get(`${r}:${lc}`) ?? null;
          // 折り返し・回転・「縮小して全体を表示」・均等割り付けのセルは、Excelでも隣のセルへはみ出さない
          if (align?.wrapText || align?.shrinkToFit || (align?.textRotation ?? 0) !== 0) continue;
          const horizontal = align?.horizontal ?? "left";
          if (horizontal !== "left") continue;
          const text = cellDisplayText(row, r, lc).split("\n")[0];
          // Excelのセルの左右の余白は2ピクセル程度(合わせて約3pt)。描画用の余白(cellPadding)で判定すると、
          // 列の幅ぎりぎりの文字まで「はみ出す」と判定して、使われていない右の列まで印刷範囲を広げ、
          // 「ページ数に合わせる」の倍率やページの境目がExcelとずれていた。
          const need = textWidth(font, text, fontSizeFor(r, lc)) + 3 + (align?.indent ?? 0) * defaultFontSize * 0.6;
          let have = 0;
          let c = lc;
          // 最終列(値のある列)から右へ、はみ出す文字が収まるまでの列を数える
          while (have < need && c < lc + MAX_EXTRA_COLS) {
            have += colWidthOf(c);
            if (have >= need) break;
            c++;
          }
          if (c > overflowLastCol && c > totalColCount - 1) overflowLastCol = c;
        }
      }

      // ヘッダー/フッターは、全ページ数が確定してから描く(複数の印刷範囲があっても通しのページ番号にするため)
      const pendingHeaderFooter: { page: PDFPage; pageNo: number }[] = [];
      /** ヘッダー/フッターの文字の倍率(表の拡大縮小と同じ。印刷範囲が複数あるときは最後の範囲の倍率) */
      let headerFooterScale = 1;
      let pageInSheet = 0;
      /** グラフの確認用：印刷範囲ごとのページの分け方 */
      const chartCheckAreas: CheckArea[] = [];

      // ---- 印刷範囲ごとの描画 --------------------------------------------------
      for (const area of areas) {
        const rangeStartRow = area ? Math.max(0, area.startRow) : 0;
        const rangeEndRow = area ? Math.min(contentLastRow, area.endRow) : Math.max(sheet.rows.length - 1, drawingLastRow);
        const rangeStartCol = area ? Math.max(0, area.startCol) : 0;
        const rangeEndCol = area ? Math.min(contentLastCol, area.endCol) : Math.max(totalColCount - 1, drawingLastCol, overflowLastCol);
        if (area) {
          warnings.push(`「${sheet.name}」はExcelの印刷範囲(${rangeStartRow + 1}〜${rangeEndRow + 1}行目)だけをPDF化しました`);
        }

        // 非表示行・列を除外(B-16)
        const areaRows: number[] = [];
        for (let r = rangeStartRow; r <= rangeEndRow; r++) if (!settings?.hiddenRows.has(r)) areaRows.push(r);
        const areaCols: number[] = [];
        for (let c = rangeStartCol; c <= rangeEndCol; c++) if (!settings?.hiddenCols.has(c)) areaCols.push(c);
        if (areaRows.length === 0 || areaCols.length === 0) {
          warnings.push(`「${sheet.name}」は印刷対象の行・列がありませんでした（印刷範囲・非表示設定をご確認ください）`);
          continue;
        }

        // --- 印刷タイトル(毎ページ上部/左端に繰り返す行・列) ---
        // Excelの印刷タイトルが設定されていればそれを使う。無ければ「先頭行を見出し行にする」の指定を使う。
        // 対応するのは、印刷範囲より前にある行/列、または範囲の先頭から始まる行/列(一般的な使い方)。
        const pickTitles = (
          title: { start: number; end: number } | null,
          areaOrig: number[],
          isHidden: (i: number) => boolean,
          label: string
        ): number[] => {
          if (!title) return [];
          const all: number[] = [];
          for (let i = title.start; i <= title.end; i++) if (!isHidden(i)) all.push(i);
          if (all.length === 0) return [];
          const areaFirst = areaOrig[0];
          if (title.end < areaFirst || (title.start <= areaFirst && title.end >= areaFirst)) return all;
          warnings.push(`「${sheet.name}」の印刷タイトル(${label})は、印刷範囲の途中にあるため繰り返し表示に対応していません`);
          return [];
        };
        let titleRowsOrig = pickTitles(settings?.printTitleRows ?? null, areaRows, (r) => settings?.hiddenRows.has(r) ?? false, "行");
        if (!settings?.printTitleRows && repeatHeaderRow) titleRowsOrig = [areaRows[0]];
        const titleColsOrig = pickTitles(settings?.printTitleCols ?? null, areaCols, (c) => settings?.hiddenCols.has(c) ?? false, "列");
        const titleRowSet = new Set(titleRowsOrig);
        const titleColSet = new Set(titleColsOrig);
        const bodyRows = areaRows.filter((r) => !titleRowSet.has(r));
        const bodyCols = areaCols.filter((c) => !titleColSet.has(c));

        const titleRowsHeight = titleRowsOrig.reduce((sum, r) => sum + rowHeightOf(r), 0);
        const titleColsWidth = titleColsOrig.reduce((sum, c) => sum + colWidthOf(c), 0);

        // --- 改ページ(B-15): 取得できれば反映、取得できなければ自然な分割のまま ---
        const grid = computePageGrid({
          colSizesPt: bodyCols.map(colWidthOf),
          rowSizesPt: bodyRows.map(rowHeightOf),
          // 印刷タイトルの分は、倍率をかけた長さで差し引く(computePageGridの中で)
          contentWidthPt: contentWidth,
          contentHeightPt: contentHeightForData,
          titleColsWidthPt: titleColsWidth,
          titleRowsHeightPt: titleRowsHeight,
          fit,
          colBreaksAfterIndex: mapBreaksToLocalIndex(settings?.colBreaksAfter ?? [], bodyCols),
          rowBreaksAfterIndex: mapBreaksToLocalIndex(settings?.rowBreaksAfter ?? [], bodyRows),
        });
        const scale = grid.scale;
        headerFooterScale = scale;
        if (grid.colGroups.length * grid.rowGroups.length > 1) {
          warnings.push(
            `「${sheet.name}」は${grid.colGroups.length}(横)×${grid.rowGroups.length}(縦)ページに分割しました（Excelの印刷ページ数に合わせています）`
          );
        }

        // ---- セルごとの描画に使う関数 ----
        const sideStyleOf = (origRow: number, origCol: number, side: Side): BorderSideStyle | null => {
          const key = `${origRow}:${origCol}`;
          const fromCf = cf?.borders.get(key)?.[side];
          if (fromCf) return fromCf;
          const styles = settings?.cellBorderStyles.get(key);
          if (styles) return styles[side] ?? null;
          // 罫線の種類が取れていないセル(通常は無い)は、従来どおり細い実線として扱う
          return settings?.cellBorders.get(key)?.[side] ? BORDER_FALLBACK : null;
        };

        const drawBorderLine = (page: PDFPage, side: BorderSideStyle, x1: number, y1: number, x2: number, y2: number, s: number) => {
          const spec = BORDER_SPECS[side.style] ?? BORDER_SPECS.thin;
          // 色が指定されていなければExcelの「自動」(黒)。白黒印刷では常に黒。
          const color = side.color && !blackAndWhite ? pdfLib().rgb(...hexToRgb01(side.color)) : pdfLib().rgb(0, 0, 0);
          const thickness = Math.max(0.2, spec.width * s);
          if (spec.double) {
            // 二重線: 辺の位置を中心に、細い線2本を引く。Excelの二重線は「線・すき間・線」が1pxずつ(全体で約2.25pt)なので、
            // 2本の中心を線の太さの1.5倍ずつ離す(すき間が線と同じ太さになり、印刷しても1本に見えない)
            const horizontal = y1 === y2;
            const off = thickness * 1.5;
            const lines: [number, number, number, number][] = horizontal
              ? [
                  [x1, y1 + off, x2, y2 + off],
                  [x1, y1 - off, x2, y2 - off],
                ]
              : [
                  [x1 + off, y1, x2 + off, y2],
                  [x1 - off, y1, x2 - off, y2],
                ];
            for (const [ax, ay, bx, by] of lines) {
              page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness, color });
            }
            return;
          }
          page.drawLine({
            start: { x: x1, y: y1 },
            end: { x: x2, y: y2 },
            thickness,
            color,
            ...(spec.dash ? { dashArray: spec.dash.map((d) => d * Math.max(s, 0.5)), dashPhase: 0 } : {}),
          });
        };

        const drawCellBorders = (page: PDFPage, x: number, yTop: number, width: number, height: number, origRow: number, origCol: number, s: number) => {
          const yBottom = yTop - height;
          if (borderFor(origRow, origCol)) {
            // 結合セルは、結合範囲の外周だけに罫線を引く(内側の罫線は、結合前のセルの名残でExcelでも表示されない)。
            const merge = mergeByCell.get(`${origRow}:${origCol}`)?.range ?? null;
            const edge = {
              top: !merge || origRow === merge.startRow,
              bottom: !merge || origRow === merge.endRow,
              left: !merge || origCol === merge.startCol,
              right: !merge || origCol === merge.endCol,
            };
            // 隣のセルが同じ辺に、より強い罫線を持っているときは、そちらに任せる(強い罫線の上に弱い罫線を重ねない)。
            const neighborRank = (r: number, c: number, side: Side): number => {
              if (r < 0 || c < 0 || settings?.hiddenRows.has(r) || settings?.hiddenCols.has(c)) return 0;
              const st = sideStyleOf(r, c, side);
              return st ? (BORDER_SPECS[st.style] ?? BORDER_SPECS.thin).rank : 0;
            };
            const draw = (side: Side, opposite: { r: number; c: number }, x1: number, y1: number, x2: number, y2: number) => {
              if (!edge[side]) return;
              const own = sideStyleOf(origRow, origCol, side);
              if (!own) return;
              const oppositeSide: Side = side === "top" ? "bottom" : side === "bottom" ? "top" : side === "left" ? "right" : "left";
              const ownRank = (BORDER_SPECS[own.style] ?? BORDER_SPECS.thin).rank;
              if (neighborRank(opposite.r, opposite.c, oppositeSide) > ownRank) return;
              drawBorderLine(page, own, x1, y1, x2, y2, s);
            };
            draw("top", { r: origRow - 1, c: origCol }, x, yTop, x + width, yTop);
            draw("bottom", { r: origRow + 1, c: origCol }, x, yBottom, x + width, yBottom);
            draw("left", { r: origRow, c: origCol - 1 }, x, yBottom, x, yTop);
            draw("right", { r: origRow, c: origCol + 1 }, x + width, yBottom, x + width, yTop);
          }
          // 斜めの罫線(結合セルはアンカーセルの設定を結合範囲全体に引く)
          const merge = mergeByCell.get(`${origRow}:${origCol}`);
          if (!merge || merge.isAnchor) {
            const diag = settings?.cellDiagonals.get(`${origRow}:${origCol}`);
            if (diag?.up) drawBorderLine(page, diag.up, x, yBottom, x + width, yTop, s);
            if (diag?.down) drawBorderLine(page, diag.down, x, yTop, x + width, yBottom, s);
          }
        };

        /** テキスト行(1行ぶん)を、指定の横揃えで描く。textWidthは行の描画幅 */
        const lineStartX = (h: "left" | "center" | "right", boxX: number, boxW: number, textW: number, pad: number): number => {
          if (h === "center") return boxX + (boxW - textW) / 2;
          if (h === "right") return boxX + boxW - pad - textW;
          return boxX + pad;
        };

        /**
         * ページ内の全セルの背景色を、文字より先にまとめて塗る。セルごとに「塗る→文字」を繰り返すと、
         * 結合セルの文字(右隣・下隣のセルへまたがる部分)を、後から塗る隣のセルの背景色が上から隠してしまう。
         * 枠線の印刷が指定されている場合は、背景色の上に枠線(薄い線)も引く。
         */
        const drawPageFills = (page: PDFPage, colsOnPage: number[], rowsOnPage: number[], startTop: number, startX: number) => {
          let top = startTop;
          for (const origRow of rowsOnPage) {
            const rowH = rowHeightOf(origRow) * scale;
            let fx = startX;
            for (const origCol of colsOnPage) {
              const w = colWidthOf(origCol) * scale;
              const fill = fillFor(origRow, origCol);
              const gradient = fill ? gradientFor(origRow, origCol) : null;
              if (gradient) {
                drawGradientCell(page, gradient, { x: fx, yTop: top, width: w, height: rowH }, gradientSpanOf(origRow, origCol), scale);
              } else if (fill) {
                page.drawRectangle({ x: fx, y: top - rowH, width: w, height: rowH, color: pdfLib().rgb(...hexToRgb01(fill)) });
              }
              const bar = cf?.dataBars.get(`${origRow}:${origCol}`);
              if (bar && !blackAndWhite) {
                const inset = Math.min(1.5, rowH * 0.12);
                page.drawRectangle({
                  x: fx + 1,
                  y: top - rowH + inset,
                  width: Math.max(0, (w - 2) * bar.ratio),
                  height: Math.max(0, rowH - inset * 2),
                  color: pdfLib().rgb(...hexToRgb01(bar.color)),
                  opacity: 0.7,
                });
              }
              fx += w;
            }
            top -= rowH;
          }
          if (settings?.printGridLines) {
            const gridColor = pdfLib().rgb(0.55, 0.55, 0.55);
            const thickness = Math.max(0.2, 0.4 * scale);
            let gTop = startTop;
            for (const origRow of rowsOnPage) {
              const rowH = rowHeightOf(origRow) * scale;
              let gx = startX;
              for (const origCol of colsOnPage) {
                const w = colWidthOf(origCol) * scale;
                const merge = mergeByCell.get(`${origRow}:${origCol}`)?.range;
                const sides: [boolean, number, number, number, number][] = [
                  [!merge || origRow === merge.startRow, gx, gTop, gx + w, gTop],
                  [!merge || origRow === merge.endRow, gx, gTop - rowH, gx + w, gTop - rowH],
                  [!merge || origCol === merge.startCol, gx, gTop - rowH, gx, gTop],
                  [!merge || origCol === merge.endCol, gx + w, gTop - rowH, gx + w, gTop],
                ];
                for (const [on, x1, y1, x2, y2] of sides) {
                  if (on) page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: gridColor });
                }
                gx += w;
              }
              gTop -= rowH;
            }
          }
        };

        /**
         * 1行ぶんのセルの文字と罫線を描く。
         * rowsOnPage: このページに描画する行(縦方向に結合されたセルの高さを、ページ内に実際に含まれる行だけで合計するために使う)
         */
        const drawRow = (page: PDFPage, origRow: number, colsOnPage: number[], top: number, rowsOnPage: number[], startX: number): number => {
          const row = sheet.rows[origRow] ?? [];
          const s = scale;
          const rowH = rowHeightOf(origRow) * s;
          const pad = cellPadding * s;
          let x = startX;
          // 既定の文字色: Excelの「自動」(黒)。以前は本文を薄いグレーで描いていた
          const defaultColor = blackAndWhite ? pdfLib().rgb(0, 0, 0) : pdfLib().rgb(...TEXT_COLOR);
          const colWidthsOnPage = colsOnPage.map((c) => colWidthOf(c) * s);

          colsOnPage.forEach((origCol, groupPos) => {
            const key = `${origRow}:${origCol}`;
            const w = colWidthsOnPage[groupPos];

            // 結合セル: アンカー以外は文字を描かない。アンカーは結合範囲(このページに含まれる分)全体を文字の領域にする。
            const merge = mergeByCell.get(key);
            let boxW = w;
            let boxH = rowH;
            let drawText = true;
            if (merge) {
              if (!merge.isAnchor) {
                drawText = false;
              } else {
                boxW = colsOnPage.reduce(
                  (sum, oc, i) => (oc >= merge.range.startCol && oc <= merge.range.endCol ? sum + colWidthsOnPage[i] : sum),
                  0
                );
                boxH = rowsOnPage.reduce(
                  (sum, orow) => (orow >= merge.range.startRow && orow <= merge.range.endRow ? sum + rowHeightOf(orow) * s : sum),
                  0
                );
              }
            }

            let text = drawText ? cellDisplayText(row, origRow, origCol) : "";
            if (text !== "") {
              const value = row[origCol] ?? null;
              const isNumeric = typeof value === "number" || value instanceof Date;
              const align = settings?.cellAlign.get(key) ?? null;
              const base = baseStyleOf(origRow, origCol);
              const baseFs = base.fs;
              const rotation = align?.textRotation ?? 0;
              const wrap = align?.wrapText ?? false;
              // 「縮小して全体を表示」のセルは幅が狭いことが多い(1文字ぶんの欄など)ため、左右の余白を小さくして文字を大きく保つ
              const padH = align?.shrinkToFit ? Math.min(pad, 1.5 * s) : pad;
              // 横揃えの既定(general): 文字は左、数値・日付は右、論理値は中央(Excelと同じ)
              const horizontalRaw =
                align?.horizontal ?? (isNumeric ? "right" : typeof value === "boolean" ? "center" : align?.centerContinuous ? "center" : "left");
              // 均等割り付け(distributed)は、文字を領域の幅いっぱいに均等に並べる(下の描画で処理する)。ここでは左寄せ扱い。
              const distributed = horizontalRaw === "distributed";
              const horizontal: "left" | "center" | "right" = distributed ? "left" : horizontalRaw;
              const vertical = align?.vertical ?? "bottom"; // Excelの既定の縦位置は「下揃え」
              const indentPt = (align?.indent ?? 0) * baseFs * 0.6 * s;

              // 文字が領域に入りきらないときの隣の空きセルへのはみ出し(Excelと同じ):
              // 文字列は、左揃えなら右へ、右揃えなら左へ、中央揃えなら両側へ、空いているセルの上に表示される。数値は"###"になる。
              let boxX = x;
              let avail = boxW - padH * 2;
              let leftExtra = 0;
              let rightExtra = 0;
              const isEmptyCell = (c: number) => cellDisplayText(row, origRow, c) === "" && !mergeByCell.has(`${origRow}:${c}`);
              if (align?.centerContinuous && !merge) {
                // 選択範囲内で中央: 右隣の、同じ設定の空きセルにまたがって中央に寄せる
                for (let gp = groupPos + 1; gp < colsOnPage.length; gp++) {
                  const nc = colsOnPage[gp];
                  if (!isEmptyCell(nc) || !(settings?.cellAlign.get(`${origRow}:${nc}`)?.centerContinuous ?? false)) break;
                  rightExtra += colWidthsOnPage[gp];
                }
              } else if (!wrap && !merge && !isNumeric && rotation === 0 && !align?.shrinkToFit && !distributed) {
                // 「縮小して全体を表示」と「均等割り付け」は、Excelでもセルの中だけに収める（隣の空きセルへはみ出さない）
                const spillRight = () => {
                  let sum = 0;
                  for (let gp = groupPos + 1; gp < colsOnPage.length; gp++) {
                    if (!isEmptyCell(colsOnPage[gp])) break;
                    sum += colWidthsOnPage[gp];
                  }
                  return sum;
                };
                const spillLeft = () => {
                  let sum = 0;
                  for (let gp = groupPos - 1; gp >= 0; gp--) {
                    if (!isEmptyCell(colsOnPage[gp])) break;
                    sum += colWidthsOnPage[gp];
                  }
                  return sum;
                };
                if (horizontal === "left") rightExtra = spillRight();
                else if (horizontal === "right") leftExtra = spillLeft();
                else {
                  const both = Math.min(spillLeft(), spillRight());
                  leftExtra = both;
                  rightExtra = both;
                }
              }
              boxX = x - leftExtra;
              const fullBoxW = boxW + leftExtra + rightExtra;
              avail = fullBoxW - padH * 2 - (horizontal === "left" || horizontal === "right" ? indentPt : 0);

              const glyphs = glyphsOf(text, base, origRow, origCol, value);
              const measureAt = (k: number) => (g: Glyph) => glyphWidth(g, s * k);
              let k = 1; // 「縮小して全体を表示」の倍率
              let lines: Glyph[][];
              let clipWidth: number | null = null;
              if (rotation !== 0 && rotation !== 255) {
                // 回転した文字: 90度付近なら行の高さ、それ以外はセルの幅を折り返しの目安にする
                const wrapW = wrap ? (Math.abs(rotation) >= 45 ? boxH - pad * 2 : (boxW - padH * 2) / Math.max(0.3, Math.cos((rotation * Math.PI) / 180))) : null;
                lines = layoutGlyphs(glyphs, wrapW, measureAt(1));
              } else if (rotation === 255) {
                // 縦書き: 1文字ずつ縦に積む
                lines = glyphs.filter((g) => g.ch !== "\n").map((g) => [g]);
              } else if (wrap) {
                lines = layoutGlyphs(glyphs, avail, measureAt(1));
              } else {
                lines = layoutGlyphs(glyphs, null, measureAt(1));
                let oneLineW = lineWidthOf(lines[0], s);
                // 数値・日付が列の幅に入らないときは、Excelと同じく「####」で表示する(わずかな超過は文字の幅の差とみなして切り詰めで表示)
                if (isNumeric && !align?.shrinkToFit && oneLineW > avail * 1.15 && avail > 0) {
                  const hashW = unitWidth(font, "#") * baseFs * s;
                  const count = Math.max(1, Math.floor(avail / Math.max(0.1, hashW)));
                  text = "#".repeat(count);
                  lines = [Array.from(text).map((ch) => ({ ch, style: base }))];
                  oneLineW = lineWidthOf(lines[0], s);
                }
                if (oneLineW > avail && align?.shrinkToFit && avail > 0) {
                  // 「縮小して全体を表示」: セルの幅に収まるよう文字を小さくする(Excelと同じ。小さくしすぎないよう下限あり)
                  k = Math.max(0.3, avail / oneLineW);
                }
                // 折り返さないセルで文字が描画領域に収まらないとき、文字は削らず全文を描き、はみ出し部分だけクリップで隠す
                // (Excelの表示と同じ。文字そのものはPDFに残るので、検索・コピーでも欠けない)。
                if (lineWidthOf(lines[0], s * k) > avail + 0.01) clipWidth = avail;
              }

              const sizeFactor = s * k;
              const lhOf = (line: Glyph[]) => lineHeightFor(maxFontSizeOf(line, baseFs)) * sizeFactor;
              const lineHeights = lines.map(lhOf);
              const fits = (() => {
                let count = 0;
                let sum = 0;
                for (const h of lineHeights) {
                  if (count > 0 && sum + h > boxH + 0.01) break;
                  sum += h;
                  count++;
                }
                return Math.max(1, count);
              })();
              const visible = lines.slice(0, fits);
              const blockH = lineHeights.slice(0, fits).reduce((a, b) => a + b, 0);

              let blockTop: number;
              if (blockH >= boxH - pad || vertical === "top") blockTop = top - (vertical === "top" ? pad : 0);
              else if (vertical === "center") blockTop = top - (boxH - blockH) / 2;
              else blockTop = top - boxH + pad + blockH;

              const needsClip = clipWidth !== null || (rotation !== 0 && rotation !== 255) || rotation === 255;
              if (needsClip) {
                // クリップ範囲はセルの左端から、文字領域の右端(左右の余白ぶんを含む)まで。
                // 余白ぶんを含めないと、右揃えの文字(例: 幅の狭いセルの「年」「月」)の端が欠ける。
                const clipX = rotation !== 0 ? x : boxX;
                // Excelは、はみ出した文字を「セルの右端の罫線」の位置で切る(セル内の余白では切らない)。
                // 余白で切ると、列の幅にぎりぎり収まる見出し(例: 4文字の「生徒番号」)の最後の字が半分欠けてしまう。
                const clipW = rotation !== 0 ? boxW : fullBoxW;
                page.pushOperators(pdfLib().pushGraphicsState(), pdfLib().rectangle(clipX, top - boxH, clipW, boxH), pdfLib().clip(), pdfLib().endPath());
              }

              if (rotation !== 0 && rotation !== 255) {
                // 回転した文字: 文字ブロックの外接する長方形をセル内の位置に置き、その中心に回転させた文字を描く
                const rad = (rotation * Math.PI) / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const widths = visible.map((l) => lineWidthOf(l, sizeFactor));
                const bw = Math.max(...widths, 0) * Math.abs(cos) + blockH * Math.abs(sin);
                const bh = Math.max(...widths, 0) * Math.abs(sin) + blockH * Math.abs(cos);
                const cx =
                  horizontal === "left" ? x + padH + bw / 2 : horizontal === "right" ? x + boxW - padH - bw / 2 : x + boxW / 2;
                const cy = vertical === "top" ? top - pad - bh / 2 : vertical === "center" ? top - boxH / 2 : top - boxH + pad + bh / 2;
                const nx = -sin;
                const ny = cos;
                visible.forEach((line, li) => {
                  const lw = widths[li];
                  const fsLine = maxFontSizeOf(line, baseFs) * sizeFactor;
                  // 文字ブロックの中心から、この行の左端のベースラインへ
                  const along = -lw / 2;
                  const across = ((visible.length - 1) / 2 - li) * (blockH / visible.length) - fsLine * 0.34;
                  drawGlyphLine(page, line, cx + along * cos + across * nx, cy + along * sin + across * ny, sizeFactor, defaultColor, blackAndWhite, rotation);
                });
              } else if (rotation === 255) {
                // 縦書き: 1文字ずつ、セルの中央に縦に並べる
                let yTop = blockTop;
                visible.forEach((line, li) => {
                  const h = lineHeights[li];
                  const lw = lineWidthOf(line, sizeFactor);
                  const fsLine = maxFontSizeOf(line, baseFs) * sizeFactor;
                  const bx = horizontal === "left" ? x + padH : horizontal === "right" ? x + boxW - padH - lw : x + (boxW - lw) / 2;
                  drawGlyphLine(page, line, bx, yTop - (h - fsLine) / 2 - 0.88 * fsLine, sizeFactor, defaultColor, blackAndWhite);
                  yTop -= h;
                });
              } else {
                let yTop = blockTop;
                visible.forEach((line, li) => {
                  const lh = lineHeights[li];
                  const fsLine = maxFontSizeOf(line, baseFs) * sizeFactor;
                  const lineW = lineWidthOf(line, sizeFactor);
                  const baseline = yTop - (lh - fsLine) / 2 - 0.88 * fsLine;
                  yTop -= lh;
                  const indentLeft = horizontal === "left" ? indentPt : 0;
                  const indentRight = horizontal === "right" ? indentPt : 0;
                  if (distributed && !wrap && line.length > 1 && lineW < fullBoxW - padH * 2) {
                    // 均等割り付け: 文字の間隔を均等にあけて、領域の幅いっぱいに並べる
                    const gap = (fullBoxW - padH * 2 - lineW) / (line.length - 1);
                    let cx = boxX + padH;
                    for (const g of line) {
                      drawGlyphLine(page, [g], cx, baseline, sizeFactor, defaultColor, blackAndWhite);
                      cx += glyphWidth(g, sizeFactor) + gap;
                    }
                  } else {
                    const startXLine = lineStartX(horizontal, boxX, fullBoxW, lineW, padH) + indentLeft - indentRight;
                    drawGlyphLine(page, line, startXLine, baseline, sizeFactor, defaultColor, blackAndWhite);
                  }
                });
              }
              if (needsClip) page.pushOperators(pdfLib().popGraphicsState());
            }
            drawCellBorders(page, x, top, w, rowH, origRow, origCol, scale);
            x += w;
          });
          return top - rowH;
        };

        /** 画像と図形を描く。ページに表示される範囲(本体の行・列)だけにクリップする */
        const drawDrawings = (
          page: PDFPage,
          bodyColsOnPage: number[],
          bodyRowsOnPage: number[],
          bodyX: number,
          bodyTop: number
        ) => {
          if (!settings || (settings.pictures.length === 0 && settings.shapes.length === 0 && settings.charts.length === 0)) return;
          if (bodyColsOnPage.length === 0 || bodyRowsOnPage.length === 0) return;
          const s = scale;
          const sheetLeft = colLeftSheet(bodyColsOnPage[0]);
          const sheetTop = rowTopSheet(bodyRowsOnPage[0]);
          const regionW = bodyColsOnPage.reduce((sum, c) => sum + colWidthOf(c), 0);
          const regionH = bodyRowsOnPage.reduce((sum, r) => sum + rowHeightOf(r), 0);
          const toPage = (r: { x1: number; y1: number; x2: number; y2: number }) => ({
            x: bodyX + (r.x1 - sheetLeft) * s,
            y: bodyTop - (r.y2 - sheetTop) * s,
            w: (r.x2 - r.x1) * s,
            h: (r.y2 - r.y1) * s,
          });
          const intersects = (r: { x1: number; y1: number; x2: number; y2: number }) =>
            r.x2 > sheetLeft && r.x1 < sheetLeft + regionW && r.y2 > sheetTop && r.y1 < sheetTop + regionH;
          const clipToRegion = () =>
            page.pushOperators(pdfLib().pushGraphicsState(), pdfLib().rectangle(bodyX, bodyTop - regionH * s, regionW * s, regionH * s), pdfLib().clip(), pdfLib().endPath());

          const drawPicture = (pic: (typeof settings.pictures)[number]) => {
            const img = embeddedImages.get(pic);
            if (!img) return;
            const r = anchorRect(pic);
            if (!intersects(r)) return;
            const p = toPage(r);
            if (p.w <= 0 || p.h <= 0) return;
            clipToRegion();
            page.drawImage(img, { x: p.x, y: p.y, width: p.w, height: p.h });
            page.pushOperators(pdfLib().popGraphicsState());
          };
          // グラフ(画像と同じく、ページに表示される範囲だけにクリップする。ページの境目をまたぐグラフは、
          // Excelと同じく、それぞれのページに入る部分だけが印刷される)
          const drawChartItem = (chart: (typeof settings.charts)[number]) => {
            const r = anchorRect(chart);
            if (!intersects(r)) return;
            const p = toPage(r);
            if (p.w <= 0 || p.h <= 0) return;
            clipToRegion();
            page.pushOperators(pdfLib().pushGraphicsState(), pdfLib().rectangle(p.x, p.y, p.w, p.h), pdfLib().clip(), pdfLib().endPath());
            let failed = chart.model === null;
            if (chart.model) {
              try {
                const res = drawChart(chart.model, { page, lib: pdfLib(), box: p, scale: s, text: chartText, resolve: makeChartResolver(sheet.name), blackAndWhite });
                if (res.unresolvedSeries > 0) unresolvedCharts.set(chart, { sheet: sheet.name, series: res.unresolvedSeries });
                chartsDrawn++;
              } catch {
                failed = true;
                chartDrawFailures++;
              }
            }
            if (failed) drawChartPlaceholder(page, p, chart.unsupportedReason ?? "グラフを描けませんでした", s);
            page.pushOperators(pdfLib().popGraphicsState(), pdfLib().popGraphicsState());
          };
          const drawShape = (shape: (typeof settings.shapes)[number]) => {
            const r = anchorRect(shape);
            if (!intersects(r)) return;
            const p = toPage(r);
            const lineColor = shape.line && !blackAndWhite ? pdfLib().rgb(...hexToRgb01(shape.line)) : shape.line ? pdfLib().rgb(0, 0, 0) : undefined;
            const fillColor = shape.fill && !blackAndWhite ? pdfLib().rgb(...hexToRgb01(shape.fill)) : undefined;
            const borderWidth = lineColor ? Math.max(0.3, shape.lineWidthPt * s) : 0;
            clipToRegion();
            if (shape.kind === "line") {
              if (lineColor) page.drawLine({ start: { x: p.x, y: p.y + p.h }, end: { x: p.x + p.w, y: p.y }, thickness: borderWidth, color: lineColor });
            } else if (shape.kind === "ellipse") {
              page.drawEllipse({
                x: p.x + p.w / 2,
                y: p.y + p.h / 2,
                xScale: p.w / 2,
                yScale: p.h / 2,
                ...(fillColor ? { color: fillColor } : {}),
                ...(lineColor ? { borderColor: lineColor, borderWidth } : {}),
              });
            } else if (shape.kind === "roundRect") {
              const rad = Math.min(p.w, p.h) * 0.16;
              const path = `M ${rad} 0 L ${p.w - rad} 0 Q ${p.w} 0 ${p.w} ${rad} L ${p.w} ${p.h - rad} Q ${p.w} ${p.h} ${p.w - rad} ${p.h} L ${rad} ${p.h} Q 0 ${p.h} 0 ${p.h - rad} L 0 ${rad} Q 0 0 ${rad} 0 Z`;
              page.drawSvgPath(path, {
                x: p.x,
                y: p.y + p.h,
                ...(fillColor ? { color: fillColor } : {}),
                ...(lineColor ? { borderColor: lineColor, borderWidth } : {}),
              });
            } else {
              page.drawRectangle({
                x: p.x,
                y: p.y,
                width: p.w,
                height: p.h,
                ...(fillColor ? { color: fillColor } : {}),
                ...(lineColor ? { borderColor: lineColor, borderWidth } : {}),
              });
            }
            if (shape.text.trim() !== "") {
              const fs = (shape.fontSizePt ?? defaultFontSize) * s;
              const style: TextStyle = {
                fs: shape.fontSizePt ?? defaultFontSize,
                bold: shape.bold,
                italic: false,
                underline: null,
                strike: false,
                color: shape.textColor,
                serif: false,
                vertAlign: null,
              };
              const shapeGlyphs = Array.from(normalizeNewlines(shape.text)).map((ch) => ({ ch, style }));
              const shapeLines = layoutGlyphs(shapeGlyphs, Math.max(10, p.w - 4), (g) => glyphWidth(g, s));
              const lh = lineHeightFor(style.fs) * s;
              let yTop = p.y + p.h / 2 + (shapeLines.length * lh) / 2;
              for (const line of shapeLines) {
                const lw = lineWidthOf(line, s);
                drawGlyphLine(page, line, p.x + (p.w - lw) / 2, yTop - (lh - fs) / 2 - 0.88 * fs, s, pdfLib().rgb(...TEXT_COLOR), blackAndWhite);
                yTop -= lh;
              }
            }
            page.pushOperators(pdfLib().popGraphicsState());
          };
          // 重なり順：Excelのdrawingの中の順(後のものほど上)。画像・グラフ・図形を混ぜて、その順に描く
          const items: { z: number; draw: () => void }[] = [
            ...settings.pictures.map((pic) => ({ z: pic.z ?? -1, draw: () => drawPicture(pic) })),
            ...settings.charts.map((chart) => ({ z: chart.z ?? -1, draw: () => drawChartItem(chart) })),
            ...settings.shapes.map((shape) => ({ z: shape.z ?? -1, draw: () => drawShape(shape) })),
          ];
          items.sort((x, y) => x.z - y.z);
          for (const item of items) item.draw();
        };

        // ---- ページの生成: Excelの既定(down, then over) = 同じ列グループ内で縦方向に進み、
        //      縦方向を使い切ってから次の列グループへ進む ----
        // シート名を自動でページ上部へ表示する処理(旧titleBlock)は、開発指示書B-9(Phase 22)により撤廃した。
        // 「Excel側で設定されていないシート名をMr.Sattoが勝手にページへ追加しない」ことが「非常に重要」と明記されているため。
        // 何も無いページ(値・背景色・罫線のあるセルも、画像・グラフ・図形も無いページ)は出力しない。
        // 表やグラフが横に広いと、縦に長い表の右側に空白のページが大量にできるため(LibreOfficeも空白のページは出力しない)。
        // シートのすべてのページが空のときは、1ページ目だけは出力する
        const pageHasContent = (cols: number[], rows: number[]): boolean => {
          for (const r of rows) {
            const row = sheet.rows[r];
            for (const c of cols) {
              const v = row?.[c];
              if (v !== null && v !== undefined && v !== "") return true;
              if (fillFor(r, c) || borderFor(r, c)) return true;
            }
          }
          if (settings && cols.length > 0 && rows.length > 0) {
            const x1 = colLeftSheet(cols[0]);
            const y1 = rowTopSheet(rows[0]);
            const x2 = x1 + cols.reduce((sum, c) => sum + colWidthOf(c), 0);
            const y2 = y1 + rows.reduce((sum, r) => sum + rowHeightOf(r), 0);
            for (const d of [...settings.pictures, ...settings.charts, ...settings.shapes]) {
              const rr = anchorRect(d);
              if (rr.x2 > x1 && rr.x1 < x2 && rr.y2 > y1 && rr.y1 < y2) return true;
            }
          }
          return false;
        };
        const blankGridPages = new Set<string>();
        if (grid.colGroups.length * grid.rowGroups.length > 1) {
          grid.colGroups.forEach((colGroup, ci) =>
            grid.rowGroups.forEach((rowGroup, ri) => {
              if (!pageHasContent(colGroup.map((i) => bodyCols[i]), rowGroup.map((i) => bodyRows[i]))) blankGridPages.add(`${ci}:${ri}`);
            })
          );
          if (blankGridPages.size === grid.colGroups.length * grid.rowGroups.length) blankGridPages.delete("0:0");
        }

        // ページの順：既定は「下へ、次に右へ」。ページ設定の「右へ、次に下へ」(overThenDown)なら、横に並ぶページを先に出す
        const pageOrderList: [number, number][] =
          settings?.pageOrder === "overThenDown"
            ? grid.rowGroups.flatMap((_, ri) => grid.colGroups.map((__, ci) => [ci, ri] as [number, number]))
            : grid.colGroups.flatMap((_, ci) => grid.rowGroups.map((__, ri) => [ci, ri] as [number, number]));

        // グラフの確認用に、出力する各ページの範囲(シートの座標)と、PDFのページ番号を記録する(下のページの生成と同じ順・同じ省略)
        if (settings && settings.charts.length > 0) {
          const firstPageNo = (analyzeOnly ? analyzedPageCount : doc.getPageCount()) + 1;
          const checkPages: CheckPage[] = [];
          for (const [ci, ri] of pageOrderList) {
            {
              if (blankGridPages.has(`${ci}:${ri}`)) continue;
              const cols = grid.colGroups[ci].map((i) => bodyCols[i]);
              const rows = grid.rowGroups[ri].map((i) => bodyRows[i]);
              if (cols.length === 0 || rows.length === 0) continue;
              const x1 = colLeftSheet(cols[0]);
              const y1 = rowTopSheet(rows[0]);
              checkPages.push({
                pageNo: firstPageNo + checkPages.length,
                ci,
                ri,
                x1,
                y1,
                x2: x1 + cols.reduce((sum, c) => sum + colWidthOf(c), 0),
                y2: y1 + rows.reduce((sum, r) => sum + rowHeightOf(r), 0),
              });
            }
          }
          const lastCol = bodyCols[bodyCols.length - 1];
          const lastRow = bodyRows[bodyRows.length - 1];
          const colBreaks = new Set(settings.colBreaksAfter);
          const rowBreaks = new Set(settings.rowBreaksAfter);
          chartCheckAreas.push({
            pages: checkPages,
            rect: {
              x1: colLeftSheet(bodyCols[0]),
              y1: rowTopSheet(bodyRows[0]),
              x2: colLeftSheet(lastCol) + colWidthOf(lastCol),
              y2: rowTopSheet(lastRow) + rowHeightOf(lastRow),
            },
            scale,
            pageBodyWidthPt: contentWidth - titleColsWidth * scale,
            pageBodyHeightPt: contentHeightForData - titleRowsHeight * scale,
            manualColBreakAfter: (ci) => colBreaks.has(bodyCols[grid.colGroups[ci][grid.colGroups[ci].length - 1]]),
            manualRowBreakAfter: (ri) => rowBreaks.has(bodyRows[grid.rowGroups[ri][grid.rowGroups[ri].length - 1]]),
          });
        }
        // 確認だけのとき：ページを作らずに、作るはずのページの数だけを数えて次へ
        if (analyzeOnly) {
          analyzedPageCount += grid.colGroups.length * grid.rowGroups.length - blankGridPages.size;
          continue;
        }
        for (const [ci, ri] of pageOrderList) {
          const colGroup = grid.colGroups[ci];
          const rowGroup = grid.rowGroups[ri];
          {
            if (blankGridPages.has(`${ci}:${ri}`)) {
              skippedBlankPages++;
              continue;
            }
            if (doc.getPageCount() >= MAX_PAGE_COUNT) {
              throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
            }
            pageInSheet++;
            const page = doc.addPage([pageWidth, pageHeight]);
            pendingHeaderFooter.push({ page, pageNo: pageInSheet });
            let cursorY = pageHeight - marginTop;

            const bodyColsOnPage = colGroup.map((i) => bodyCols[i]);
            const bodyRowsOnPage = rowGroup.map((i) => bodyRows[i]);
            // 印刷タイトルの行・列は、毎ページ無条件で先頭/左端に描画する
            const colsOnPage = [...titleColsOrig, ...bodyColsOnPage];
            const rowsOnPage = [...titleRowsOrig, ...bodyRowsOnPage];

            // 「ページ中央に配置」(printOptions)。表の幅・高さをページの印刷領域内で中央へ寄せる。
            const tableWidthOnPage = colsOnPage.reduce((sum, c) => sum + colWidthOf(c) * scale, 0);
            const startX = settings?.horizontalCentered ? marginLeft + Math.max(0, (contentWidth - tableWidthOnPage) / 2) : marginLeft;
            if (settings?.verticalCentered) {
              const tableHeightOnPage = rowsOnPage.reduce((sum, r) => sum + rowHeightOf(r) * scale, 0);
              cursorY -= Math.max(0, (contentHeightForData - tableHeightOnPage) / 2);
            }

            drawPageFills(page, colsOnPage, rowsOnPage, cursorY, startX);
            let y = cursorY;
            for (const origRow of titleRowsOrig) y = drawRow(page, origRow, colsOnPage, y, rowsOnPage, startX);
            const bodyTop = y;
            for (const origRow of bodyRowsOnPage) y = drawRow(page, origRow, colsOnPage, y, rowsOnPage, startX);
            drawDrawings(page, bodyColsOnPage, bodyRowsOnPage, startX + titleColsWidth * scale, bodyTop);
          }
        }
      }

      // グラフとページの境目の確認(シートのすべての印刷範囲を見てから、グラフごとに判定する)
      if (settings && settings.charts.length > 0) {
        settings.charts.forEach((chart, i) => {
          checkedCharts++;
          try {
            const issue = checkChart(sheet.name, i + 1, chart, anchorRect(chart), chartCheckAreas);
            if (issue) chartIssues.push(issue);
          } catch {
            // 確認の失敗で、PDFの変換を止めない
          }
        });
      }

      // ---- ヘッダー/フッター(全ページ数が確定してから描く) ----
      const totalPagesForSheet = pageInSheet;
      const sectionsFor = (kind: "header" | "footer", pageNo: number): HeaderFooterSections | null => {
        if (!settings) return null;
        if (settings.differentFirst && pageNo === 1) return kind === "header" ? settings.firstHeader : settings.firstFooter;
        if (settings.differentOddEven && pageNo % 2 === 0) return kind === "header" ? settings.evenHeader : settings.evenFooter;
        return kind === "header" ? settings.header : settings.footer;
      };
      const hfBaseSize = settings?.defaultFontSizePt ?? 11;
      const hfScale = settings?.headerFooterScaleWithDoc === false ? 1 : headerFooterScale;
      /** ヘッダーは上端から余白の位置に文字の上端がくる(Excelと同じ)ので、ベースラインは文字の高さぶん下げる */
      const hfSize = (sec: HeaderFooterSections) =>
        Math.max(hfBaseSize, sec.sizes?.left ?? 0, sec.sizes?.center ?? 0, sec.sizes?.right ?? 0) * hfScale * 0.88;
      for (const { page, pageNo } of pendingHeaderFooter) {
        // 先頭ページの番号の指定(ページ設定の「先頭ページ番号」)があれば、&P はその番号から数える
        const shownPageNo = settings?.firstPageNumber != null ? settings.firstPageNumber + pageNo - 1 : pageNo;
        const ctx = { pageInSheet: shownPageNo, totalPagesInSheet: totalPagesForSheet, sheetName: sheet.name };
        const header = sectionsFor("header", pageNo);
        if (header) {
          drawHeaderFooterSections(
            page,
            {
              left: resolveHeaderFooterTokens(header.left, ctx),
              center: resolveHeaderFooterTokens(header.center, ctx),
              right: resolveHeaderFooterTokens(header.right, ctx),
              sizes: header.sizes,
            },
            pageHeight - headerMarginPt - hfSize(header),
            marginLeft,
            pageWidth - marginRight,
            hfBaseSize,
            hfScale
          );
        }
        const footer = sectionsFor("footer", pageNo);
        if (footer) {
          drawHeaderFooterSections(
            page,
            {
              left: resolveHeaderFooterTokens(footer.left, ctx),
              center: resolveHeaderFooterTokens(footer.center, ctx),
              right: resolveHeaderFooterTokens(footer.right, ctx),
              sizes: footer.sizes,
            },
            Math.max(footerMarginPt, 4),
            marginLeft,
            pageWidth - marginRight,
            hfBaseSize,
            hfScale
          );
        }
      }
    }

    const chartPageCheck: ChartPageCheckResult = { checkedCharts, issues: sortIssues(chartIssues) };
    if (analyzeOnly) {
      return { blob: new Blob([], { type: "application/pdf" }), pageCount: analyzedPageCount, sizeBytes: 0, warnings: [], sheetCount, totalRowCount: totalRows, chartPageCheck };
    }

    if (skippedBlankPages > 0) {
      warnings.push(`値・書式・画像・グラフが何も無いページ${skippedBlankPages}枚は、出力していません`);
    }
    if (unresolvedCharts.size > 0) {
      const bySheet = new Map<string, number>();
      for (const u of unresolvedCharts.values()) bySheet.set(u.sheet, (bySheet.get(u.sheet) ?? 0) + u.series);
      for (const [name, n] of bySheet) {
        warnings.push(`「${name}」のグラフで、データを読み取れない系列が${n}個ありました（別のブックや、見つからない名前を参照している等）。その系列は描いていません`);
      }
    }
    if (chartDrawFailures > 0) warnings.push(`グラフ${chartDrawFailures}個は、描く途中で問題が起きたため、その場所に枠と説明を表示しています`);
    if (chartsDrawn > 0) {
      warnings.push("グラフは、Excelの見た目に近づけて描いています。文字の位置や目盛りの間隔などが少し異なることがあるため、変換後のPDFをご確認ください");
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
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
      warnings: Array.from(new Set(warnings)),
      sheetCount,
      totalRowCount: totalRows,
      chartPageCheck,
    };
  }
}
