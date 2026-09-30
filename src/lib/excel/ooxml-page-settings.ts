import { unzipSync } from "fflate";

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
  5: "Legal",
  8: "A3",
  9: "A4",
  11: "A5",
};

export interface SheetPageSettings {
  printArea: CellRangeRef | null;
  paperSize: string | null;
  orientation: "portrait" | "landscape" | null;
  /** sheetPr/pageSetUpPr@fitToPage が true のとき、fitToWidth/fitToHeightを優先する */
  fitToPageEnabled: boolean;
  /** 0 = 制限なし（列/行方向は内容量に任せる）、null = 情報取得不可 */
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
  /** 明示的な改ページの直前の行番号（0始まり。「この行の後で改ページ」の意味） */
  rowBreaksAfter: number[];
  colBreaksAfter: number[];
  /** key: "row:col"(0始まり)。値: その辺に実際に罫線が設定されているか */
  cellBorders: Map<string, { top: boolean; bottom: boolean; left: boolean; right: boolean }>;
  /**
   * セルの背景色・文字色・太字（開発指示書§29-31「Excelの色がPDFに反映されない」対応）。
   * 取得できる／実際に指定されている場合のみキーを持つ（既定色・塗りつぶしなしのセルは
   * 記録しない。cellBordersと同じ「差分だけを持つ」方針で、巨大シートでのMapサイズを
   * 抑える）。値は"#RRGGBB"形式。indexed color・theme colorは今回のバージョンでは
   * 対応しない（rgb属性で明示的に指定された色のみ。取得できなかった色は無理に
   * 再現しない方針を踏襲）。
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
}

export interface HeaderFooterSections {
  left: string;
  center: string;
  right: string;
}

function emptySheetSettings(): SheetPageSettings {
  return {
    printArea: null,
    paperSize: null,
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
    rowBreaksAfter: [],
    colBreaksAfter: [],
    cellBorders: new Map(),
    cellFills: new Map(),
    cellFontColors: new Map(),
    cellBold: new Map(),
    header: null,
    footer: null,
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

/** Excelの列幅（文字単位・既定フォントの最大数字幅を7pxと仮定した近似）をpt単位へ変換する */
function excelColumnWidthToPt(charWidth: number): number {
  const MDW = 7; // 既定フォント(Calibri 11等)での半角数字の最大幅(px)の一般的な近似値
  const px = Math.floor(((256 * charWidth + Math.floor(128 / MDW)) / 256) * MDW);
  return px * 0.75; // px(96dpi) → pt(72dpi)
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
}

/** resolvedスタイル1件分（cellXfsのxf要素1つに対応する、セル1スタイルぶんの情報） */
interface ResolvedCellStyle {
  border: BorderDef;
  /** "#RRGGBB"。塗りつぶしなし・indexed/theme色など解決できない場合はnull */
  fillRgb: string | null;
  fontRgb: string | null;
  bold: boolean;
}

/**
 * OOXMLの色（ARGBの8桁16進、まれに6桁もそのまま許容）を"#RRGGBB"へ変換する。
 * indexed属性・theme属性による色指定（パレット番号・テーマカラー参照）は
 * 今回のバージョンでは解決しない（テーマのxml解析まで踏み込むと対応範囲が
 * 大きく広がるため、開発指示書の「無理に再現しない」方針に沿って明示的な
 * rgb属性を持つ色のみを対象とする）。
 */
function argbToRgbHex(argb: string | null | undefined): string | null {
  if (!argb) return null;
  const hex = argb.replace(/^#/, "");
  if (hex.length === 8) return `#${hex.slice(2)}`; // AARRGGBB → RRGGBB
  if (hex.length === 6) return `#${hex}`;
  return null;
}

/** <color rgb="FFRRGGBB"/> のような要素から解決できる色（rgb属性のみ対応）を読む */
function readColorEl(colorEl: Element | undefined): string | null {
  if (!colorEl) return null;
  return argbToRgbHex(colorEl.getAttribute("rgb"));
}

/**
 * styles.xml の <fonts>/<fills>/<borders> と <cellXfs> から、
 * style index(s、セル側のs属性の値＝cellXfs内でのxf要素の出現順) → 罫線有無・
 * 背景色・文字色・太字 の対応表を作る（開発指示書§21-26・§29-31）。
 */
function parseCellStyles(stylesXmlText: string | null): ResolvedCellStyle[] {
  if (!stylesXmlText) return [];
  const doc = parseXml(stylesXmlText);
  if (!doc) return [];

  const borderDefs: BorderDef[] = [];
  const bordersEl = doc.getElementsByTagName("borders")[0];
  if (bordersEl) {
    for (const b of Array.from(bordersEl.getElementsByTagName("border"))) {
      const hasSide = (tag: string) => {
        const el = b.getElementsByTagName(tag)[0];
        // <top style="thin">...</top> のように style属性を持つ(かつ"none"でない)場合のみ罫線ありとみなす
        const style = el?.getAttribute("style");
        return Boolean(style && style !== "none");
      };
      borderDefs.push({
        top: hasSide("top"),
        bottom: hasSide("bottom"),
        left: hasSide("left"),
        right: hasSide("right"),
      });
    }
  }

  // <fills><fill><patternFill patternType="solid"><fgColor rgb="FFRRGGBB"/>...
  // patternType="solid"のときのみfgColorが実際に見える背景色になる（それ以外の
  // ハッチング等のパターン塗りつぶしは、今回は色の再現対象外とし無視する）。
  const fillRgbs: (string | null)[] = [];
  const fillsEl = doc.getElementsByTagName("fills")[0];
  if (fillsEl) {
    for (const fill of Array.from(fillsEl.getElementsByTagName("fill"))) {
      const patternFill = fill.getElementsByTagName("patternFill")[0];
      const patternType = patternFill?.getAttribute("patternType");
      if (patternType === "solid") {
        fillRgbs.push(readColorEl(patternFill?.getElementsByTagName("fgColor")[0]));
      } else {
        fillRgbs.push(null);
      }
    }
  }

  // <fonts><font><color rgb="FFRRGGBB"/><b/>...
  const fontDefs: { rgb: string | null; bold: boolean }[] = [];
  const fontsEl = doc.getElementsByTagName("fonts")[0];
  if (fontsEl) {
    for (const fontEl of Array.from(fontsEl.getElementsByTagName("font"))) {
      const rgb = readColorEl(fontEl.getElementsByTagName("color")[0]);
      const bold = fontEl.getElementsByTagName("b").length > 0;
      fontDefs.push({ rgb, bold });
    }
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
      result.push({
        border,
        fillRgb,
        fontRgb: fontDef?.rgb ?? null,
        bold: fontDef?.bold ?? false,
      });
    }
  }
  return result;
}

/** 1つのワークシートXML(sheetN.xml)から、そのシートの印刷関連情報を読み取る */
function parseSheetXml(sheetXmlText: string, cellStyles: ResolvedCellStyle[]): Partial<SheetPageSettings> {
  const doc = parseXml(sheetXmlText);
  if (!doc) return {};
  const result: Partial<SheetPageSettings> = {};

  // sheetPr/pageSetUpPr@fitToPage
  const pageSetUpPr = doc.getElementsByTagName("pageSetUpPr")[0];
  result.fitToPageEnabled = pageSetUpPr?.getAttribute("fitToPage") === "1";

  // pageSetup
  const pageSetup = doc.getElementsByTagName("pageSetup")[0];
  if (pageSetup) {
    const paperSizeAttr = pageSetup.getAttribute("paperSize");
    result.paperSize = paperSizeAttr ? (PAPER_SIZE_MAP[Number(paperSizeAttr)] ?? null) : null;
    const orientationAttr = pageSetup.getAttribute("orientation");
    result.orientation = orientationAttr === "landscape" || orientationAttr === "portrait" ? orientationAttr : null;
    const fitToWidthAttr = pageSetup.getAttribute("fitToWidth");
    const fitToHeightAttr = pageSetup.getAttribute("fitToHeight");
    result.fitToWidth = fitToWidthAttr !== null ? Number(fitToWidthAttr) : null;
    result.fitToHeight = fitToHeightAttr !== null ? Number(fitToHeightAttr) : null;
    const scaleAttr = pageSetup.getAttribute("scale");
    result.scalePercent = scaleAttr !== null ? Number(scaleAttr) : null;
  }

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
  const cellFills = new Map<string, string>();
  const cellFontColors = new Map<string, string>();
  const cellBold = new Map<string, boolean>();

  const colsEl = doc.getElementsByTagName("cols")[0];
  if (colsEl) {
    for (const col of Array.from(colsEl.getElementsByTagName("col"))) {
      const min = Number(col.getAttribute("min") ?? "0");
      const max = Number(col.getAttribute("max") ?? String(min));
      const hidden = col.getAttribute("hidden") === "1";
      const width = col.getAttribute("width");
      for (let c = min; c <= max && c <= min + 1000; c++) {
        if (hidden) hiddenCols.add(c - 1);
        if (width) columnWidthsPt.set(c - 1, excelColumnWidthToPt(Number(width)));
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
        if (!ref || !sAttr) continue;
        const parsed = parseCellRef(ref);
        if (!parsed) continue;
        const style = cellStyles[Number(sAttr)];
        if (!style) continue;
        const key = `${parsed.row}:${parsed.col}`;
        const { border } = style;
        if (border.top || border.bottom || border.left || border.right) {
          cellBorders.set(key, border);
        }
        if (style.fillRgb) cellFills.set(key, style.fillRgb);
        if (style.fontRgb) cellFontColors.set(key, style.fontRgb);
        if (style.bold) cellBold.set(key, true);
      }
    }
  }

  result.hiddenRows = hiddenRows;
  result.hiddenCols = hiddenCols;
  result.columnWidthsPt = columnWidthsPt;
  result.rowHeightsPt = rowHeightsPt;
  result.cellBorders = cellBorders;
  result.cellFills = cellFills;
  result.cellFontColors = cellFontColors;
  result.cellBold = cellBold;

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
    const oddHeaderText = headerFooterEl.getElementsByTagName("oddHeader")[0]?.textContent ?? "";
    const oddFooterText = headerFooterEl.getElementsByTagName("oddFooter")[0]?.textContent ?? "";
    if (oddHeaderText.trim() !== "") result.header = parseHeaderFooterSections(oddHeaderText);
    if (oddFooterText.trim() !== "") result.footer = parseHeaderFooterSections(oddFooterText);
  }

