import { unzipSync } from "fflate";
import { baseCellOf, type ConditionalRule, type DxfStyle } from "@/lib/excel/conditional-format";
import { parseSheetDrawings, type SheetDrawings } from "@/lib/excel/ooxml-drawings";

/**
 * XLSX（OOXML/SpreadsheetML）内部XMLから、印刷に関わる設定を直接読み取る
 * （Phase 18.2 B-19）。
 *
 * read-excel-file（既存依存）はセルの値だけを返し、印刷範囲・用紙サイズ・
 * 印刷方向・余白・改ページ・非表示行列・セル罫線などの「印刷設定」は
 * 取得できない。これらの情報はXLSXファイル自体（ZIP化されたXML群）の中に
 * 存在するため、新しい巨大なExcel解析ライブラリを追加する代わりに、
 * 既存のZIP解凍基盤（fflate。src/lib/processors/browser/file-unzip.ts で
 * 既に採用済み）とブラウザ標準のDOMParserだけを使い、必要なXMLを直接読む
 * （開発指示書J「新規npmパッケージは原則追加しない」）。
 *
 * 取得できる情報はExcelファイルの保存状態に依存するため、すべての項目が
 * 常に取得できるとは限らない。取得できない項目はnull/未設定として返し、
 * 呼び出し側（excel-to-pdf.ts）で妥当なフォールバック（既存の内容量ベースの
 * 推定・UIでの手動指定）を使う。パース自体に失敗した場合も例外を投げず、
 * 「情報なし」として扱う（PDF変換自体を止めないため）。
 */

