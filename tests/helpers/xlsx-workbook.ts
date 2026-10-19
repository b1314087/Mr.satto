/**
 * XLSXの中身（シート・セル・書式・印刷設定）を、アプリの実装とは別に読み取るテスト用ヘルパー。
 * fflateでZIPを解いて、OOXMLのXMLを直接読む（新しい依存は追加しない）。
 * 年度カレンダーのExcel出力の検証（tests/calendar）で使う。
 */
import { unzipSync, strFromU8 } from "fflate";

export interface XlsxCellInfo {
  address: string;
  /** 0始まりの行・列 */
  row: number;
  col: number;
  /** 文字列セルは文字列、数値・日付セルは数値（日付はシリアル値）、空なら null */
  value: string | number | null;
  styleId: number | null;
}

export interface XlsxStyle {
  fontName: string | null;
  fontSize: number | null;
  bold: boolean;
  fontColor: string | null;
  fillColor: string | null;
  numberFormat: string | null;
  borders: { left: string | null; right: string | null; top: string | null; bottom: string | null };
  wrap: boolean;
  horizontal: string | null;
  vertical: string | null;
}

export interface XlsxSheetInfo {
  name: string;
  cells: Map<string, XlsxCellInfo>;
  rowHeights: Map<number, number>;
  /** 列幅（Excelの文字数単位）。0始まりの列 */
  columnWidths: Map<number, number>;
  merged: string[];
  pageSetup: Record<string, string>;
  pageMargins: Record<string, string>;
  horizontalCentered: boolean;
  fitToPage: boolean;
  tabColor: string | null;
  frozenRows: number;
  rawXml: string;
}