  return result;
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
      filter: (info) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|worksheets\/.*\.xml)$/.test(info.name),
    });

    const workbookXmlText = await readEntryText(entries, "xl/workbook.xml");
    const relsXmlText = await readEntryText(entries, "xl/_rels/workbook.xml.rels");
    const stylesXmlText = await readEntryText(entries, "xl/styles.xml");
    if (!workbookXmlText || !relsXmlText) return result;

    const workbookDoc = parseXml(workbookXmlText);
    const relsDoc = parseXml(relsXmlText);
    if (!workbookDoc || !relsDoc) return result;

    // r:id → 実際のファイルパス(xl/からの相対)
    const ridToTarget = new Map<string, string>();
    for (const rel of Array.from(relsDoc.getElementsByTagName("Relationship"))) {
      const id = rel.getAttribute("Id");
      const target = rel.getAttribute("Target");
      if (id && target) ridToTarget.set(id, target.replace(/^\.?\//, ""));
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

    // definedNames: _xlnm.Print_Area
    const printAreaBySheetIndex = new Map<number, CellRangeRef>();
    const definedNamesEl = workbookDoc.getElementsByTagName("definedNames")[0];
    if (definedNamesEl) {
      for (const dn of Array.from(definedNamesEl.getElementsByTagName("definedName"))) {
        if (dn.getAttribute("name") !== "_xlnm.Print_Area") continue;
        const localSheetIdAttr = dn.getAttribute("localSheetId");
        if (localSheetIdAttr === null) continue;
        const range = parsePrintAreaRef(dn.textContent ?? "");
        if (range) printAreaBySheetIndex.set(Number(localSheetIdAttr), range);
      }
    }

    const cellStyles = parseCellStyles(stylesXmlText);

    for (let i = 0; i < sheetNamesInOrder.length; i++) {
      const name = sheetNamesInOrder[i];
      const target = nameToTarget.get(name);
      if (!target) continue;
      const sheetXmlText = await readEntryText(entries, target);
      if (!sheetXmlText) continue;

      const parsed = parseSheetXml(sheetXmlText, cellStyles);
      const settings: SheetPageSettings = { ...emptySheetSettings(), ...parsed };
      settings.printArea = printAreaBySheetIndex.get(i) ?? null;
      result.set(name, settings);
    }
  } catch {
    // 解析に失敗しても例外は投げず、空のMap（=フォールバック挙動）を返す
    return new Map();
  }
  return result;
}