export interface CellRangeRef {
  /** 0始まり */
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** ECMA-376 ST_PaperSize の主要な値のみ対応（それ以外はnull=不明） */
const PAPER_SIZE_MAP: Record<number, string> = {
  1: "Letter",
  3: "Tabloid",
  5: "Legal",
  7: "Executive",
  8: "A3",
  9: "A4",
  11: "A5",
  12: "B4",
  13: "B5",
  66: "A2",
  70: "A6",
};

/** 罫線の種類(OOXMLのborder style)。none以外はすべて対応表で描き分ける */
export type BorderLineStyle =
  | "hair"
  | "thin"
  | "medium"
  | "thick"
  | "dotted"
  | "dashed"
  | "dashDot"
  | "dashDotDot"
  | "mediumDashed"
  | "mediumDashDot"
  | "mediumDashDotDot"
  | "slantDashDot"
  | "double";

export interface BorderSideStyle {
  style: BorderLineStyle;
  /** "#RRGGBB"。自動(黒)・解決できない色はnull */
  color: string | null;
}

export interface CellBorderStyles {
  top?: BorderSideStyle;
  bottom?: BorderSideStyle;
  left?: BorderSideStyle;
  right?: BorderSideStyle;
}

/** セル内の一部の文字だけ書式が違う「リッチテキスト」の1区間 */
export interface RichRun {
  text: string;
  fontSizePt: number | null;
  bold: boolean | null;
  italic: boolean | null;
  underline: "single" | "double" | null;
  strike: boolean | null;
  /** "#RRGGBB"。指定が無ければnull(セルの文字色を使う) */
  color: string | null;
  serif: boolean | null;
  vertAlign: "super" | "sub" | null;
}

/** セルの文字の装飾(斜体・下線・取り消し線・明朝体・上付き/下付き)。既定値のセルは記録しない */
export interface CellFontExtras {
  serif?: boolean;
  italic?: boolean;
  underline?: "single" | "double";
  strike?: boolean;
  vertAlign?: "super" | "sub";
}

export interface SheetPicture {
  /** 配置(0始まりのセル位置＋セル内オフセット(pt))。oneCell/absoluteは終点をext(pt)から求める */
  fromCol: number;
  fromRow: number;
  fromColOffPt: number;
  fromRowOffPt: number;
  toCol: number | null;
  toRow: number | null;
  toColOffPt: number;
  toRowOffPt: number;
  /** 終点が無い(oneCellAnchor/absoluteAnchor)場合の大きさ(pt) */
  extWidthPt: number | null;
  extHeightPt: number | null;
  mime: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

export interface SheetShape {
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
  kind: "rect" | "roundRect" | "ellipse" | "line";
  fill: string | null;
  line: string | null;
  lineWidthPt: number;
  text: string;
  textColor: string | null;
  fontSizePt: number | null;
  bold: boolean;
}

export interface SheetPageSettings {
  printArea: CellRangeRef | null;
  /** 印刷範囲が複数ある場合のすべて(Excelは範囲ごとに別ページへ印刷する)。1つなら[printArea] */
  printAreas: CellRangeRef[];
  /** 印刷タイトル(毎ページに繰り返す行・列)。0始まり・両端を含む */
  printTitleRows: { start: number; end: number } | null;
  printTitleCols: { start: number; end: number } | null;
  /** pageSetup@blackAndWhite: 白黒印刷(色を使わず黒とグレーで印刷) */
  blackAndWhite: boolean;
  /** printOptions@gridLines: 枠線を印刷する */
  printGridLines: boolean;
  paperSize: string | null;
  /** pageSetup@paperSize(ECMA-376の番号)。未対応の用紙番号を警告するために保持する */
  paperSizeCode: number | null;
  orientation: "portrait" | "landscape" | null;
  /** sheetPr/pageSetUpPr@fitToPage が true のとき、fitToWidth/fitToHeightを優先する */
  fitToPageEnabled: boolean;
  /**
   * 0 = 制限なし（列/行方向は内容量に任せる）。
   * null = <pageSetup>要素自体が存在せず本当に情報が取得できない場合のみ
   * （<pageSetup>はあるがfitToWidth/fitToHeight属性だけが省略されている場合は、
   * OOXML既定値の1として解決済みの値が入る。parseSheetXml参照）。
   */
  fitToWidth: number | null;
  fitToHeight: number | null;
  /** pageSetup@scale（%）。fitToPageEnabledがtrueの場合は無視してfitToWidth/Heightを優先する（実際のExcelの優先順位） */
  scalePercent: number | null;
  /** インチ単位（OOXML標準） */
  margins: { top: number; bottom: number; left: number; right: number; header: number; footer: number } | null;
  /** 0始まりの行番号の集合 */
  hiddenRows: Set<number>;
  /** 0始まりの列番号の集合 */
  hiddenCols: Set<number>;
  /** pt単位。key=0始まり列番号 */
  columnWidthsPt: Map<number, number>;
  /** pt単位。key=0始まり行番号 */
  rowHeightsPt: Map<number, number>;
  /**
   * シートの既定の行の高さ(pt単位。sheetFormatPr@defaultRowHeight)。
   * 明示的な高さ(row@ht)を持たない行はこの高さで描画される（Excel自体の
   * 挙動）。取得できない場合はnull（呼び出し側は従来どおり内容量から見積もる）。
   */
  defaultRowHeightPt: number | null;
  /** 列幅が指定されていない列の幅(pt)。sheetFormatPr@defaultColWidth/baseColWidthから求める。取得できなければnull */
  defaultColumnWidthPt: number | null;
  /** 明示的な改ページの直前の行番号（0始まり。「この行の後で改ページ」の意味） */
  rowBreaksAfter: number[];
  colBreaksAfter: number[];
  /** key: "row:col"(0始まり)。値: その辺に実際に罫線が設定されているか */
  cellBorders: Map<string, { top: boolean; bottom: boolean; left: boolean; right: boolean }>;
  /** cellBordersと同じキー。辺ごとの罫線の種類(極細・点線・二重線等)と色 */
  cellBorderStyles: Map<string, CellBorderStyles>;
  /**
   * 条件付き書式(<conditionalFormatting>)の規則。Excelでセルの値に応じて背景色・文字色・
   * 太字が変わる設定(例: 土日の行をグレーにする)で、セルのスタイルとは別に保存されている。
   * 評価は値が必要なため、描画側(excel-to-pdf.ts)でevaluateConditionalFormatsを呼ぶ。
   */
  conditionalRules: ConditionalRule[];
  /**
   * セルの背景色・文字色・太字（開発指示書§29-31「Excelの色がPDFに反映されない」対応）。
   * 取得できる／実際に指定されている場合のみキーを持つ（既定色・塗りつぶしなしのセルは
   * 記録しない。cellBordersと同じ「差分だけを持つ」方針で、巨大シートでのMapサイズを
   * 抑える）。値は"#RRGGBB"形式。rgb属性による明示指定に加え、theme属性(tint込み)の
   * 色解決にも対応する(xl/theme/theme1.xmlのclrSchemeから解決。詳細はparseThemeColors
   * 参照)。indexed color(indexedColors.xml相当の固定パレット)のみ今回は未対応。
   */
  cellFills: Map<string, string>;
  cellFontColors: Map<string, string>;
  cellBold: Map<string, boolean>;
  /**
   * ヘッダー/フッター(開発指示書B-9・B-10、Phase 22)。Excel側で設定されている
   * 場合のみ値を持つ(未設定ならnull)。oddHeader/oddFooter(既定のヘッダー/
   * フッター)のみ対応し、ページ番号ごとに内容が変わるfirstHeader/evenHeader等
   * (differentFirst/differentOddEven)には対応しない(D-3: 完全互換は謳わない)。
   * &P(ページ番号)・&N(総ページ数)・&D(日付)・&T(時刻)・&A(シート名)・&F(ファイル名)
   * といったフィールドコードは、実際の値へ解決せず {{PAGE}} 等のプレースホルダー
   * 文字列のまま返す(ページ番号・総ページ数はページ分割が確定するexcel-to-pdf.ts
   * 側でしか分からないため、解決はレンダリング側の責務とする)。
   */
  header: HeaderFooterSections | null;
  footer: HeaderFooterSections | null;
  /** 先頭ページだけ・偶数ページだけ別のヘッダー/フッターを使う設定(differentFirst/differentOddEven) */
  differentFirst: boolean;
  differentOddEven: boolean;
  firstHeader: HeaderFooterSections | null;
  firstFooter: HeaderFooterSections | null;
  evenHeader: HeaderFooterSections | null;
  evenFooter: HeaderFooterSections | null;
  /** 斜めの罫線(左下→右上 = up、左上→右下 = down) */
  cellDiagonals: Map<string, { up?: BorderSideStyle; down?: BorderSideStyle }>;
  cellFontExtras: Map<string, CellFontExtras>;
  /** セル内の部分的な書式(リッチテキスト)。キーはcellBordersと同じ */
  cellRich: Map<string, RichRun[]>;
  pictures: SheetPicture[];
  shapes: SheetShape[];
  /** PNG・JPEG以外の画像(GIF・BMP等)。描画側でブラウザの機能を使ってPNGへ変換して使う */
  otherImages: SheetDrawings["otherImages"];
  /** 再現できない図形・グラフ等の数(警告表示用) */
  unsupportedDrawingCount: number;
  /**
   * 結合セル(<mergeCells>)。Excelで結合されたセルは、左上セル(アンカー)の値が
   * 結合範囲全体にまたがって表示される。結合情報が無いと、アンカーの文字が
   * 結合前の1セル分の幅に押し込められて途中で切れてしまう（例: A1:J1に結合された
   * 中央揃えのタイトルが、A列の幅だけで切れて「＜」だけになる）。
   */
  merges: CellRangeRef[];
  /** ブックの既定フォント(styles.xmlのfonts[0])のサイズ(pt)。セルごとのサイズが取れない場合の基準 */
  defaultFontSizePt: number | null;
  /** ブックの既定フォントが明朝系か(スタイル番号の無いセルの書体の判定用) */
  defaultFontSerif: boolean;
  /** セルの配置(横・縦・折り返し)。style(xf)に<alignment>がある場合のみキーを持つ */
  cellAlign: Map<string, CellAlign>;
  /** セルの文字サイズ(pt)。fonts[]のsz。 */
  cellFontSizePt: Map<string, number>;
  /**
   * 日付として表示するセルの書式コード(numFmtの定義。組み込みIDは対応する書式コードへ解決済み)。
   * read-excel-fileは日付セルをDate型で返すが、「どう表示するか」(2026/9/25・2026年9月25日・
   * 令和8年9月25日 等)の情報は持たないため、styles.xmlから読み取る。
   */
  cellDateFormat: Map<string, string>;
  /** 数値として表示するセルの書式コード(日付以外。General・@は含まない) */
  cellNumFormat: Map<string, string>;
  /** <printOptions horizontalCentered/verticalCentered>: ページ内で表を左右/上下の中央に配置する */
  horizontalCentered: boolean;
  verticalCentered: boolean;
}

export interface CellAlign {
  /** distributed = 均等割り付け(文字を領域の幅いっぱいに均等に並べる) */
  horizontal: "left" | "center" | "right" | "distributed" | null;
  vertical: "top" | "center" | "bottom" | null;
  wrapText: boolean;
  /** 縮小して全体を表示（セルの幅に収まるよう文字を小さくする） */
  shrinkToFit: boolean;
  /** 字下げ(インデント)の段数 */
  indent: number;
  /**
   * 文字の向き。0=横書き、1〜90=反時計回りの回転角度、-1〜-90=時計回りの回転角度、
   * 255=縦書き(文字を縦に積む)
   */
  textRotation: number;
  /** 選択範囲内で中央(centerContinuous): 右隣の空きセルにまたがって中央に寄せる */
  centerContinuous: boolean;
}

export interface HeaderFooterSections {
  left: string;
  center: string;
  right: string;
}

function emptySheetSettings(): SheetPageSettings {
  return {
    printArea: null,
    printAreas: [],
    printTitleRows: null,
    printTitleCols: null,
    blackAndWhite: false,
    printGridLines: false,
    paperSize: null,
    paperSizeCode: null,
    orientation: null,
    fitToPageEnabled: false,
    fitToWidth: null,
    fitToHeight: null,
    scalePercent: null,
    margins: null,
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    columnWidthsPt: new Map(),
    rowHeightsPt: new Map(),
    defaultRowHeightPt: null,
    defaultColumnWidthPt: null,
    rowBreaksAfter: [],
    colBreaksAfter: [],
    cellBorders: new Map(),
    cellBorderStyles: new Map(),
    conditionalRules: [],
    cellFills: new Map(),
    cellFontColors: new Map(),
    cellBold: new Map(),
    header: null,
    footer: null,
    differentFirst: false,
    differentOddEven: false,
    firstHeader: null,
    firstFooter: null,
    evenHeader: null,
    evenFooter: null,
    cellDiagonals: new Map(),
    cellFontExtras: new Map(),
    cellRich: new Map(),
    pictures: [],
    shapes: [],
    otherImages: [],
    unsupportedDrawingCount: 0,
    merges: [],
    defaultFontSizePt: null,
    defaultFontSerif: false,
    cellAlign: new Map(),
    cellFontSizePt: new Map(),
    cellDateFormat: new Map(),
    cellNumFormat: new Map(),
    horizontalCentered: false,
    verticalCentered: false,
  };
}

/**
 * OOXMLのヘッダー/フッター文字列(&L/&C/&Rで左/中央/右セクションを区切り、
 * &"フォント名,スタイル"・&nn(フォントサイズ)・&B/&I/&U等(太字/斜体/下線等の
 * トグル)・&K RRGGBB(色)・&G(埋め込み画像)といった書式コードを含む)を、
 * 実際に描画に使う3セクションのプレーンテキストへ変換する。
 *
 * &P(ページ番号)・&N(総ページ数)・&D(日付)・&T(時刻)・&A(シート名)・&F(ファイル名)
 * は、この時点ではまだ値を解決できない(特に&P/&Nはページ分割の確定後にしか
 * 分からない)ため、後段(excel-to-pdf.ts)で文字列置換するプレースホルダーへ
 * 変換するだけにとどめる。フォント指定・色・画像等、この処理系で再現しない
 * 書式コードは読み飛ばす(D-3: 完全互換は謳わない)。
 */
export function parseHeaderFooterSections(raw: string): HeaderFooterSections {
  // "&&" はリテラルの"&"1文字を表すエスケープ。他の処理より先に、衝突しない
  // 一時トークンへ退避しておく。
  const AMP_ESCAPE = "\u0000AMP\u0000";
  let s = raw.replace(/&&/g, AMP_ESCAPE);

  // フィールドコード(値を後段で解決するプレースホルダーへ置換)
  s = s
    .replace(/&P/g, "{{PAGE}}")
    .replace(/&N/g, "{{PAGES}}")
    .replace(/&D/g, "{{DATE}}")
    .replace(/&T/g, "{{TIME}}")
    .replace(/&A/g, "{{SHEET}}")
    .replace(/&F/g, "{{FILE}}")
    .replace(/&Z/g, "") // &Z(ファイルパス)は取得できないため単に除去する
    .replace(/&G/g, ""); // &G(埋め込み画像)は今回対応しないため除去する

  // フォント指定・フォントサイズ・太字/斜体/下線等のトグル・文字色は、この
  // 実装では再現しないため読み飛ばす。
  s = s.replace(/&"[^"]*"/g, "");
  s = s.replace(/&K[0-9A-Fa-f]{6}/g, "");
  s = s.replace(/&\d{1,3}/g, "");
  s = s.replace(/&[BIUESXYO]/g, "");

  s = s.replace(new RegExp(AMP_ESCAPE, "g"), "&");

  const sections: HeaderFooterSections = { left: "", center: "", right: "" };
  const markerRe = /&([LCR])/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let currentKey: "left" | "center" | "right" | null = null;
  const keyByLetter: Record<string, "left" | "center" | "right"> = { L: "left", C: "center", R: "right" };

  const assign = (key: "left" | "center" | "right" | null, text: string) => {
    if (!key || text === "") return;
    sections[key] += text;
  };

  while ((match = markerRe.exec(s)) !== null) {
    assign(currentKey, s.slice(lastIndex, match.index));
    currentKey = keyByLetter[match[1]];
    lastIndex = markerRe.lastIndex;
  }
  assign(currentKey, s.slice(lastIndex));

  return {
    left: sections.left.trim(),
    center: sections.center.trim(),
    right: sections.right.trim(),
  };
}

/** "A1" 形式のセル参照を0始まりの{row, col}へ変換する */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const colLetters = m[1];
  let col = 0;
  for (const ch of colLetters) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: Number(m[2]) - 1, col: col - 1 };
}

/** "Sheet1!$A$1:$H$30" のような印刷範囲文字列をパースする（複数範囲がある場合は最初の1つのみ対応） */
function parsePrintAreaRef(defined: string): CellRangeRef | null {
  // シート名部分（"'名前'!"または"名前!"）を除去し、セル範囲部分だけを取り出す
  const parts = defined.split("!");
  const rangePart = (parts.length > 1 ? parts[1] : parts[0]).split(",")[0];
  const cleaned = rangePart.replace(/\$/g, "");
  const [startRef, endRef] = cleaned.split(":");
  const start = parseCellRef(startRef);
  if (!start) return null;
  const end = endRef ? parseCellRef(endRef) : start;
  if (!end) return null;
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  };
}

/**
 * Excelの列幅（文字単位）をpt単位へ変換する。
 * mdwは「Normalスタイルのフォントでの半角数字の最大幅(px)」(Maximum Digit
 * Width)。この値はシートのNormalスタイルのフォントによって変わるため、
 * 呼び出し側(resolveMaximumDigitWidth)で実際のフォント名から推定した値を渡す。
 */