export interface XlsxWorkbookInfo {
  sheets: XlsxSheetInfo[];
  definedNames: { name: string; localSheetId: number | null; ref: string }[];
  styles: XlsxStyle[];
  defaultFont: { name: string | null; size: number | null };
  style(cell: XlsxCellInfo | undefined): XlsxStyle | null;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

export function columnIndexOf(letters: string): number {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

export function parseAddress(address: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(address);
  if (!m) throw new Error(`セル番地が正しくありません: ${address}`);
  return { row: Number(m[2]) - 1, col: columnIndexOf(m[1]) };
}

export function addressOf(row: number, col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${row + 1}`;
}

function parseStyles(xml: string): { styles: XlsxStyle[]; defaultFont: { name: string | null; size: number | null } } {
  const numFmts = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\s+([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    numFmts.set(Number(a.numFmtId), a.formatCode);
  }
  const fontsBlock = /<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)?.[1] ?? "";
  const fonts = [...fontsBlock.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => {
    const b = m[1];
    return {
      name: /<name val="([^"]*)"/.exec(b)?.[1] ?? null,
      size: /<sz val="([^"]*)"/.exec(b) ? Number(/<sz val="([^"]*)"/.exec(b)![1]) : null,
      bold: /<b\s*\/>|<b>/.test(b),
      color: /<color rgb="([0-9A-Fa-f]{8})"/.exec(b)?.[1].slice(2).toUpperCase() ?? null,
    };
  });
  const fillsBlock = /<fills[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? "";
  const fills = [...fillsBlock.matchAll(/<fill>([\s\S]*?)<\/fill>/g)].map((m) => {
    if (!/patternType="solid"/.test(m[1])) return null;
    return /<fgColor rgb="([0-9A-Fa-f]{8})"/.exec(m[1])?.[1].slice(2).toUpperCase() ?? null;
  });
  const bordersBlock = /<borders[^>]*>([\s\S]*?)<\/borders>/.exec(xml)?.[1] ?? "";
  const borders = [...bordersBlock.matchAll(/<border>([\s\S]*?)<\/border>/g)].map((m) => {
    const side = (name: string) => new RegExp(`<${name}\\s+style="([^"]+)"`).exec(m[1])?.[1] ?? null;
    return { left: side("left"), right: side("right"), top: side("top"), bottom: side("bottom") };
  });
  const xfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const styles = [...xfsBlock.matchAll(/<xf\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map((m) => {
    const a = attrs(m[1]);
    const align = m[2] ? attrs(/<alignment\s+([^>]*?)\/>/.exec(m[2])?.[1] ?? "") : {};
    const font = fonts[Number(a.fontId ?? 0)];
    const numFmtId = Number(a.numFmtId ?? 0);
    return {
      fontName: font?.name ?? null,
      fontSize: font?.size ?? null,
      bold: font?.bold ?? false,
      fontColor: font?.color ?? null,
      fillColor: fills[Number(a.fillId ?? 0)] ?? null,
      numberFormat: numFmts.get(numFmtId) ?? (numFmtId === 0 ? null : `builtin:${numFmtId}`),
      borders: borders[Number(a.borderId ?? 0)] ?? { left: null, right: null, top: null, bottom: null },
      wrap: align.wrapText === "1" || align.wrapText === "true",
      horizontal: align.horizontal ?? null,
      vertical: align.vertical ?? null,
    } satisfies XlsxStyle;
  });
  return { styles, defaultFont: { name: fonts[0]?.name ?? null, size: fonts[0]?.size ?? null } };
}

function parseSheet(name: string, xml: string, shared: string[]): XlsxSheetInfo {
  const cells = new Map<string, XlsxCellInfo>();
  const rowHeights = new Map<number, number>();
  for (const rowMatch of xml.matchAll(/<row\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rowMatch[1]);
    if (ra.ht) rowHeights.set(Number(ra.r) - 1, Number(ra.ht));
    for (const c of (rowMatch[2] ?? "").matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]);
      const { row, col } = parseAddress(a.r);
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1];
      let value: string | number | null = null;
      if (v !== undefined) value = a.t === "s" ? shared[Number(v)] : a.t === "str" ? decodeXml(v) : Number(v);
      cells.set(a.r, { address: a.r, row, col, value, styleId: a.s !== undefined ? Number(a.s) : null });
    }
  }
  const columnWidths = new Map<number, number>();
  for (const m of xml.matchAll(/<col\s+([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    for (let c = Number(a.min); c <= Number(a.max); c++) columnWidths.set(c - 1, Number(a.width));
  }
  const pane = /<pane\s+([^>]*?)\/>/.exec(xml);
  const pa = pane ? attrs(pane[1]) : {};
  return {
    name,
    cells,
    rowHeights,
    columnWidths,
    merged: [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]),
    pageSetup: attrs(/<pageSetup\s+([^>]*?)\/>/.exec(xml)?.[1] ?? ""),
    pageMargins: attrs(/<pageMargins\s+([^>]*?)\/>/.exec(xml)?.[1] ?? ""),
    horizontalCentered: /<printOptions[^>]*horizontalCentered="(1|true)"/.test(xml),
    fitToPage: /<pageSetUpPr[^>]*fitToPage="(1|true)"/.test(xml),
    tabColor: /<tabColor rgb="([0-9A-Fa-f]{8})"/.exec(xml)?.[1].slice(2).toUpperCase() ?? null,
    frozenRows: pa.state === "frozen" ? Number(pa.ySplit ?? 0) : 0,
    rawXml: xml,
  };
}

export function readXlsxWorkbook(bytes: Uint8Array): XlsxWorkbookInfo {
  const files = unzipSync(bytes);
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : "");
  const workbookXml = text("xl/workbook.xml");
  const rels = new Map<string, string>();
  for (const m of text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s+([^>]*?)\/>/g)) {
    const a = attrs(m[1]);
    rels.set(a.Id, a.Target);
  }
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const { styles, defaultFont } = parseStyles(text("xl/styles.xml"));
  const sheets = [...workbookXml.matchAll(/<sheet\s+([^>]*?)\/>/g)].map((m) => {
    const a = attrs(m[1]);
    const target = rels.get(a["r:id"]) ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    return parseSheet(a.name, text(path), shared);
  });
  const definedNames = [...workbookXml.matchAll(/<definedName\s+([^>]*?)>([\s\S]*?)<\/definedName>/g)].map((m) => {
    const a = attrs(m[1]);
    return { name: a.name, localSheetId: a.localSheetId !== undefined ? Number(a.localSheetId) : null, ref: decodeXml(m[2]) };
  });
  return {
    sheets,
    definedNames,
    styles,
    defaultFont,
    style: (cell) => (cell && cell.styleId !== null ? (styles[cell.styleId] ?? null) : null),
  };
}

/** Excelの日付シリアル値（1900年方式）を、UTCのYYYY-MM-DDにする */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}
