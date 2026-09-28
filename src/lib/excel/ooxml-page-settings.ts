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

/** styles.xml の <borders> と <cellXfs> から、style index(s) → 罫線有無 の対応表を作る */
function parseBorderStyles(stylesXmlText: string | null): BorderDef[] {
  if (!stylesXmlText) return [];
  const doc = parseXml(stylesXmlText);
  if (!doc) return [];

  const borderDefs: BorderDef[] = [];
  const bordersEl = doc.getElementsByTagName("borders")[0];
  if (bordersEl) {
    const borderEls = Array.from(bordersEl.getElementsByTagName("border"));
    for (const b of borderEls) {
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

  // cellXfs の各xf要素が持つborderId(0始まり、bordersリストのインデックス)から、
  // style index(s、セル側が参照する番号=cellXfs内でのxf要素の出現順)→BorderDefの対応表を作る
  const cellXfsEl = doc.getElementsByTagName("cellXfs")[0];
  const result: BorderDef[] = [];
  if (cellXfsEl) {
    const xfEls = Array.from(cellXfsEl.children).filter((el) => el.tagName === "xf");
    for (const xf of xfEls) {
      const borderId = xf.getAttribute("borderId");
      const idx = borderId ? Number(borderId) : 0;
      result.push(borderDefs[idx] ?? { top: false, bottom: false, left: false, right: false });
    }
  }
  return result;
}

/** 1つのワークシートXML(sheetN.xml)から、そのシートの印刷関連情報を読み取る */
function parseSheetXml(sheetXmlText: string, styleBorders: BorderDef[]): Partial<SheetPageSettings> {
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
        const border = styleBorders[Number(sAttr)];
        if (border && (border.top || border.bottom || border.left || border.right)) {
          cellBorders.set(`${parsed.row}:${parsed.col}`, border);
        }
      }
    }
  }

  result.hiddenRows = hiddenRows;
  result.hiddenCols = hiddenCols;
  result.columnWidthsPt = columnWidthsPt;
  result.rowHeightsPt = rowHeightsPt;
  result.cellBorders = cellBorders;

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

    const styleBorders = parseBorderStyles(stylesXmlText);

    for (let i = 0; i < sheetNamesInOrder.length; i++) {
      const name = sheetNamesInOrder[i];
      const target = nameToTarget.get(name);
      if (!target) continue;
      const sheetXmlText = await readEntryText(entries, target);
      if (!sheetXmlText) continue;

      const parsed = parseSheetXml(sheetXmlText, styleBorders);
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