function excelColumnWidthToPt(charWidth: number, mdw: number): number {
  const px = Math.floor(((256 * charWidth + Math.floor(128 / mdw)) / 256) * mdw);
  return px * 0.75; // px(96dpi) → pt(72dpi)
}

/**
 * styles.xmlの<fonts>の0番目(Normalスタイル＝既定フォント)の名前から、列幅の
 * pt変換で使うMDW(Maximum Digit Width)を推定する。
 *
 * OOXMLの列幅(文字単位)は「Normalスタイルのフォントでの半角数字0の幅」を
 * 1文字分の基準とする仕様のため、既定フォントがCalibri系(MDW=7px、本関数の
 * フォールバック値)以外の場合、特に游ゴシック等の日本語Excelで標準的に
 * 使われるフォントの場合、Calibri基準のMDW=7のままだと列幅合計・ひいては
 * Fit to Widthの縮小率やページ分割がExcel実際の計算から数%ずれることが
 * 判明した(「Excel通りになってない」調査、ページ数が1枚多くなる不具合)。
 *
 * 游ゴシック等の正確なMDWはExcel/フォントの内部実装に依存し一次情報を
 * 入手できていないため、公開されている実測報告(標準の列幅が游ゴシック
 * 11pt≈8.1文字、ＭＳ Ｐゴシック11pt≈8.11文字、メイリオ11pt≈8.09文字。
 * 対してCalibri 11ptは8.43文字=MDW7px)から比率的に逆算した近似値
 * (7.3px)を使う。OS・Excelのバージョン・画面スケーリングによる実際の
 * ばらつきもあるため、この近似だけで常にExcelと完全に一致するとは限らない
 * （開発指示書E章「完全再現は保証しない」の方針どおり）。
 */
// 比較対象(fontName)は必ず.toLowerCase()を通すため、ここに置くキーも
// 同じ変換結果に揃える(全角英字は.toLowerCase()で全角小文字になる点に注意。
// 例: "ＭＳ Ｐゴシック" → "ｍｓ　ｐゴシック"ではなく実際には全角スペースを
// 含むため、半角・全角どちらの表記揺れも個別に列挙する)。
const JP_GOTHIC_DEFAULT_FONT_NAMES = new Set(
  [
    "游ゴシック",
    "yu gothic",
    "メイリオ",
    "meiryo",
    "ＭＳ Ｐゴシック",
    "ms pゴシック",
    "ms pgothic",
    "ＭＳ ゴシック",
    "ms ゴシック",
    "ms gothic",
    // 明朝体の既定フォントも、日本語Excelでは同じ標準の列幅(72ピクセル)になる
    "ＭＳ Ｐ明朝",
    "ms p明朝",
    "ms pmincho",
    "ＭＳ 明朝",
    "ms 明朝",
    "ms mincho",
    "游明朝",
    "yu mincho",
  ].map(normalizeFontNameForCompare)
);

/** フォント名の表記揺れ(全角・半角、大文字・小文字)をそろえて比べるための変換 */
function normalizeFontNameForCompare(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

function resolveMaximumDigitWidth(stylesXmlText: string | null): number {
  const CALIBRI_MDW = 7;
  const JP_GOTHIC_MDW = 7.3;
  if (!stylesXmlText) return CALIBRI_MDW;
  const doc = parseXml(stylesXmlText);
  if (!doc) return CALIBRI_MDW;
  const firstFont = doc.getElementsByTagName("fonts")[0]?.getElementsByTagName("font")[0];
  const rawFontName = firstFont?.getElementsByTagName("name")[0]?.getAttribute("val") ?? null;
  const fontName = rawFontName ? normalizeFontNameForCompare(rawFontName) : null;
  if (fontName && JP_GOTHIC_DEFAULT_FONT_NAMES.has(fontName)) return JP_GOTHIC_MDW;
  return CALIBRI_MDW;
}

async function readEntryText(entries: Record<string, Uint8Array>, path: string): Promise<string | null> {
  const data = entries[path];
  if (!data) return null;
  try {
    return new TextDecoder("utf-8").decode(data);
  } catch {
    return null;
  }
}

function parseXml(text: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
    return doc;
  } catch {
    return null;
  }
}

interface BorderDef {
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
  /** 辺ごとの種類・色(罫線がある辺のみ) */
  styles?: CellBorderStyles;
  diagonalUp?: BorderSideStyle;
  diagonalDown?: BorderSideStyle;
}

/** resolvedスタイル1件分（cellXfsのxf要素1つに対応する、セル1スタイルぶんの情報） */
interface ResolvedCellStyle {
  border: BorderDef;
  /** "#RRGGBB"。塗りつぶしなし・indexed/theme色など解決できない場合はnull */
  fillRgb: string | null;
  fontRgb: string | null;
  bold: boolean;
  /** fonts[]のsz(pt)。取得できなければnull */
  fontSizePt: number | null;
  /** <alignment>要素。無ければnull */
  align: CellAlign | null;
  /** 日付として解釈できる数値書式(numFmt)の書式コード。日付書式でなければnull */
  dateFormatCode: string | null;
  /** 日付以外の数値書式の書式コード(General・@なら null) */
  numFormatCode: string | null;
  /** 明朝体・斜体・下線・取り消し線・上付き下付き。既定のセルはnull */
  fontExtras: CellFontExtras | null;
}

/** styles.xml全体から読み取った、セルスタイル一覧とブック既定フォントの情報 */
interface ParsedStyles {
  cellStyles: ResolvedCellStyle[];
  /** 条件付き書式が参照する差分スタイル(<dxfs>)。インデックスはdxfId */
  dxfs: DxfStyle[];
  defaultFontName: string | null;
  defaultFontSizePt: number | null;
  colorCtx: ColorCtx;
}

/**
 * 組み込みの数値書式ID(ECMA-376)のうち日付・時刻にあたるものを、日本語環境のExcelでの
 * 表示に合わせた書式コードへ解決する。ID 14(「mm-dd-yy」と記載されることが多い)は、
 * 実際のExcelでは地域設定に従い日本語環境では「2026/9/25」と表示される。
 */
/** 組み込みの数値書式ID(ECMA-376)のうち、日付以外でよく使われるもの */
const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  37: "#,##0_);(#,##0)",
  38: "#,##0_);[Red](#,##0)",
  39: "#,##0.00_);(#,##0.00)",
  40: "#,##0.00_);[Red](#,##0.00)",
};

const BUILTIN_DATE_FORMATS: Record<number, string> = {
  14: "yyyy/m/d",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "yyyy/m/d h:mm",
  27: "[$-411]ge.m.d",
  28: "[$-411]ggge\"年\"m\"月\"d\"日\"",
  29: "[$-411]ggge\"年\"m\"月\"d\"日\"",
  30: "m/d/yy",
  31: "yyyy\"年\"m\"月\"d\"日\"",
  32: "h\"時\"mm\"分\"",
  33: "h\"時\"mm\"分\"ss\"秒\"",
  34: "yyyy\"年\"m\"月\"",
  35: "m\"月\"d\"日\"",
  36: "[$-411]ge.m.d",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  50: "[$-411]ge.m.d",
  51: "[$-411]ggge\"年\"m\"月\"d\"日\"",
  52: "yyyy\"年\"m\"月\"",
  53: "m\"月\"d\"日\"",
  54: "[$-411]ggge\"年\"m\"月\"d\"日\"",
  55: "yyyy\"年\"m\"月\"",
  56: "m\"月\"d\"日\"",
  57: "[$-411]ge.m.d",
  58: "[$-411]ggge\"年\"m\"月\"d\"日\"",
};

/** 書式コードが「日付・時刻の書式」か(引用符・[]内を除いてy/m/d/h/s/g/eの記号を含むか)を判定する */
function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[ymdhsge]/i.test(stripped) && !/^(General|標準)$/i.test(stripped.trim());
}

/**
 * OOXMLの色（ARGBの8桁16進、まれに6桁もそのまま許容）を"#RRGGBB"へ変換する。
 */
function argbToRgbHex(argb: string | null | undefined): string | null {
  if (!argb) return null;
  const hex = argb.replace(/^#/, "");
  if (hex.length === 8) return `#${hex.slice(2)}`; // AARRGGBB → RRGGBB
  if (hex.length === 6) return `#${hex}`;
  return null;
}

/**
 * xl/theme/theme1.xml の <a:clrScheme> から、テーマカラー12色を読み取り、
 * Excelが実際に使う theme属性のインデックス順（0=lt1,1=dk1,2=lt2,3=dk2,
 * 4〜9=accent1〜6,10=hlink,11=folHlink）に並べ替えて返す。
 *
 * 注意：<a:clrScheme>要素そのものの子要素の並び順は dk1,lt1,dk2,lt2,accent1〜6,
 * hlink,folHlink だが、セルの書式(styles.xml)が参照する theme="N" のインデックスは
 * これとは異なり、1番目と2番目（dk1とlt1）・3番目と4番目（dk2とlt2）が入れ替わった
 * 順序になる（ECMA-376では明記されているが見落としやすい、実装上よく知られた注意点）。
 * ここを間違えると「文字色のtheme=1（本来は黒=dk1）」のような基本的な色まで
 * 誤って解決してしまうため、Excelの実際の挙動に合わせた順序でマッピングする。
 */
function parseThemeColors(themeXmlText: string | null): string[] | null {
  if (!themeXmlText) return null;
  const doc = parseXml(themeXmlText);
  if (!doc) return null;
  const clrScheme = doc.getElementsByTagName("a:clrScheme")[0] ?? doc.getElementsByTagName("clrScheme")[0];
  if (!clrScheme) return null;

  const readOne = (tag: string): string | null => {
    const el = Array.from(clrScheme.children).find((c) => c.tagName === tag || c.tagName === `a:${tag}`);
    if (!el) return null;
    const srgb = el.getElementsByTagName("a:srgbClr")[0] ?? el.getElementsByTagName("srgbClr")[0];
    if (srgb) return argbToRgbHex(srgb.getAttribute("val"));
    const sysClr = el.getElementsByTagName("a:sysClr")[0] ?? el.getElementsByTagName("sysClr")[0];
    if (sysClr) return argbToRgbHex(sysClr.getAttribute("lastClr"));
    return null;
  };

  const dk1 = readOne("dk1");
  const lt1 = readOne("lt1");
  const dk2 = readOne("dk2");
  const lt2 = readOne("lt2");
  const accents = [1, 2, 3, 4, 5, 6].map((n) => readOne(`accent${n}`));
  const hlink = readOne("hlink");
  const folHlink = readOne("folHlink");

  // Excelのtheme属性インデックス順（dk1/lt1・dk2/lt2が入れ替わる点に注意）
  return [lt1, dk1, lt2, dk2, ...accents, hlink, folHlink].map((c) => c ?? "#000000");
}

/**
 * "#RRGGBB"をRGB(0-1)→HSLへ変換し、Lを調整してからRGBへ戻す（ECMA-376の
 * テーマカラーtint適用アルゴリズム）。tint<0で暗く、tint>0で明るく（白に近づく
 * 方向へ）補正する。単純にRGB各チャンネルへ同じ式を適用する簡易近似ではなく、
 * 実際にExcelが行うHSLの明度(L)調整を再現する。
 */
function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hDeg = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hDeg = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        hDeg = (b - r) / d + 2;
        break;
      default:
        hDeg = (r - g) / d + 4;
    }
    hDeg /= 6;
  }

  const newL = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;

  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };

  let nr: number;
  let ng: number;
  let nb: number;
  if (s === 0) {
    nr = ng = nb = newL;
  } else {
    const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s;
    const p = 2 * newL - q;
    nr = hue2rgb(p, q, hDeg + 1 / 3);
    ng = hue2rgb(p, q, hDeg);
    nb = hue2rgb(p, q, hDeg - 1 / 3);
  }

  const toHex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

/** 色の解決に使う、テーマカラー表とインデックスカラー(パレット)表 */
interface ColorCtx {
  theme: string[] | null;
  /** indexed属性の色(0〜63)。styles.xmlの<indexedColors>があればそれ、無ければExcel標準のパレット */
  indexed: string[];
}

/** Excel標準のインデックスカラー(0〜63)。64以降は「システム前景色(自動=黒)」「システム背景色(白)」 */
const DEFAULT_INDEXED_COLORS: string[] = [
  "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
  "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
  "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#808080",
  "#9999FF", "#993366", "#FFFFCC", "#CCFFFF", "#660066", "#FF8080", "#0066CC", "#CCCCFF",
  "#000080", "#FF00FF", "#FFFF00", "#00FFFF", "#800080", "#800000", "#008080", "#0000FF",
  "#00CCFF", "#CCFFFF", "#CCFFCC", "#FFFF99", "#99CCFF", "#FF99CC", "#CC99FF", "#FFCC99",
  "#3366FF", "#33CCCC", "#99CC00", "#FFCC00", "#FF9900", "#FF6600", "#666699", "#969696",
  "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
];

/**
 * <color rgb="FFRRGGBB"/>（明示的な色）、<color theme="N" tint="..."/>（テーマカラー参照）、
 * <color indexed="N"/>（パレット番号による色指定。64は「自動」でnull）から解決できる色を読む。
 */
function readColorEl(colorEl: Element | undefined, ctx: ColorCtx): string | null {
  if (!colorEl) return null;
  const explicit = argbToRgbHex(colorEl.getAttribute("rgb"));
  if (explicit) return explicit;
  const themeAttr = colorEl.getAttribute("theme");
  if (themeAttr !== null && ctx.theme) {
    const idx = Number(themeAttr);
    const base = ctx.theme[idx];
    if (!base) return null;
    const tintAttr = colorEl.getAttribute("tint");
    return tintAttr !== null ? applyTint(base, Number(tintAttr)) : base;
  }
  const indexedAttr = colorEl.getAttribute("indexed");
  if (indexedAttr !== null) {
    const idx = Number(indexedAttr);
    if (idx >= 0 && idx < ctx.indexed.length) return ctx.indexed[idx];
    return null; // 64=自動(黒)・65=白(システム背景)など。呼び出し側の既定色に任せる
  }
  return null;
}

function readIndexedColors(doc: Document): string[] {
  const el = doc.getElementsByTagName("indexedColors")[0];
  if (!el) return DEFAULT_INDEXED_COLORS;
  const custom = Array.from(el.getElementsByTagName("rgbColor")).map((c) => argbToRgbHex(c.getAttribute("rgb")));
  if (custom.length === 0 || custom.some((c) => c === null)) return DEFAULT_INDEXED_COLORS;
  return custom as string[];
}

/** 明朝体系のフォント名か(セルの文字を明朝体で描くかの判定) */
export function isSerifFontName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /明朝|mincho|serif|times|georgia|cambria|century|palatino|garamond|book antiqua|batang|song|ming/i.test(name) && !/sans/i.test(name);
}

/** パターン塗りつぶしの濃さ(0〜1)。縞模様等は同じ濃さの単色で近似する(線の細かい模様までは再現しない) */
const PATTERN_DENSITY: Record<string, number> = {
  gray125: 0.125,
  gray0625: 0.0625,
  lightGray: 0.25,
  mediumGray: 0.5,
  darkGray: 0.75,
  lightDown: 0.28,
  lightUp: 0.28,
  lightHorizontal: 0.28,
  lightVertical: 0.28,
  lightGrid: 0.35,
  lightTrellis: 0.32,
  darkDown: 0.6,
  darkUp: 0.6,
  darkHorizontal: 0.6,
  darkVertical: 0.6,
  darkGrid: 0.65,
  darkTrellis: 0.62,
};

function blendHex(bg: string, fg: string, t: number): string {
  const c = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) =>
    Math.round(c(bg, i) * (1 - t) + c(fg, i) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/** <fill>要素から、描画に使う単色(パターンは濃さで近似)を求める。塗りなしはnull */
function resolveFillEl(fill: Element, ctx: ColorCtx, preferBg: boolean): string | null {
  const patternFill = fill.getElementsByTagName("patternFill")[0];
  if (!patternFill) return null;
  const patternType = patternFill.getAttribute("patternType");
  const fg = readColorEl(patternFill.getElementsByTagName("fgColor")[0], ctx);
  const bg = readColorEl(patternFill.getElementsByTagName("bgColor")[0], ctx);
  if (patternType === "solid") return preferBg ? (bg ?? fg) : fg;
  if (patternType && patternType !== "none" && PATTERN_DENSITY[patternType] !== undefined) {
    return blendHex(bg ?? "#FFFFFF", fg ?? "#000000", PATTERN_DENSITY[patternType]);
  }
  // 条件付き書式(dxf)ではpatternType省略で色だけ指定されることがある
  if (!patternType && preferBg) return bg ?? fg;
  return null;
}

function parseBorderSide(b: Element, tag: string, ctx: ColorCtx): BorderSideStyle | null {
  const el = b.getElementsByTagName(tag)[0];
  // <top style="thin">...</top> のように style属性を持つ(かつ"none"でない)場合のみ罫線ありとみなす
  const style = el?.getAttribute("style");
  if (!el || !style || style === "none") return null;
  return { style: style as BorderLineStyle, color: readColorEl(el.getElementsByTagName("color")[0], ctx) };
}

function parseFontEl(fontEl: Element | undefined, ctx: ColorCtx) {
  const flag = (tag: string) => {
    const el = fontEl?.getElementsByTagName(tag)[0];
    return !!el && el.getAttribute("val") !== "0" && el.getAttribute("val") !== "false";
  };
  const uEl = fontEl?.getElementsByTagName("u")[0];
  const uVal = uEl ? (uEl.getAttribute("val") ?? "single") : null;
  const vertAttr = fontEl?.getElementsByTagName("vertAlign")[0]?.getAttribute("val") ?? null;
  const szAttr = fontEl?.getElementsByTagName("sz")[0]?.getAttribute("val");
  const sizePt = szAttr ? Number(szAttr) : null;
  return {
    rgb: readColorEl(fontEl?.getElementsByTagName("color")[0], ctx),
    bold: flag("b"),
    italic: flag("i"),
    strike: flag("strike"),
    underline: (uVal === null || uVal === "none" ? null : uVal === "double" || uVal === "doubleAccounting" ? "double" : "single") as
      | "single"
      | "double"
      | null,
    vertAlign: (vertAttr === "superscript" ? "super" : vertAttr === "subscript" ? "sub" : null) as "super" | "sub" | null,
    sizePt: sizePt !== null && Number.isFinite(sizePt) && sizePt > 0 ? sizePt : null,
    name: fontEl?.getElementsByTagName("name")[0]?.getAttribute("val") ?? fontEl?.getElementsByTagName("rFont")[0]?.getAttribute("val") ?? null,
  };
}

/**
 * styles.xml の <dxfs>(差分スタイル。条件付き書式が「条件に合ったとき上書きする書式」として
 * 参照する)を読み取る。背景色は<fill><patternFill>のbgColor(Excelは条件付き書式の塗りつぶしの
 * 色をここに保存する)、無ければfgColor。文字色は<font><color>、太字・斜体・下線・取り消し線は<font>、
 * 罫線は<border>。
 */
function parseDxfs(doc: Document, ctx: ColorCtx): DxfStyle[] {
  const dxfsEl = doc.getElementsByTagName("dxfs")[0];
  if (!dxfsEl) return [];
  return Array.from(dxfsEl.children)
    .filter((el) => el.tagName === "dxf")
    .map((dxf) => {
      const fontEl = Array.from(dxf.children).find((el) => el.tagName === "font");
      const fillEl = Array.from(dxf.children).find((el) => el.tagName === "fill");
      const borderEl = Array.from(dxf.children).find((el) => el.tagName === "border");
      const f = parseFontEl(fontEl, ctx);
      let borders: CellBorderStyles | null = null;
      if (borderEl) {
        const styles: CellBorderStyles = {};
        for (const side of ["top", "bottom", "left", "right"] as const) {
          const st = parseBorderSide(borderEl, side, ctx);
          if (st) styles[side] = st;
        }
        if (Object.keys(styles).length > 0) borders = styles;
      }
      return {
        fillRgb: fillEl ? resolveFillEl(fillEl, ctx, true) : null,
        fontRgb: f.rgb,
        bold: f.bold,
        italic: f.italic,
        underline: f.underline,
        strike: f.strike,
        borders,
      };
    });
}

/**
 * styles.xml の <fonts>/<fills>/<borders> と <cellXfs> から、
 * style index(s、セル側のs属性の値＝cellXfs内でのxf要素の出現順) → 罫線有無・
 * 背景色・文字色・太字 の対応表を作る（開発指示書§21-26・§29-31）。
 */
function parseCellStyles(stylesXmlText: string | null, themeColors: string[] | null): ParsedStyles {
  const empty: ParsedStyles = { cellStyles: [], dxfs: [], defaultFontName: null, defaultFontSizePt: null, colorCtx: { theme: themeColors, indexed: DEFAULT_INDEXED_COLORS } };
  if (!stylesXmlText) return empty;
  const doc = parseXml(stylesXmlText);
  if (!doc) return empty;
  const ctx: ColorCtx = { theme: themeColors, indexed: readIndexedColors(doc) };

  // <numFmts><numFmt numFmtId="164" formatCode="..."/>（ユーザー定義の数値書式）
  const customNumFmts = new Map<number, string>();
  const numFmtsEl = doc.getElementsByTagName("numFmts")[0];
  if (numFmtsEl) {
    for (const nf of Array.from(numFmtsEl.getElementsByTagName("numFmt"))) {
      const id = nf.getAttribute("numFmtId");
      const code = nf.getAttribute("formatCode");
      if (id !== null && code !== null) customNumFmts.set(Number(id), code);
    }
  }

  const borderDefs: BorderDef[] = [];
  const bordersEl = doc.getElementsByTagName("borders")[0];
  if (bordersEl) {
    for (const b of Array.from(bordersEl.getElementsByTagName("border"))) {
      const top = parseBorderSide(b, "top", ctx);
      const bottom = parseBorderSide(b, "bottom", ctx);
      const left = parseBorderSide(b, "left", ctx);
      const right = parseBorderSide(b, "right", ctx);
      const styles: CellBorderStyles = {};
      if (top) styles.top = top;
      if (bottom) styles.bottom = bottom;
      if (left) styles.left = left;
      if (right) styles.right = right;
      const diag = parseBorderSide(b, "diagonal", ctx);
      const diagUp = b.getAttribute("diagonalUp") === "1" || b.getAttribute("diagonalUp") === "true";
      const diagDown = b.getAttribute("diagonalDown") === "1" || b.getAttribute("diagonalDown") === "true";
      borderDefs.push({
        top: !!top,
        bottom: !!bottom,
        left: !!left,
        right: !!right,
        styles,
        diagonalUp: diag && diagUp ? diag : undefined,
        diagonalDown: diag && diagDown ? diag : undefined,
      });
    }
  }

  // <fills><fill><patternFill patternType="solid"><fgColor .../>。縞模様等のパターンは濃さで近似した単色にする。
  const fillRgbs: (string | null)[] = [];
  const fillsEl = doc.getElementsByTagName("fills")[0];
  if (fillsEl) {
    for (const fill of Array.from(fillsEl.getElementsByTagName("fill"))) {
      fillRgbs.push(resolveFillEl(fill, ctx, false));
    }
  }

  // <fonts><font><color rgb="FFRRGGBB"/><b/>...
  const fontDefs: ReturnType<typeof parseFontEl>[] = [];
  const fontsEl = doc.getElementsByTagName("fonts")[0];
  if (fontsEl) {
    for (const fontEl of Array.from(fontsEl.getElementsByTagName("font"))) fontDefs.push(parseFontEl(fontEl, ctx));
  }

  const cellXfsEl = doc.getElementsByTagName("cellXfs")[0];
  const result: ResolvedCellStyle[] = [];
  if (cellXfsEl) {
    const xfEls = Array.from(cellXfsEl.children).filter((el) => el.tagName === "xf");
    for (const xf of xfEls) {
      const borderId = xf.getAttribute("borderId");
      const fillId = xf.getAttribute("fillId");
      const fontId = xf.getAttribute("fontId");
      const border = borderDefs[borderId ? Number(borderId) : 0] ?? { top: false, bottom: false, left: false, right: false };
      // xf@applyFill="1"（または省略、Excel実ファイルではapplyFillが無くても
      // fillIdが実際に効いているケースが大半のため、applyFill=0を明示していない限り適用する）
      const applyFillExplicit = xf.getAttribute("applyFill");
      const fillRgb = applyFillExplicit === "0" ? null : (fillRgbs[fillId ? Number(fillId) : 0] ?? null);
      const fontDef = fontDefs[fontId ? Number(fontId) : 0];

      // 配置: <alignment horizontal="center" vertical="center" wrapText="1"/>
      const alignEl = Array.from(xf.children).find((el) => el.tagName === "alignment");
      let align: CellAlign | null = null;
      if (alignEl) {
        const h = alignEl.getAttribute("horizontal");
        const v = alignEl.getAttribute("vertical");
        const wrap = alignEl.getAttribute("wrapText");
        const shrink = alignEl.getAttribute("shrinkToFit");
        const rotAttr = Number(alignEl.getAttribute("textRotation") ?? "0");
        // 1〜90は反時計回り、91〜180は時計回り(角度=値-90。例: 135→-45)、255は縦書き(文字を縦に積む)
        const textRotation = rotAttr === 255 ? 255 : rotAttr >= 91 && rotAttr <= 180 ? -(rotAttr - 90) : rotAttr >= 0 && rotAttr <= 90 ? rotAttr : 0;
        align = {
          // centerContinuous(選択範囲内で中央)は、右隣の空きセルにまたがって中央に寄せる(描画側で処理)。
          // fill/justify等は今回は再現せず、既定(null)として扱う。
          horizontal:
            h === "center" || h === "centerContinuous"
              ? "center"
              : h === "right"
                ? "right"
                : h === "left"
                  ? "left"
                  : h === "distributed"
                    ? "distributed"
                    : null,
          vertical: v === "center" ? "center" : v === "top" ? "top" : v === "bottom" ? "bottom" : null,
          wrapText: wrap === "1" || wrap === "true",
          shrinkToFit: shrink === "1" || shrink === "true",
          indent: Number(alignEl.getAttribute("indent") ?? "0") || 0,
          textRotation,
          centerContinuous: h === "centerContinuous",
        };
      }

      // 数値書式が日付・時刻か
      const numFmtIdAttr = xf.getAttribute("numFmtId");
      let dateFormatCode: string | null = null;
      let numFormatCode: string | null = null;
      if (numFmtIdAttr !== null) {
        const numFmtId = Number(numFmtIdAttr);
        const code = customNumFmts.get(numFmtId) ?? BUILTIN_DATE_FORMATS[numFmtId] ?? BUILTIN_NUMBER_FORMATS[numFmtId] ?? null;
        if (code && isDateFormatCode(code)) dateFormatCode = code;
        else if (code && code !== "General" && code !== "@") numFormatCode = code;
      }

      const extras: CellFontExtras = {};
      if (isSerifFontName(fontDef?.name)) extras.serif = true;
      else if (isSerifFontName(fontDefs[0]?.name)) extras.serif = false; // 既定が明朝のブックで、明朝ではないフォントを指定したセル
      if (fontDef?.italic) extras.italic = true;
      if (fontDef?.underline) extras.underline = fontDef.underline;
      if (fontDef?.strike) extras.strike = true;
      if (fontDef?.vertAlign) extras.vertAlign = fontDef.vertAlign;

      result.push({
        border,
        fillRgb,
        fontRgb: fontDef?.rgb ?? null,
        bold: fontDef?.bold ?? false,
        fontSizePt: fontDef?.sizePt ?? null,
        align,
        dateFormatCode,
        numFormatCode,
        fontExtras: Object.keys(extras).length > 0 ? extras : null,
      });
    }
  }
  return {
    cellStyles: result,
    dxfs: parseDxfs(doc, ctx),
    defaultFontName: fontDefs[0]?.name ?? null,
    defaultFontSizePt: fontDefs[0]?.sizePt ?? null,
    colorCtx: ctx,
  };
}

/** リッチテキストの1区間(<r>)の書式(<rPr>)。指定が無い項目はnull(セルの書式を使う) */
function parseRunProps(rPr: Element | undefined, ctx: ColorCtx): Omit<RichRun, "text"> {
  const has = (tag: string): boolean | null => {
    const el = rPr?.getElementsByTagName(tag)[0];
    if (!el) return null;
    return el.getAttribute("val") !== "0" && el.getAttribute("val") !== "false";
  };
  const uEl = rPr?.getElementsByTagName("u")[0];
  const uVal = uEl ? (uEl.getAttribute("val") ?? "single") : null;
  const vert = rPr?.getElementsByTagName("vertAlign")[0]?.getAttribute("val") ?? null;
  const sz = rPr?.getElementsByTagName("sz")[0]?.getAttribute("val");
  const rFont = rPr?.getElementsByTagName("rFont")[0]?.getAttribute("val") ?? null;
  return {
    fontSizePt: sz && Number(sz) > 0 ? Number(sz) : null,
    bold: has("b"),
    italic: has("i"),
    underline: uVal === null || uVal === "none" ? null : uVal === "double" || uVal === "doubleAccounting" ? "double" : "single",
    strike: has("strike"),
    color: readColorEl(rPr?.getElementsByTagName("color")[0], ctx),
    serif: rFont ? isSerifFontName(rFont) : null,
    vertAlign: vert === "superscript" ? "super" : vert === "subscript" ? "sub" : null,
  };
}

/**
 * <si>(共有文字列)または<is>(インライン文字列)が、書式の違う複数の区間(<r>)で
 * 構成されていればその区間の配列を返す。単純な文字列(<t>のみ)ならnull。
 * ふりがな(<rPh>)のテキストは表示されないため含めない。
 */
function parseRichRuns(si: Element, ctx: ColorCtx): RichRun[] | null {
  const runEls = Array.from(si.children).filter((el) => el.tagName === "r");
  if (runEls.length === 0) return null;
  const runs: RichRun[] = [];
  for (const r of runEls) {
    const text = Array.from(r.children)
      .filter((el) => el.tagName === "t")
      .map((el) => el.textContent ?? "")
      .join("");
    const rPr = Array.from(r.children).find((el) => el.tagName === "rPr");
    runs.push({ text, ...parseRunProps(rPr, ctx) });
  }
  return runs;
}

/** 1つのワークシートXML(sheetN.xml)から、そのシートの印刷関連情報を読み取る */
function parseSheetXml(
  sheetXmlText: string,
  parsedStyles: ParsedStyles,
  mdw: number,
  sharedRich: (RichRun[] | null)[]
): Partial<SheetPageSettings> {
  const doc = parseXml(sheetXmlText);
  if (!doc) return {};
  const result: Partial<SheetPageSettings> = {};
  const { cellStyles } = parsedStyles;
  result.defaultFontSizePt = parsedStyles.defaultFontSizePt;
  result.defaultFontSerif = isSerifFontName(parsedStyles.defaultFontName);

  // sheetPr/pageSetUpPr@fitToPage
  const pageSetUpPr = doc.getElementsByTagName("pageSetUpPr")[0];
  result.fitToPageEnabled = pageSetUpPr?.getAttribute("fitToPage") === "1";

  // sheetFormatPr@defaultRowHeight（明示的なht指定の無い行の実際の高さ）
  const sheetFormatPr = doc.getElementsByTagName("sheetFormatPr")[0];
  const defaultRowHeightAttr = sheetFormatPr?.getAttribute("defaultRowHeight") ?? null;
  result.defaultRowHeightPt = defaultRowHeightAttr !== null ? Number(defaultRowHeightAttr) : null;
  // 既定の列幅: defaultColWidth(文字数。パディング込み)があればそれ、無ければbaseColWidth(既定8文字)から求める
  const defColWidthAttr = sheetFormatPr?.getAttribute("defaultColWidth") ?? null;
  const baseColWidthAttr = sheetFormatPr?.getAttribute("baseColWidth") ?? null;
  if (defColWidthAttr !== null && Number(defColWidthAttr) > 0) {
    result.defaultColumnWidthPt = excelColumnWidthToPt(Number(defColWidthAttr), mdw);
  } else {
    const base = baseColWidthAttr !== null ? Number(baseColWidthAttr) : 8;
    // Excelは「標準の列幅」を、(基準の文字数×半角数字の幅＋余白5px)を8ピクセルの倍数に切り上げた幅にする。
    // Calibri等(MDW=7px): 8×7+5=61 → 64px(8.43文字)、日本語Excelの既定フォント(MDW=8px相当):
    // 8×8+5=69 → 72px(8.38文字)。切り上げずに61px・約63px等で描くと、列が5〜15%せまくなり、
    // ふつうに収まるはずの見出しが欠けたり、ページの分かれ方がExcelとずれたりする。
    const defaultMdw = mdw >= 7.2 ? 8 : mdw;
    const defaultPx = Math.ceil((base * defaultMdw + 5) / 8) * 8;
    result.defaultColumnWidthPt = defaultPx * 0.75;
  }

  // pageSetup
  const pageSetup = doc.getElementsByTagName("pageSetup")[0];
  if (pageSetup) {
    const paperSizeAttr = pageSetup.getAttribute("paperSize");
    result.paperSize = paperSizeAttr ? (PAPER_SIZE_MAP[Number(paperSizeAttr)] ?? null) : null;
    result.paperSizeCode = paperSizeAttr ? Number(paperSizeAttr) : null;
    result.blackAndWhite = pageSetup.getAttribute("blackAndWhite") === "1" || pageSetup.getAttribute("blackAndWhite") === "true";
    const orientationAttr = pageSetup.getAttribute("orientation");
    result.orientation = orientationAttr === "landscape" || orientationAttr === "portrait" ? orientationAttr : null;
    const fitToWidthAttr = pageSetup.getAttribute("fitToWidth");
    const fitToHeightAttr = pageSetup.getAttribute("fitToHeight");
    // OOXML(ECMA-376 §18.3.1.63 pageSetup)の既定値：fitToWidth/fitToHeightは
    // どちらも省略時は1。Excelは値が既定値(1)のとき属性自体を書き出さないことが
    // 多く、実際に「ページ設定→拡大縮小印刷→次のページ数に合わせて印刷：横1×縦任意」
    // で保存したファイルでも、<pageSetup>にfitToHeightだけが明示され(自動=0)、
    // fitToWidthは省略されたまま、ということが普通に起こる。
    // これを「情報取得不可（=呼び出し側が無制限として扱う）」のnullにしてしまうと、
    // fitToPageEnabled=trueなのに横方向だけ無制限と誤認し、本来1ページ幅に
    // 収まるはずの表が複数の「列ページ群」に分割されてしまう
    // （実際にこの不具合でExcel→PDF変換の列ズレが発生した。属性が存在しない
    // 場合は仕様どおり1を既定値として補う。<pageSetup>要素自体が存在しない
    // 場合は、この関数のifブロックに入らずemptySheetSettings()のnullのままになる
    // ので、「本当に情報が取れない」ケースとは区別される）。
    result.fitToWidth = fitToWidthAttr !== null ? Number(fitToWidthAttr) : 1;
    result.fitToHeight = fitToHeightAttr !== null ? Number(fitToHeightAttr) : 1;
    const scaleAttr = pageSetup.getAttribute("scale");
    result.scalePercent = scaleAttr !== null ? Number(scaleAttr) : null;
  }

  // printOptions(ページ内での中央配置)
  const printOptions = doc.getElementsByTagName("printOptions")[0];
  result.horizontalCentered = printOptions?.getAttribute("horizontalCentered") === "1";
  result.verticalCentered = printOptions?.getAttribute("verticalCentered") === "1";
  result.printGridLines = printOptions?.getAttribute("gridLines") === "1";

  // pageMargins
  const pageMargins = doc.getElementsByTagName("pageMargins")[0];
  if (pageMargins) {
    const num = (name: string, fallback: number) => {
      const v = pageMargins.getAttribute(name);
      return v !== null ? Number(v) : fallback;
    };
    result.margins = {
      top: num("top", 0.75),
      bottom: num("bottom", 0.75),
      left: num("left", 0.7),
      right: num("right", 0.7),
      header: num("header", 0.3),
      footer: num("footer", 0.3),
    };
  }

  // 非表示の行・列、行の高さ、セル罫線
  const hiddenRows = new Set<number>();
  const hiddenCols = new Set<number>();
  const columnWidthsPt = new Map<number, number>();
  const rowHeightsPt = new Map<number, number>();
  const cellBorders = new Map<string, BorderDef>();
  const cellBorderStyles = new Map<string, CellBorderStyles>();
  const cellFills = new Map<string, string>();
  const cellFontColors = new Map<string, string>();
  const cellBold = new Map<string, boolean>();
  const cellAlign = new Map<string, CellAlign>();
  const cellFontSizePt = new Map<string, number>();
  const cellDiagonals = new Map<string, { up?: BorderSideStyle; down?: BorderSideStyle }>();
  const cellFontExtras = new Map<string, CellFontExtras>();
  const cellRich = new Map<string, RichRun[]>();
  const cellDateFormat = new Map<string, string>();
  const cellNumFormat = new Map<string, string>();

  const colsEl = doc.getElementsByTagName("cols")[0];
  if (colsEl) {
    for (const col of Array.from(colsEl.getElementsByTagName("col"))) {
      const min = Number(col.getAttribute("min") ?? "0");
      const max = Number(col.getAttribute("max") ?? String(min));
      const hidden = col.getAttribute("hidden") === "1";
      const width = col.getAttribute("width");
      for (let c = min; c <= max && c <= min + 1000; c++) {
        if (hidden) hiddenCols.add(c - 1);
        if (width) columnWidthsPt.set(c - 1, excelColumnWidthToPt(Number(width), mdw));
      }
    }
  }

  const sheetData = doc.getElementsByTagName("sheetData")[0];
  if (sheetData) {
    for (const rowEl of Array.from(sheetData.getElementsByTagName("row"))) {
      const rowNumAttr = rowEl.getAttribute("r");
      if (!rowNumAttr) continue;
      const rowIndex = Number(rowNumAttr) - 1;
      if (rowEl.getAttribute("hidden") === "1") hiddenRows.add(rowIndex);
      const ht = rowEl.getAttribute("ht");
      if (ht) rowHeightsPt.set(rowIndex, Number(ht));

      for (const cellEl of Array.from(rowEl.getElementsByTagName("c"))) {
        const ref = cellEl.getAttribute("r");
        const sAttr = cellEl.getAttribute("s");
        if (!ref) continue;
        const parsed = parseCellRef(ref);
        if (!parsed) continue;
        const key = `${parsed.row}:${parsed.col}`;
        // セル内の部分的な書式(リッチテキスト)。スタイル番号(s)が無いセルにも付くため、先に読む。
        const cellType = cellEl.getAttribute("t");
        if (cellType === "s") {
          const idx = Number(cellEl.getElementsByTagName("v")[0]?.textContent ?? "-1");
          const runs = sharedRich[idx];
          if (runs) cellRich.set(key, runs);
        } else if (cellType === "inlineStr") {
          const isEl = cellEl.getElementsByTagName("is")[0];
          const runs = isEl ? parseRichRuns(isEl, parsedStyles.colorCtx) : null;
          if (runs) cellRich.set(key, runs);
        }
        if (!sAttr) continue;
        const style = cellStyles[Number(sAttr)];
        if (!style) continue;
        const { border } = style;
        if (border.top || border.bottom || border.left || border.right) {
          cellBorders.set(key, border);
          if (border.styles) cellBorderStyles.set(key, border.styles);
        }
        if (style.fillRgb) cellFills.set(key, style.fillRgb);
        if (style.fontRgb) cellFontColors.set(key, style.fontRgb);
        if (style.bold) cellBold.set(key, true);
        if (style.align) cellAlign.set(key, style.align);
        if (style.fontSizePt) cellFontSizePt.set(key, style.fontSizePt);
        if (style.fontExtras) cellFontExtras.set(key, style.fontExtras);
        if (border.diagonalUp || border.diagonalDown) cellDiagonals.set(key, { up: border.diagonalUp, down: border.diagonalDown });
        if (style.dateFormatCode) cellDateFormat.set(key, style.dateFormatCode);
        if (style.numFormatCode) cellNumFormat.set(key, style.numFormatCode);
      }
    }
  }

  result.hiddenRows = hiddenRows;
  result.hiddenCols = hiddenCols;
  result.columnWidthsPt = columnWidthsPt;
  result.rowHeightsPt = rowHeightsPt;
  result.cellBorders = cellBorders;
  result.cellBorderStyles = cellBorderStyles;
  result.cellFills = cellFills;
  result.cellFontColors = cellFontColors;
  result.cellBold = cellBold;
  result.cellAlign = cellAlign;
  result.cellFontSizePt = cellFontSizePt;
  result.cellDiagonals = cellDiagonals;
  result.cellFontExtras = cellFontExtras;
  result.cellRich = cellRich;
  result.cellDateFormat = cellDateFormat;
  result.cellNumFormat = cellNumFormat;

  // 結合セル: <mergeCells><mergeCell ref="A1:J1"/>
  const merges: CellRangeRef[] = [];
  for (const mc of Array.from(doc.getElementsByTagName("mergeCell"))) {
    const ref = mc.getAttribute("ref");
    const range = ref ? parsePrintAreaRef(ref) : null;
    if (range && (range.endRow > range.startRow || range.endCol > range.startCol)) merges.push(range);
  }
  result.merges = merges;

  // 条件付き書式: <conditionalFormatting sqref="B7:C99"><cfRule type="expression" dxfId="21" priority="1"><formula>$V7=1</formula>
  const conditionalRules: ConditionalRule[] = [];
  for (const cfEl of Array.from(doc.getElementsByTagName("conditionalFormatting"))) {
    const ranges = (cfEl.getAttribute("sqref") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => parsePrintAreaRef(part))
      .filter((r): r is CellRangeRef => r !== null);
    if (ranges.length === 0) continue;
    const base = baseCellOf(ranges);
    for (const ruleEl of Array.from(cfEl.getElementsByTagName("cfRule"))) {
      const typeAttr = ruleEl.getAttribute("type") ?? "";
      const dxfIdAttr = ruleEl.getAttribute("dxfId");
      const dxf = dxfIdAttr !== null ? (parsedStyles.dxfs[Number(dxfIdAttr)] ?? null) : null;
      const simpleTypes = [
        "expression",
        "cellIs",
        "containsText",
        "notContainsText",
        "beginsWith",
        "endsWith",
        "containsBlanks",
        "notContainsBlanks",
        "duplicateValues",
        "uniqueValues",
        "top10",
        "aboveAverage",
      ] as const;
      type RuleType = ConditionalRule["type"];
      let type: RuleType = (simpleTypes as readonly string[]).includes(typeAttr) ? (typeAttr as RuleType) : "unsupported";
      const rule: ConditionalRule = {
        type,
        ranges,
        baseRow: base.row,
        baseCol: base.col,
        formulas: Array.from(ruleEl.getElementsByTagName("formula")).map((f) => f.textContent ?? ""),
        operator: ruleEl.getAttribute("operator"),
        text: ruleEl.getAttribute("text"),
        priority: Number(ruleEl.getAttribute("priority") ?? "0"),
        stopIfTrue: ruleEl.getAttribute("stopIfTrue") === "1",
        dxf,
        rank: ruleEl.getAttribute("rank") !== null ? Number(ruleEl.getAttribute("rank")) : undefined,
        percent: ruleEl.getAttribute("percent") === "1",
        bottom: ruleEl.getAttribute("bottom") === "1",
        aboveAverage: ruleEl.getAttribute("aboveAverage") !== "0",
        equalAverage: ruleEl.getAttribute("equalAverage") === "1",
      };
      // 色スケール・データバー
      const cfvoOf = (el: Element) =>
        Array.from(el.getElementsByTagName("cfvo")).map((v) => ({
          type: v.getAttribute("type") ?? "",
          val: v.getAttribute("val") !== null && Number.isFinite(Number(v.getAttribute("val"))) ? Number(v.getAttribute("val")) : null,
        }));
      const scaleEl = ruleEl.getElementsByTagName("colorScale")[0];
      const barEl = ruleEl.getElementsByTagName("dataBar")[0];
      if (typeAttr === "colorScale" && scaleEl) {
        const colors = Array.from(scaleEl.getElementsByTagName("color")).map((c) => readColorEl(c, parsedStyles.colorCtx));
        if (colors.every((c) => c !== null)) {
          rule.type = "colorScale";
          rule.colorScale = { points: cfvoOf(scaleEl), colors: colors as string[] };
        }
      } else if (typeAttr === "dataBar" && barEl) {
        const cfvos = cfvoOf(barEl);
        const color = readColorEl(barEl.getElementsByTagName("color")[0], parsedStyles.colorCtx);
        if (cfvos.length >= 2 && color) {
          rule.type = "dataBar";
          rule.dataBar = { min: cfvos[0], max: cfvos[1], color };
        }
      }
      type = rule.type;
      void type;
      conditionalRules.push(rule);
    }
  }
  result.conditionalRules = conditionalRules;

  // 明示的な改ページ（手動のみ。man="1"）
  const rowBreaksAfter: number[] = [];
  const rowBreaksEl = doc.getElementsByTagName("rowBreaks")[0];
  if (rowBreaksEl) {
    for (const brk of Array.from(rowBreaksEl.getElementsByTagName("brk"))) {
      const id = brk.getAttribute("id");
      if (id) rowBreaksAfter.push(Number(id) - 1); // idは「区切りが入る行番号(1始まり)」＝その行の後で改ページ
    }
  }
  const colBreaksAfter: number[] = [];
  const colBreaksEl = doc.getElementsByTagName("colBreaks")[0];
  if (colBreaksEl) {
    for (const brk of Array.from(colBreaksEl.getElementsByTagName("brk"))) {
      const id = brk.getAttribute("id");
      if (id) colBreaksAfter.push(Number(id) - 1);
    }
  }
  result.rowBreaksAfter = rowBreaksAfter;
  result.colBreaksAfter = colBreaksAfter;

  // ヘッダー/フッター(B-9・B-10): oddHeader/oddFooterが存在し、かつ空文字でない
  // 場合のみ値を持たせる(Excel側で何も設定していない場合にnullのままにすることで、
  // 呼び出し側が「設定が無ければ何も描画しない」を機械的に判定できるようにする)。
  const headerFooterEl = doc.getElementsByTagName("headerFooter")[0];
  if (headerFooterEl) {
    const pick = (tag: string): HeaderFooterSections | null => {
      const text = headerFooterEl.getElementsByTagName(tag)[0]?.textContent ?? "";
      return text.trim() !== "" ? parseHeaderFooterSections(text) : null;
    };
    result.header = pick("oddHeader");
    result.footer = pick("oddFooter");
    result.differentFirst = headerFooterEl.getAttribute("differentFirst") === "1";
    result.differentOddEven = headerFooterEl.getAttribute("differentOddEven") === "1";
    result.firstHeader = pick("firstHeader");
    result.firstFooter = pick("firstFooter");
    result.evenHeader = pick("evenHeader");
    result.evenFooter = pick("evenFooter");
  }

  return result;
}

/**
 * 列幅(文字単位)の値の集まりから、そのファイルを作ったExcelのMDW(半角数字1文字の幅px)を推定する。
 * Excelは列幅を「ピクセル数÷MDW」で保存するため、MDW=8のファイルの列幅は1/8の倍数
 * (7.875・4.25・10.375など)、MDW=7のファイルは1/7の倍数になる。複数の列幅がちょうど
 * 1つの候補だけで割り切れるときに限り、その値を採用する(整数の列幅だけの場合など、
 * どの候補でも割り切れるときは判定せずnull=フォントからの推定に任せる)。
 */
export function inferMaximumDigitWidth(widths: number[]): number | null {
  const distinct = Array.from(new Set(widths.filter((w) => w > 0).map((w) => Math.round(w * 1000) / 1000)));
  if (distinct.length < 2) return null;
  const candidates = [7, 8, 9];
  const ok = candidates.filter((m) => distinct.every((w) => Math.abs(w * m - Math.round(w * m)) < 0.025));
  return ok.length === 1 ? ok[0] : null;
}

/** 引用符('...')の外側のカンマで分割する(シート名にカンマが含まれる場合の対策) */
function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of text) {
    if (ch === "'") inQuote = !inQuote;
    if (ch === "," && !inQuote) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** 印刷範囲(複数あれば全部)。例: 'Sheet1'!$A$1:$C$5,'Sheet1'!$E$1:$G$5 */
function parsePrintAreaRefs(defined: string): CellRangeRef[] {
  return splitOutsideQuotes(defined)
    .map((part) => parsePrintAreaRef(part))
    .filter((r): r is CellRangeRef => r !== null);
}

/** 印刷タイトル。例: 'Sheet1'!$A:$B,'Sheet1'!$1:$3(列と行はどちらが先でもよい) */
function parsePrintTitles(defined: string): { rows: { start: number; end: number } | null; cols: { start: number; end: number } | null } {
  let rows: { start: number; end: number } | null = null;
  let cols: { start: number; end: number } | null = null;
  for (const part of splitOutsideQuotes(defined)) {
    const range = (part.split("!").pop() ?? "").replace(/\$/g, "");
    const rowMatch = /^(\d+):(\d+)$/.exec(range);
    const colMatch = /^([A-Z]+):([A-Z]+)$/.exec(range);
    if (rowMatch) rows = { start: Number(rowMatch[1]) - 1, end: Number(rowMatch[2]) - 1 };
    else if (colMatch) {
      const toIdx = (letters: string) => parseCellRef(`${letters}1`)?.col ?? 0;
      cols = { start: toIdx(colMatch[1]), end: toIdx(colMatch[2]) };
    }
  }
  return { rows, cols };
}

/** 非表示のシート(状態がhidden・veryHidden)の名前。印刷対象の初期選択から外すために使う */
export async function readHiddenSheetNames(file: File): Promise<Set<string>> {
  const hidden = new Set<string>();
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (info) => info.name === "xl/workbook.xml" });
    const text = await readEntryText(entries, "xl/workbook.xml");
    const doc = text ? parseXml(text) : null;
    if (!doc) return hidden;
    for (const el of Array.from(doc.getElementsByTagName("sheet"))) {
      const state = el.getAttribute("state");
      const name = el.getAttribute("name");
      if (name && (state === "hidden" || state === "veryHidden")) hidden.add(name);
    }
  } catch {
    // 読めなければ「非表示なし」として扱う
  }
  return hidden;
}

/**
 * XLSXファイル全体から、シート名 → 印刷設定 のMapを取得する。
 * 取得に失敗した場合（対応していない形式・壊れたファイル等）は空のMapを返す
 * （呼び出し側は「情報が取れなかった」として既存のフォールバックへ進む）。
 */
export async function parseWorkbookPageSettings(file: File): Promise<Map<string, SheetPageSettings>> {
  const result = new Map<string, SheetPageSettings>();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = unzipSync(bytes, {
      filter: (info) =>
        /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|theme\/theme1\.xml|worksheets\/.*\.(xml|rels)|drawings\/.*|media\/.*)$/.test(
          info.name
        ),
    });

    const workbookXmlText = await readEntryText(entries, "xl/workbook.xml");
    const relsXmlText = await readEntryText(entries, "xl/_rels/workbook.xml.rels");
    const stylesXmlText = await readEntryText(entries, "xl/styles.xml");
    const themeXmlText = await readEntryText(entries, "xl/theme/theme1.xml");
    if (!workbookXmlText || !relsXmlText) return result;

    const workbookDoc = parseXml(workbookXmlText);
    const relsDoc = parseXml(relsXmlText);
    if (!workbookDoc || !relsDoc) return result;

    // r:id → 実際のファイルパス(xl/からの相対)
    const ridToTarget = new Map<string, string>();
    for (const rel of Array.from(relsDoc.getElementsByTagName("Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      // Target が "/xl/worksheets/sheet1.xml" のように先頭が「/」の場合は、ファイル全体(パッケージ)の
      // ルートからの絶対パス(openpyxl等の一部のソフトがこの形式で書き出す)。Excel本体が書き出す
      // "worksheets/sheet1.xml" のような相対パスと区別して、最終的に「xl/」からの相対へそろえる。
      if (id && target) {
        const normalized = target.startsWith("/") ? target.replace(/^\/xl\//, "").replace(/^\//, "") : target.replace(/^\.\//, "");
        ridToTarget.set(id, normalized);
      }
    }

    // シート名の並び順(workbook.xmlの<sheets>順)。definedNamesのlocalSheetIdはこの順序のインデックス。
    const sheetEls = Array.from(workbookDoc.getElementsByTagName("sheet"));
    const sheetNamesInOrder: string[] = [];
    const nameToTarget = new Map<string, string>();
    for (const sheetEl of sheetEls) {
      const name = sheetEl.getAttribute("name");
      // r:id属性はXML名前空間つき("r:id")のため、getAttributeでは取得できない場合がありgetAttributeNS等が必要になりうるが、
      // 多くの実装（Excel本体・Google Sheets等）が名前空間prefixをそのまま"r:id"として書き出すため、まず素朴に取得を試みる。
      const rId = sheetEl.getAttribute("r:id") ?? sheetEl.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      if (!name || !rId) continue;
      sheetNamesInOrder.push(name);
      const target = ridToTarget.get(rId);
      if (target) nameToTarget.set(name, `xl/${target}`);
    }

    // definedNames: _xlnm.Print_Area(複数範囲に対応)・_xlnm.Print_Titles
    const printAreasBySheetIndex = new Map<number, CellRangeRef[]>();
    const printTitlesBySheetIndex = new Map<number, ReturnType<typeof parsePrintTitles>>();
    const definedNamesEl = workbookDoc.getElementsByTagName("definedNames")[0];
    if (definedNamesEl) {
      for (const dn of Array.from(definedNamesEl.getElementsByTagName("definedName"))) {
        const dnName = dn.getAttribute("name");
        const localSheetIdAttr = dn.getAttribute("localSheetId");
        if (localSheetIdAttr === null) continue;
        if (dnName === "_xlnm.Print_Area") {
          const ranges = parsePrintAreaRefs(dn.textContent ?? "");
          if (ranges.length > 0) printAreasBySheetIndex.set(Number(localSheetIdAttr), ranges);
        } else if (dnName === "_xlnm.Print_Titles") {
          printTitlesBySheetIndex.set(Number(localSheetIdAttr), parsePrintTitles(dn.textContent ?? ""));
        }
      }
    }

    const themeColors = parseThemeColors(themeXmlText);

    // シートXMLを先にすべて読み、列幅の傾向から、このファイルのMDW(半角数字の幅)を推定する
    const sheetXmlByName = new Map<string, string>();
    const allWidths: number[] = [];
    for (const name of sheetNamesInOrder) {
      const target = nameToTarget.get(name);
      if (!target) continue;
      const sheetXmlText = await readEntryText(entries, target);
      if (!sheetXmlText) continue;
      sheetXmlByName.set(name, sheetXmlText);
      for (const m of sheetXmlText.matchAll(/<col\b[^>]*?\bwidth="([\d.]+)"/g)) allWidths.push(Number(m[1]));
      const dcw = /<sheetFormatPr\b[^>]*?\bdefaultColWidth="([\d.]+)"/.exec(sheetXmlText);
      if (dcw) allWidths.push(Number(dcw[1]));
    }
    const mdw = inferMaximumDigitWidth(allWidths) ?? resolveMaximumDigitWidth(stylesXmlText);

    const parsedStyles = parseCellStyles(stylesXmlText, themeColors);

    // 共有文字列のうち、書式の違う区間を持つもの(リッチテキスト)。インデックスは<si>の出現順。
    const sharedRich: (RichRun[] | null)[] = [];
    const sharedXmlText = await readEntryText(entries, "xl/sharedStrings.xml");
    const sharedDoc = sharedXmlText && sharedXmlText.includes("<r>") ? parseXml(sharedXmlText) : null;
    if (sharedDoc) {
      for (const si of Array.from(sharedDoc.documentElement.children)) {
        sharedRich.push(si.localName === "si" ? parseRichRuns(si, parsedStyles.colorCtx) : null);
      }
    }

    for (let i = 0; i < sheetNamesInOrder.length; i++) {
      const name = sheetNamesInOrder[i];
      const sheetXmlText = sheetXmlByName.get(name);
      if (!sheetXmlText) continue;

      const parsed = parseSheetXml(sheetXmlText, parsedStyles, mdw, sharedRich);
      const settings: SheetPageSettings = { ...emptySheetSettings(), ...parsed };
      const areas = printAreasBySheetIndex.get(i) ?? [];
      settings.printAreas = areas;
      settings.printArea = areas[0] ?? null;
      const titles = printTitlesBySheetIndex.get(i);
      settings.printTitleRows = titles?.rows ?? null;
      settings.printTitleCols = titles?.cols ?? null;

      // 図・画像・図形
      const target = nameToTarget.get(name);
      if (target) {
        const drawings = parseSheetDrawings(entries, target, themeColors);
        settings.pictures = drawings.pictures;
        settings.shapes = drawings.shapes;
        settings.unsupportedDrawingCount = drawings.unsupportedCount;
        settings.otherImages = drawings.otherImages;
      }
      result.set(name, settings);
    }
  } catch {
    // 解析に失敗しても例外は投げず、空のMap（=フォールバック挙動）を返す
    return new Map();
  }
  return result;
}
