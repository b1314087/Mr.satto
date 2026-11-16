import { CfbError, CfbFile } from "./cfb";

/**
 * 古い形式のExcelファイル（.xls。Excel 97〜2003 の BIFF8 形式）を読む。
 *
 * 外部のライブラリは使わず、仕様（[MS-XLS]）に沿って、次のものを読み取る：
 *   シート（表示・非表示）／セルの値（文字・数値・日付・真偽・エラー）／数式（計算式の文字と、保存されている計算結果）／
 *   書式（フォント・文字の色・塗りつぶし・罫線・配置・折り返し・表示形式）／セル内の一部の文字の書式／
 *   列の幅・非表示の列／行の高さ・非表示の行／セルの結合／1904年の日付の方式。
 * 読めないもの（画像・グラフ・図形・コメント・入力規則・条件付き書式・マクロなど）は、数を数えて知らせる（黙って消さない）。
 * 数式のうち、ここで文字に戻せないもの（ほかのブックを参照する式など）は、保存されている計算結果の値にして、件数を知らせる。
 */

export class XlsError extends Error {}

export interface XlsFont {
  name: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: "none" | "single" | "double";
  vertAlign: "superscript" | "subscript" | null;
  /** RRGGBB。自動（既定の色）は null */
  color: string | null;
}

export type XlsBorderStyle =
  | "thin"
  | "medium"
  | "dashed"
  | "dotted"
  | "thick"
  | "double"
  | "hair"
  | "mediumDashed"
  | "dashDot"
  | "mediumDashDot"
  | "dashDotDot"
  | "mediumDashDotDot"
  | "slantDashDot";

export interface XlsBorderSide {
  style: XlsBorderStyle;
  color: string | null;
}

export interface XlsXf {
  font: XlsFont;
  /** 表示形式。Excelに最初からある形式は id、ファイルに書かれた形式は code */
  numFmt: { id: number; code: string | null };
  hAlign: "general" | "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
  vAlign: "top" | "center" | "bottom" | "justify" | "distributed";
  wrap: boolean;
  shrink: boolean;
  indent: number;
  rotation: number;
  fill: { pattern: string; fg: string | null; bg: string | null } | null;
  border: { left: XlsBorderSide | null; right: XlsBorderSide | null; top: XlsBorderSide | null; bottom: XlsBorderSide | null };
}

export type XlsValue =
  | { t: "s"; v: string; rich?: { text: string; font: XlsFont }[] }
  | { t: "n"; v: number }
  | { t: "b"; v: boolean }
  | { t: "e"; v: string }
  | { t: "blank" };

export interface XlsCell {
  value: XlsValue;
  xf: number;
  /** 数式（先頭の = は付けない）。文字に戻せなかった場合は undefined（値だけを使う） */
  formula?: string;
  formulaLost?: boolean;
}

export interface XlsSheet {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  cells: Map<number, Map<number, XlsCell>>;
  maxRow: number;
  maxCol: number;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  /** 列の幅（Excelの文字数の単位）と非表示 */
  cols: { first: number; last: number; width: number; hidden: boolean; xf: number }[];
  rows: Map<number, { heightPt: number; custom: boolean; hidden: boolean }>;
  defaultColWidth: number | null;
  defaultRowHeightPt: number | null;
  /** 読めなかったもの */
  unsupported: { images: number; charts: number; shapes: number; comments: number; hyperlinks: number; dataValidations: number; conditionalFormats: number };
}

export interface XlsWorkbook {
  sheets: XlsSheet[];
  xfs: XlsXf[];
  date1904: boolean;
  skippedSheets: { name: string; kind: string }[];
  formulasLost: number;
  hasMacros: boolean;
}

const ERRORS: Record<number, string> = { 0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!", 0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A" };

const BASE_COLORS = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF"];
const DEFAULT_PALETTE = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF", "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF", "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99", "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];
const BORDER_STYLES: (XlsBorderStyle | null)[] = [null, "thin", "medium", "dashed", "dotted", "thick", "double", "hair", "mediumDashed", "dashDot", "mediumDashDot", "dashDotDot", "mediumDashDotDot", "slantDashDot"];
const FILL_PATTERNS = [
  "none", "solid", "mediumGray", "darkGray", "lightGray", "darkHorizontal", "darkVertical", "darkDown", "darkUp", "darkGrid", "darkTrellis",
  "lightHorizontal", "lightVertical", "lightDown", "lightUp", "lightGrid", "lightTrellis", "gray125", "gray0625",
];
const H_ALIGN: XlsXf["hAlign"][] = ["general", "left", "center", "right", "fill", "justify", "centerContinuous", "distributed"];
const V_ALIGN: XlsXf["vAlign"][] = ["top", "center", "bottom", "justify", "distributed"];

/**
 * 関数の番号と名前・引数の数（引数の数が決まっていない関数は -1）。
 * BIFF8 の関数の一覧のうち、よく使われるものを入れている（ここに無い関数を含む式は、計算結果の値にして件数を知らせる）。
 */
const FUNCTIONS: Record<number, [string, number]> = {
  0: ["COUNT", -1], 1: ["IF", -1], 2: ["ISNA", 1], 3: ["ISERROR", 1], 4: ["SUM", -1], 5: ["AVERAGE", -1], 6: ["MIN", -1], 7: ["MAX", -1],
  8: ["ROW", -1], 9: ["COLUMN", -1], 10: ["NA", 0], 11: ["NPV", -1], 12: ["STDEV", -1], 13: ["DOLLAR", -1], 14: ["FIXED", -1], 15: ["SIN", 1],
  16: ["COS", 1], 17: ["TAN", 1], 18: ["ATAN", 1], 19: ["PI", 0], 20: ["SQRT", 1], 21: ["EXP", 1], 22: ["LN", 1], 23: ["LOG10", 1],
  24: ["ABS", 1], 25: ["INT", 1], 26: ["SIGN", 1], 27: ["ROUND", 2], 28: ["LOOKUP", -1], 29: ["INDEX", -1], 30: ["REPT", 2], 31: ["MID", 3],
  32: ["LEN", 1], 33: ["VALUE", 1], 34: ["TRUE", 0], 35: ["FALSE", 0], 36: ["AND", -1], 37: ["OR", -1], 38: ["NOT", 1], 39: ["MOD", 2],
  40: ["DCOUNT", 3], 41: ["DSUM", 3], 42: ["DAVERAGE", 3], 43: ["DMIN", 3], 44: ["DMAX", 3], 45: ["DSTDEV", 3], 46: ["VAR", -1], 47: ["DVAR", 3],
  48: ["TEXT", 2], 49: ["LINEST", -1], 50: ["TREND", -1], 51: ["LOGEST", -1], 52: ["GROWTH", -1], 56: ["PV", -1], 57: ["FV", -1], 58: ["NPER", -1],
  59: ["PMT", -1], 60: ["RATE", -1], 61: ["MIRR", 3], 62: ["IRR", -1], 63: ["RAND", 0], 64: ["MATCH", -1], 65: ["DATE", 3], 66: ["TIME", 3],
  67: ["DAY", 1], 68: ["MONTH", 1], 69: ["YEAR", 1], 70: ["WEEKDAY", -1], 71: ["HOUR", 1], 72: ["MINUTE", 1], 73: ["SECOND", 1], 74: ["NOW", 0],
  75: ["AREAS", 1], 76: ["ROWS", 1], 77: ["COLUMNS", 1], 78: ["OFFSET", -1], 82: ["SEARCH", -1], 83: ["TRANSPOSE", 1], 86: ["TYPE", 1],
  97: ["ATAN2", 2], 98: ["ASIN", 1], 99: ["ACOS", 1], 100: ["CHOOSE", -1], 101: ["HLOOKUP", -1], 102: ["VLOOKUP", -1], 105: ["ISREF", 1],
  109: ["LOG", -1], 111: ["CHAR", 1], 112: ["LOWER", 1], 113: ["UPPER", 1], 114: ["PROPER", 1], 115: ["LEFT", -1], 116: ["RIGHT", -1],
  117: ["EXACT", 2], 118: ["TRIM", 1], 119: ["REPLACE", 4], 120: ["SUBSTITUTE", -1], 121: ["CODE", 1], 124: ["FIND", -1], 125: ["CELL", -1],
  126: ["ISERR", 1], 127: ["ISTEXT", 1], 128: ["ISNUMBER", 1], 129: ["ISBLANK", 1], 130: ["T", 1], 131: ["N", 1], 140: ["DATEVALUE", 1],
  141: ["TIMEVALUE", 1], 142: ["SLN", 3], 143: ["SYD", 4], 144: ["DDB", -1], 148: ["INDIRECT", -1], 162: ["CLEAN", 1], 163: ["MDETERM", 1],
  164: ["MINVERSE", 1], 165: ["MMULT", 2], 167: ["IPMT", -1], 168: ["PPMT", -1], 169: ["COUNTA", -1], 183: ["PRODUCT", -1], 184: ["FACT", 1],
  189: ["DPRODUCT", 3], 190: ["ISNONTEXT", 1], 193: ["STDEVP", -1], 194: ["VARP", -1], 195: ["DSTDEVP", 3], 196: ["DVARP", 3], 197: ["TRUNC", -1],
  198: ["ISLOGICAL", 1], 199: ["DCOUNTA", 3], 204: ["YEN", -1], 205: ["FINDB", -1], 206: ["SEARCHB", -1], 207: ["REPLACEB", 4], 208: ["LEFTB", -1],
  209: ["RIGHTB", -1], 210: ["MIDB", 3], 211: ["LENB", 1], 212: ["ROUNDUP", 2], 213: ["ROUNDDOWN", 2], 214: ["ASC", 1], 215: ["JIS", 1],
  216: ["RANK", -1], 219: ["ADDRESS", -1], 220: ["DAYS360", -1], 221: ["TODAY", 0], 222: ["VDB", -1], 227: ["MEDIAN", -1], 228: ["SUMPRODUCT", -1],
  229: ["SINH", 1], 230: ["COSH", 1], 231: ["TANH", 1], 232: ["ASINH", 1], 233: ["ACOSH", 1], 234: ["ATANH", 1], 235: ["DGET", 3], 244: ["INFO", 1],
  247: ["DB", -1], 252: ["FREQUENCY", 2], 261: ["ERROR.TYPE", 1], 269: ["AVEDEV", -1], 276: ["COMBIN", 2], 279: ["EVEN", 1], 285: ["FLOOR", 2],
  288: ["CEILING", 2], 298: ["ODD", 1], 299: ["PERMUT", 2], 307: ["CORREL", 2], 309: ["FORECAST", 3], 311: ["INTERCEPT", 2], 313: ["RSQ", 2],
  315: ["SLOPE", 2], 318: ["DEVSQ", -1], 319: ["GEOMEAN", -1], 320: ["HARMEAN", -1], 321: ["SUMSQ", -1], 325: ["LARGE", 2], 326: ["SMALL", 2],
  327: ["QUARTILE", 2], 328: ["PERCENTILE", 2], 330: ["MODE", -1], 336: ["CONCATENATE", -1], 337: ["POWER", 2], 342: ["RADIANS", 1],
  343: ["DEGREES", 1], 344: ["SUBTOTAL", -1], 345: ["SUMIF", -1], 346: ["COUNTIF", 2], 347: ["COUNTBLANK", 1], 351: ["DATEDIF", 3],
  352: ["DATESTRING", 1], 353: ["NUMBERSTRING", 2], 354: ["ROMAN", -1], 359: ["HYPERLINK", -1], 360: ["PHONETIC", 1], 361: ["AVERAGEA", -1],
  362: ["MAXA", -1], 363: ["MINA", -1], 364: ["STDEVPA", -1], 365: ["VARPA", -1], 366: ["STDEVA", -1], 367: ["VARA", -1],
};

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  get view() {
    return new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
  }
  u8() {
    return this.b[this.pos++];
  }
  u16() {
    const v = this.b[this.pos] | (this.b[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  i16() {
    const v = this.u16();
    return v > 0x7fff ? v - 0x10000 : v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  remaining() {
    return this.b.length - this.pos;
  }
}

function chars(b: Uint8Array, pos: number, count: number, high: boolean): string {
  let s = "";
  if (high) for (let i = 0; i < count; i++) s += String.fromCharCode(b[pos + i * 2] | (b[pos + i * 2 + 1] << 8));
  else for (let i = 0; i < count; i++) s += String.fromCharCode(b[pos + i]);
  return s;
}

/** XLUnicodeString（文字数が2バイト）または ShortXLUnicodeString（1バイト） */
function readXlString(r: Reader, lenBytes: 1 | 2): string {
  const cch = lenBytes === 1 ? r.u8() : r.u16();
  const flags = r.u8();
  const high = (flags & 1) !== 0;
  const s = chars(r.b, r.pos, cch, high);
  r.pos += cch * (high ? 2 : 1);
  return s;
}

function rk(v: number): number {
  let n: number;
  if (v & 0x02) {
    n = v >> 2;
  } else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    buf.setUint32(0, 0, true);
    n = buf.getFloat64(0, true);
  }
  return v & 0x01 ? n / 100 : n;
}

interface RawRecord {
  type: number;
  data: Uint8Array;
  /** CONTINUE で続いた部分の区切り（data の中の位置） */
  breaks: number[];
}

function* records(stream: Uint8Array, start: number): Generator<RawRecord> {
  let pos = start;
  while (pos + 4 <= stream.length) {
    const type = stream[pos] | (stream[pos + 1] << 8);
    const len = stream[pos + 2] | (stream[pos + 3] << 8);
    pos += 4;
    if (pos + len > stream.length) throw new XlsError("ファイルが壊れています（途中で切れています）。");
    let data = stream.subarray(pos, pos + len);
    pos += len;
    const breaks: number[] = [];
    // CONTINUE（0x003C）は、前のレコードの続き（SST・数式・文字列などが長いとき）
    while (pos + 4 <= stream.length && (stream[pos] | (stream[pos + 1] << 8)) === 0x003c && type !== 0x00ec && type !== 0x005d) {
      const clen = stream[pos + 2] | (stream[pos + 3] << 8);
      const joined = new Uint8Array(data.length + clen);
      joined.set(data);
      joined.set(stream.subarray(pos + 4, pos + 4 + clen), data.length);
      breaks.push(data.length);
      data = joined;
      pos += 4 + clen;
    }
    yield { type, data, breaks };
    if (type === 0x000a) return;
  }
}

/** SST（共有の文字列の一覧）。CONTINUE の区切りで文字の幅（1バイト/2バイト）を示す1バイトが入り直す */
function parseSst(rec: RawRecord, fonts: XlsFont[]): XlsValue[] {
  const b = rec.data;
  const breaks = new Set(rec.breaks);
  const out: XlsValue[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const unique = v.getUint32(4, true);
  let pos = 8;
  for (let n = 0; n < unique && pos < b.length; n++) {
    const cch = v.getUint16(pos, true);
    const flags = b[pos + 2];
    pos += 3;
    let high = (flags & 0x01) !== 0;
    const rich = (flags & 0x08) !== 0;
    const ext = (flags & 0x04) !== 0;
    let cRun = 0;
    let cbExt = 0;
    if (rich) {
      cRun = v.getUint16(pos, true);
      pos += 2;
    }
    if (ext) {
      cbExt = v.getUint32(pos, true);
      pos += 4;
    }
    let s = "";
    for (let i = 0; i < cch; i++) {
      if (breaks.has(pos) && i > 0) {
        high = (b[pos] & 0x01) !== 0;
        pos += 1;
      } else if (breaks.has(pos) && i === 0) {
        high = (b[pos] & 0x01) !== 0;
        pos += 1;
      }
      if (high) {
        s += String.fromCharCode(b[pos] | (b[pos + 1] << 8));
        pos += 2;
      } else {
        s += String.fromCharCode(b[pos]);
        pos += 1;
      }
    }
    const runs: { ich: number; font: number }[] = [];
    for (let i = 0; i < cRun; i++) {
      runs.push({ ich: v.getUint16(pos, true), font: v.getUint16(pos + 2, true) });
      pos += 4;
    }
    pos += cbExt;
    if (runs.length > 0) {
      const parts: { text: string; font: XlsFont }[] = [];
      const firstIch = runs[0].ich;
      if (firstIch > 0) parts.push({ text: s.slice(0, firstIch), font: fonts[0] });
      runs.forEach((run, i) => {
        const end = i + 1 < runs.length ? runs[i + 1].ich : s.length;
        if (end > run.ich) parts.push({ text: s.slice(run.ich, end), font: fonts[run.font] ?? fonts[0] });
      });
      out.push({ t: "s", v: s, rich: parts.length > 1 ? parts : undefined });
    } else {
      out.push({ t: "s", v: s });
    }
  }
  return out;
}

function colLetters(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function cellRef(row: number, col: number, rowRel: boolean, colRel: boolean): string {
  return `${colRel ? "" : "$"}${colLetters(col)}${rowRel ? "" : "$"}${row + 1}`;
}

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

class FormulaLost extends Error {}

interface FormulaContext {
  row: number;
  col: number;
  sheetNames: string[];
  externSheets: { supbook: number; first: number; last: number }[];
  internalSupbook: number;
  names: string[];
}

/** 数式のトークン（Ptg）の並びを、数式の文字に戻す。戻せないものがあれば FormulaLost を投げる */
function decompile(rgce: Uint8Array, ctx: FormulaContext, shared: boolean): string {
  const r = new Reader(rgce);
  const stack: string[] = [];
  const pop = () => {
    const v = stack.pop();
    if (v === undefined) throw new FormulaLost();
    return v;
  };
  const binary = (op: string) => {
    const b = pop();
    const a = pop();
    stack.push(`${a}${op}${b}`);
  };
  /** セルの参照。BIFF8 の列の値は bit15 = 行が相対、bit14 = 列が相対。共有の数式の ptgRefN/ptgAreaN だけ、相対の値は位置からのずれ */
  const loc = (rwRaw: number, colRaw: number, relativeToCell: boolean) => {
    const rRel = (colRaw & 0x8000) !== 0;
    const cRel = (colRaw & 0x4000) !== 0;
    let row = rwRaw;
    let col = colRaw & 0x3fff;
    if (relativeToCell) {
      if (rRel) row = (ctx.row + (rwRaw > 0x7fff ? rwRaw - 0x10000 : rwRaw)) & 0xffff;
      if (cRel) col = (ctx.col + ((col & 0xff) > 0x7f ? (col & 0xff) - 0x100 : col & 0xff)) & 0xff;
    }
    return { row, col, rRel, cRel };
  };
  const sheetPrefix = (ixti: number) => {
    const x = ctx.externSheets[ixti];
    if (!x || x.supbook !== ctx.internalSupbook) throw new FormulaLost();
    const a = ctx.sheetNames[x.first];
    const b = ctx.sheetNames[x.last];
    if (a === undefined || b === undefined) throw new FormulaLost();
    if (x.first === x.last) return `${quoteSheet(a)}!`;
    const plain = quoteSheet(a) === a && quoteSheet(b) === b;
    return plain ? `${a}:${b}!` : `'${a.replace(/'/g, "''")}:${b.replace(/'/g, "''")}'!`;
  };
  const opMap: Record<number, string> = { 0x03: "+", 0x04: "-", 0x05: "*", 0x06: "/", 0x07: "^", 0x08: "&", 0x09: "<", 0x0a: "<=", 0x0b: "=", 0x0c: ">=", 0x0d: ">", 0x0e: "<>", 0x0f: " ", 0x10: ",", 0x11: ":" };

  while (r.remaining() > 0) {
    const ptg = r.u8();
    if (ptg >= 0x03 && ptg <= 0x11) {
      binary(opMap[ptg]);
      continue;
    }
    switch (ptg) {
      case 0x01:
      case 0x02:
        throw new FormulaLost();
      case 0x12:
        stack.push(`+${pop()}`);
        break;
      case 0x13:
        stack.push(`-${pop()}`);
        break;
      case 0x14:
        stack.push(`${pop()}%`);
        break;
      case 0x15:
        stack.push(`(${pop()})`);
        break;
      case 0x16:
        stack.push("");
        break;
      case 0x17:
        stack.push(`"${readXlString(r, 1).replace(/"/g, '""')}"`);
        break;
      case 0x19: {
        const grbit = r.u8();
        const data = r.u16();
        if (grbit & 0x04) r.pos += (data + 1) * 2; // CHOOSE の飛び先の表
        else if (grbit & 0x10) stack.push(`SUM(${pop()})`);
        // tAttrSemi・tAttrIf・tAttrGoto・tAttrSpace などは、表示に影響しないので読み飛ばす
        break;
      }
      case 0x1c:
        stack.push(ERRORS[r.u8()] ?? "#N/A");
        break;
      case 0x1d:
        stack.push(r.u8() ? "TRUE" : "FALSE");
        break;
      case 0x1e:
        stack.push(String(r.u16()));
        break;
      case 0x1f: {
        const n = r.f64();
        stack.push(String(n));
        break;
      }
      default: {
        if (ptg < 0x20) throw new FormulaLost();
        const base = ptg & 0x1f;
        switch (base) {
          case 0x00: // ptgArray（配列の定数）
            throw new FormulaLost();
          case 0x01: {
            const idx = r.u16();
            const f = FUNCTIONS[idx];
            if (!f || f[1] < 0) throw new FormulaLost();
            const args: string[] = [];
            for (let i = 0; i < f[1]; i++) args.unshift(pop());
            stack.push(`${f[0]}(${args.join(",")})`);
            break;
          }
          case 0x02: {
            const argc = r.u8() & 0x7f;
            const idx = r.u16() & 0x7fff;
            const args: string[] = [];
            if (idx === 255) {
              // ユーザー定義・アドイン関数：最初の引数が関数名（ptgNameX）
              for (let i = 0; i < argc - 1; i++) args.unshift(pop());
              const name = pop();
              stack.push(`${name}(${args.join(",")})`);
              break;
            }
            const f = FUNCTIONS[idx];
            if (!f) throw new FormulaLost();
            for (let i = 0; i < argc; i++) args.unshift(pop());
            stack.push(`${f[0]}(${args.join(",")})`);
            break;
          }
          case 0x03: {
            const ilbl = r.u32();
            const name = ctx.names[ilbl - 1];
            if (!name) throw new FormulaLost();
            stack.push(name);
            break;
          }
          case 0x04:
          case 0x0c: {
            const rw = r.u16();
            const col = r.u16();
            const x = loc(rw, col, shared && base === 0x0c);
            stack.push(cellRef(x.row, x.col, x.rRel, x.cRel));
            break;
          }
          case 0x05:
          case 0x0d: {
            const rw1 = r.u16();
            const rw2 = r.u16();
            const c1 = r.u16();
            const c2 = r.u16();
            const a = loc(rw1, c1, shared && base === 0x0d);
            const b = loc(rw2, c2, shared && base === 0x0d);
            stack.push(`${cellRef(a.row, a.col, a.rRel, a.cRel)}:${cellRef(b.row, b.col, b.rRel, b.cRel)}`);
            break;
          }
          case 0x06: // ptgMemArea：続く部分式をそのまま使う
            r.pos += 6;
            break;
          case 0x07:
          case 0x08:
            r.pos += 6;
            break;
          case 0x09:
            r.pos += 2;
            break;
          case 0x0a:
            r.pos += 4;
            stack.push("#REF!");
            break;
          case 0x0b:
            r.pos += 8;
            stack.push("#REF!");
            break;
          case 0x19: // ptgNameX（ほかのブックの名前・アドイン関数の名前）
            throw new FormulaLost();
          case 0x1a: {
            const ixti = r.u16();
            const rw = r.u16();
            const col = r.u16();
            const x = loc(rw, col, false);
            stack.push(`${sheetPrefix(ixti)}${cellRef(x.row, x.col, x.rRel, x.cRel)}`);
            break;
          }
          case 0x1b: {
            const ixti = r.u16();
            const rw1 = r.u16();
            const rw2 = r.u16();
            const c1 = r.u16();
            const c2 = r.u16();
            const a = loc(rw1, c1, false);
            const b = loc(rw2, c2, false);
            stack.push(`${sheetPrefix(ixti)}${cellRef(a.row, a.col, a.rRel, a.cRel)}:${cellRef(b.row, b.col, b.rRel, b.cRel)}`);
            break;
          }
          case 0x1c:
            r.pos += 6;
            stack.push("#REF!");
            break;
          case 0x1d:
            r.pos += 10;
            stack.push("#REF!");
            break;
          default:
            throw new FormulaLost();
        }
      }
    }
  }
  if (stack.length !== 1) throw new FormulaLost();
  return stack[0];
}

function emptySheet(name: string, state: XlsSheet["state"]): XlsSheet {
  return {
    name,
    state,
    cells: new Map(),
    maxRow: -1,
    maxCol: -1,
    merges: [],
    cols: [],
    rows: new Map(),
    defaultColWidth: null,
    defaultRowHeightPt: null,
    unsupported: { images: 0, charts: 0, shapes: 0, comments: 0, hyperlinks: 0, dataValidations: 0, conditionalFormats: 0 },
  };
}

export function readXls(bytes: Uint8Array): XlsWorkbook {
  let cfb: CfbFile;
  try {
    cfb = new CfbFile(bytes);
  } catch (e) {
    throw new XlsError(e instanceof CfbError ? e.message : "ファイルを読み込めませんでした。");
  }
  const stream = cfb.stream("Workbook") ?? cfb.stream("Book");
  if (!stream) {
    if (cfb.has("WordDocument")) throw new XlsError("このファイルはWord文書（.doc）です。「Word旧形式→新形式」で変換してください。");
    if (cfb.has("EncryptedPackage")) throw new XlsError("パスワードで保護されたファイルです。Excelでパスワードを解除してから、お試しください。");
    throw new XlsError("Excelのデータが見つかりません。.xls形式のファイルか、ご確認ください。");
  }
  if (!cfb.stream("Workbook") && cfb.stream("Book")) {
    throw new XlsError("Excel 5.0／95形式のファイルには対応していません。Excel 97〜2003形式（.xls）で保存されたファイルをお使いください。");
  }

  const palette = [...DEFAULT_PALETTE];
  const color = (icv: number): string | null => {
    if (icv < 8) return BASE_COLORS[icv];
    if (icv < 64) return palette[icv - 8] ?? null;
    return null; // 64・65・0x7FFF などは「自動」
  };
  const rawFonts: { height: number; grbit: number; icv: number; bls: number; sss: number; uls: number; name: string }[] = [];
  const formats = new Map<number, string>();
  const rawXfs: { ifnt: number; ifmt: number; b: Uint8Array }[] = [];
  const boundSheets: { pos: number; state: number; type: number; name: string }[] = [];
  const externSheets: { supbook: number; first: number; last: number }[] = [];
  const supbooks: { internal: boolean }[] = [];
  const names: string[] = [];
  let sstRec: RawRecord | null = null;
  let date1904 = false;
  let hasMacros = cfb.has("_VBA_PROJECT_CUR");

  // 1. ブック全体の情報（最初のサブストリーム）
  let first = true;
  for (const rec of records(stream, 0)) {
    const r = new Reader(rec.data);
    switch (rec.type) {
      case 0x0809: {
        const vers = r.u16();
        const dt = r.u16();
        if (first && dt !== 0x0005) throw new XlsError("Excelのブックのデータが見つかりません。");
        if (first && vers !== 0x0600) throw new XlsError("Excel 97〜2003形式（BIFF8）以外の.xlsファイルには対応していません。Excelで開いて保存し直してから、お試しください。");
        first = false;
        break;
      }
      case 0x002f:
        throw new XlsError("パスワードで保護されたファイルです。Excelでパスワードを解除してから、お試しください。");
      case 0x0022:
        date1904 = r.u16() === 1;
        break;
      case 0x0031: {
        const height = r.u16();
        const grbit = r.u16();
        const icv = r.u16();
        const bls = r.u16();
        const sss = r.u16();
        const uls = r.u8();
        r.pos += 3; // bFamily・bCharSet・予約
        const name = readXlString(r, 1);
        rawFonts.push({ height, grbit, icv, bls, sss, uls, name });
        break;
      }
      case 0x041e: {
        const id = r.u16();
        formats.set(id, readXlString(r, 2));
        break;
      }
      case 0x00e0: {
        const ifnt = r.u16();
        const ifmt = r.u16();
        rawXfs.push({ ifnt, ifmt, b: rec.data.slice(4) });
        break;
      }
      case 0x0092: {
        const n = r.u16();
        for (let i = 0; i < n && i < 56; i++) {
          const rr = r.u8();
          const gg = r.u8();
          const bb = r.u8();
          r.pos += 1;
          palette[i] = [rr, gg, bb].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
        }
        break;
      }
      case 0x0085: {
        const pos = r.u32();
        const state = r.u8() & 0x03;
        const type = r.u8();
        const name = readXlString(r, 1);
        boundSheets.push({ pos, state, type, name });
        break;
      }
      case 0x00fc:
        sstRec = rec;
        break;
      case 0x01ae: {
        const ctab = r.u16();
        const cch = r.u16();
        void ctab;
        supbooks.push({ internal: cch === 0x0401 });
        break;
      }
      case 0x0017: {
        const n = r.u16();
        for (let i = 0; i < n; i++) externSheets.push({ supbook: r.u16(), first: r.u16(), last: r.u16() });
        break;
      }
      case 0x0018: {
        const grbit = r.u16();
        r.pos += 1; // chKey
        const cch = r.u8();
        r.pos += 2 + 2 + 2 + 4; // cce・予約・itab・予約
        const builtin = (grbit & 0x0020) !== 0;
        const flags = r.u8();
        const high = (flags & 1) !== 0;
        let name: string;
        if (builtin) {
          const code = rec.data[r.pos];
          const BUILTIN = ["Consolidate_Area", "Auto_Open", "Auto_Close", "Extract", "Database", "Criteria", "Print_Area", "Print_Titles", "Recorder", "Data_Form", "Auto_Activate", "Auto_Deactivate", "Sheet_Title", "_FilterDatabase"];
          name = `_xlnm.${BUILTIN[code] ?? "Name"}`;
        } else {
          name = chars(rec.data, r.pos, cch, high);
        }
        names.push(name);
        break;
      }
      case 0x00d3: // OBJPROJ（マクロのプロジェクトがある）
        hasMacros = true;
        break;
    }
  }

  const fonts: XlsFont[] = rawFonts.map((f) => ({
    name: f.name,
    sizePt: f.height / 20,
    bold: f.bls >= 700,
    italic: (f.grbit & 0x02) !== 0,
    strike: (f.grbit & 0x08) !== 0,
    underline: f.uls === 0 ? "none" : f.uls === 2 || f.uls === 0x22 ? "double" : "single",
    vertAlign: f.sss === 1 ? "superscript" : f.sss === 2 ? "subscript" : null,
    color: color(f.icv),
  }));
  // フォントの番号 4 は欠番（4以上は1つずれる）
  const fontAt = (i: number): XlsFont => fonts[i >= 4 ? i - 1 : i] ?? fonts[0] ?? { name: "ＭＳ Ｐゴシック", sizePt: 11, bold: false, italic: false, strike: false, underline: "none", vertAlign: null, color: null };

  const xfs: XlsXf[] = rawXfs.map(({ ifnt, ifmt, b }) => {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const align = b[2];
    const trot = b[3];
    const indentByte = b[4];
    const border1 = v.getUint16(6, true);
    const border2 = v.getUint16(8, true);
    const border3 = v.getUint32(10, true);
    const fillColors = v.getUint16(14, true);
    const side = (dg: number, icv: number): XlsBorderSide | null => {
      const style = BORDER_STYLES[dg] ?? null;
      return style ? { style, color: color(icv) ?? "000000" } : null;
    };
    const fls = (border3 >>> 26) & 0x3f;
    const fg = color(fillColors & 0x7f);
    const bg = color((fillColors >> 7) & 0x7f);
    return {
      font: fontAt(ifnt),
      numFmt: { id: ifmt, code: formats.get(ifmt) ?? null },
      hAlign: H_ALIGN[align & 0x07] ?? "general",
      vAlign: V_ALIGN[(align >> 4) & 0x07] ?? "bottom",
      wrap: (align & 0x08) !== 0,
      shrink: (indentByte & 0x10) !== 0,
      indent: indentByte & 0x0f,
      rotation: trot,
      fill: fls === 0 ? null : { pattern: FILL_PATTERNS[fls] ?? "solid", fg, bg },
      border: {
        left: side(border1 & 0x0f, border2 & 0x7f),
        right: side((border1 >> 4) & 0x0f, (border2 >> 7) & 0x7f),
        top: side((border1 >> 8) & 0x0f, border3 & 0x7f),
        bottom: side((border1 >> 12) & 0x0f, (border3 >> 7) & 0x7f),
      },
    };
  });

  // SST の文字ごとの書式は、フォントの番号（4の欠番込み）で指す
  const sst = sstRec ? parseSst(sstRec, Array.from({ length: rawFonts.length + 1 }, (_, i) => fontAt(i))) : [];
  const internalSupbook = supbooks.findIndex((s) => s.internal);
  const sheetNames = boundSheets.map((s) => s.name);

  // 2. シートごとのデータ
  const sheets: XlsSheet[] = [];
  const skippedSheets: { name: string; kind: string }[] = [];
  let formulasLost = 0;
  for (const bs of boundSheets) {
    if (bs.type !== 0x00) {
      skippedSheets.push({ name: bs.name, kind: bs.type === 0x02 ? "グラフのシート" : bs.type === 0x01 ? "マクロのシート" : "特別なシート" });
      continue;
    }
    const sheet = emptySheet(bs.name, bs.state === 1 ? "hidden" : bs.state === 2 ? "veryHidden" : "visible");
    const setCell = (row: number, col: number, cell: XlsCell) => {
      let rowMap = sheet.cells.get(row);
      if (!rowMap) sheet.cells.set(row, (rowMap = new Map()));
      rowMap.set(col, cell);
      if (row > sheet.maxRow) sheet.maxRow = row;
      if (col > sheet.maxCol) sheet.maxCol = col;
    };
    const sharedFormulas: { r1: number; r2: number; c1: number; c2: number; rgce: Uint8Array }[] = [];
    const pendingExp: { row: number; col: number; masterRow: number; masterCol: number }[] = [];
    let pendingString: { row: number; col: number } | null = null;
    const ctxBase = { sheetNames, externSheets, internalSupbook, names };
    let depth = 0;

    for (const rec of records(stream, bs.pos)) {
      const r = new Reader(rec.data);
      if (rec.type === 0x0809) {
        depth++;
        continue;
      }
      if (rec.type === 0x000a) {
        depth--;
        if (depth <= 0) break;
        continue;
      }
      if (depth > 1) continue; // シートの中に入れ子のグラフなど
      switch (rec.type) {
        case 0x0201: {
          const row = r.u16();
          const col = r.u16();
          setCell(row, col, { value: { t: "blank" }, xf: r.u16() });
          break;
        }
        case 0x00be: {
          const row = r.u16();
          const c1 = r.u16();
          const n = (rec.data.length - 6) / 2;
          for (let i = 0; i < n; i++) setCell(row, c1 + i, { value: { t: "blank" }, xf: r.u16() });
          break;
        }
        case 0x0203: {
          const row = r.u16();
          const col = r.u16();
          const xf = r.u16();
          setCell(row, col, { value: { t: "n", v: r.f64() }, xf });
          break;
        }
        case 0x027e: {
          const row = r.u16();
          const col = r.u16();
          const xf = r.u16();
          setCell(row, col, { value: { t: "n", v: rk(r.u32()) }, xf });
          break;
        }
        case 0x00bd: {
          const row = r.u16();
          const c1 = r.u16();
          const n = (rec.data.length - 6) / 6;
          for (let i = 0; i < n; i++) {
            const xf = r.u16();
            setCell(row, c1 + i, { value: { t: "n", v: rk(r.u32()) }, xf });
          }
          break;
        }
        case 0x00fd: {
          const row = r.u16();
          const col = r.u16();
          const xf = r.u16();
          const isst = r.u32();
          setCell(row, col, { value: sst[isst] ?? { t: "s", v: "" }, xf });
          break;
        }
        case 0x0204: {
          const row = r.u16();
          const col = r.u16();
          const xf = r.u16();
          setCell(row, col, { value: { t: "s", v: readXlString(r, 2) }, xf });
          break;
        }
        case 0x0205: {
          const row = r.u16();
          const col = r.u16();
          const xf = r.u16();
          const val = r.u8();
          const isErr = r.u8() === 1;
          setCell(row, col, { value: isErr ? { t: "e", v: ERRORS[val] ?? "#N/A" } : { t: "b", v: val !== 0 }, xf });
          break;
        }
        case 0x0006: {
          const row = r.u16();
          const col = r.u16();
          const xf = r.u16();
          const valBytes = rec.data.subarray(6, 14);
          r.pos = 14;
          r.u16(); // grbit
          r.u32(); // chn
          const cce = r.u16();
          const rgce = rec.data.subarray(r.pos, r.pos + cce);
          let value: XlsValue;
          if (valBytes[6] === 0xff && valBytes[7] === 0xff) {
            const kind = valBytes[0];
            if (kind === 0) {
              value = { t: "s", v: "" };
              pendingString = { row, col };
            } else if (kind === 1) value = { t: "b", v: valBytes[2] !== 0 };
            else if (kind === 2) value = { t: "e", v: ERRORS[valBytes[2]] ?? "#N/A" };
            else value = { t: "s", v: "" };
          } else {
            value = { t: "n", v: new DataView(valBytes.buffer, valBytes.byteOffset, 8).getFloat64(0, true) };
          }
          const cell: XlsCell = { value, xf };
          if (rgce.length >= 5 && rgce[0] === 0x01) {
            // 共有の数式・配列の数式の一部（あとで SHRFMLA から組み立てる）
            pendingExp.push({ row, col, masterRow: rgce[1] | (rgce[2] << 8), masterCol: rgce[3] | (rgce[4] << 8) });
          } else {
            try {
              cell.formula = decompile(rgce, { ...ctxBase, row, col }, false);
            } catch {
              cell.formulaLost = true;
            }
          }
          setCell(row, col, cell);
          break;
        }
        case 0x0207: {
          if (pendingString) {
            const cell = sheet.cells.get(pendingString.row)?.get(pendingString.col);
            if (cell) cell.value = { t: "s", v: readXlString(r, 2) };
            pendingString = null;
          }
          break;
        }
        case 0x04bc: {
          const r1 = r.u16();
          const r2 = r.u16();
          const c1 = r.u8();
          const c2 = r.u8();
          r.pos += 2; // 予約・cUse
          const cce = r.u16();
          sharedFormulas.push({ r1, r2, c1, c2, rgce: rec.data.slice(r.pos, r.pos + cce) });
          break;
        }
        case 0x00e5: {
          const n = r.u16();
          for (let i = 0; i < n; i++) {
            const r1 = r.u16();
            const r2 = r.u16();
            const c1 = r.u16();
            const c2 = r.u16();
            if (r2 > r1 || c2 > c1) sheet.merges.push({ r1, c1, r2, c2 });
          }
          break;
        }
        case 0x007d: {
          const firstCol = r.u16();
          const lastCol = r.u16();
          const coldx = r.u16();
          const xf = r.u16();
          const grbit = r.u16();
          sheet.cols.push({ first: firstCol, last: Math.min(lastCol, 16383), width: coldx / 256, hidden: (grbit & 0x01) !== 0, xf });
          break;
        }
        case 0x0208: {
          const row = r.u16();
          r.pos += 4; // colMic・colMac
          const miyRw = r.u16();
          r.pos += 4; // 予約
          const grbit = r.u16();
          const heightPt = (miyRw & 0x7fff) / 20;
          sheet.rows.set(row, { heightPt, custom: (grbit & 0x40) !== 0, hidden: (grbit & 0x20) !== 0 });
          break;
        }
        case 0x0055:
          sheet.defaultColWidth = r.u16();
          break;
        case 0x0225: {
          r.u16();
          sheet.defaultRowHeightPt = r.u16() / 20;
          break;
        }
        case 0x005d: {
          // OBJ：画像・グラフ・図形・コメントの枠
          const ft = r.u16();
          const cb = r.u16();
          void cb;
          if (ft === 0x15) {
            const ot = r.u16();
            if (ot === 0x08) sheet.unsupported.images++;
            else if (ot === 0x05) sheet.unsupported.charts++;
            else if (ot === 0x19) sheet.unsupported.comments++;
            else if (ot !== 0x14) sheet.unsupported.shapes++;
          }
          break;
        }
        case 0x01b8:
          sheet.unsupported.hyperlinks++;
          break;
        case 0x01be:
          sheet.unsupported.dataValidations++;
          break;
        case 0x01b0:
          sheet.unsupported.conditionalFormats++;
          break;
      }
    }

    // 共有の数式を、それぞれのセルの位置に合わせて組み立てる
    for (const p of pendingExp) {
      const cell = sheet.cells.get(p.row)?.get(p.col);
      if (!cell) continue;
      const sf = sharedFormulas.find((s) => p.row >= s.r1 && p.row <= s.r2 && p.col >= s.c1 && p.col <= s.c2 && s.r1 === p.masterRow && s.c1 === p.masterCol)
        ?? sharedFormulas.find((s) => p.row >= s.r1 && p.row <= s.r2 && p.col >= s.c1 && p.col <= s.c2);
      if (!sf) {
        cell.formulaLost = true; // 配列の数式など
        continue;
      }
      try {
        cell.formula = decompile(sf.rgce, { ...ctxBase, row: p.row, col: p.col }, true);
      } catch {
        cell.formulaLost = true;
      }
    }
    for (const rowMap of sheet.cells.values()) for (const cell of rowMap.values()) if (cell.formulaLost) formulasLost++;
    sheets.push(sheet);
  }

  if (sheets.length === 0) throw new XlsError("変換できるシートが見つかりませんでした。");
  return { sheets, xfs, date1904, skippedSheets, formulasLost, hasMacros };
}

/** Excelに最初からある表示形式の番号を、表示形式の文字にする（日本語版のExcelの表示に合わせる） */
export const BUILTIN_NUMBER_FORMATS: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 5: '"¥"#,##0;"¥"\\-#,##0', 6: '"¥"#,##0;[Red]"¥"\\-#,##0', 7: '"¥"#,##0.00;"¥"\\-#,##0.00',
  8: '"¥"#,##0.00;[Red]"¥"\\-#,##0.00', 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "yyyy/m/d", 15: "d-mmm-yy", 16: "d-mmm",
  17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "yyyy/m/d h:mm", 27: '[$-411]ge.m.d', 28: '[$-411]ggge"年"m"月"d"日"',
  29: '[$-411]ggge"年"m"月"d"日"', 30: "m/d/yy", 31: 'yyyy"年"m"月"d"日"', 32: 'h"時"mm"分"', 33: 'h"時"mm"分"ss"秒"', 34: 'yyyy"年"m"月"', 35: 'm"月"d"日"',
  36: '[$-411]ge.m.d', 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)", 45: "mm:ss",
  46: "[h]:mm:ss", 47: "mm:ss.0", 48: "##0.0E+0", 49: "@", 50: '[$-411]ge.m.d', 51: '[$-411]ggge"年"m"月"d"日"', 52: 'yyyy"年"m"月"', 53: 'm"月"d"日"',
  54: '[$-411]ggge"年"m"月"d"日"', 55: 'yyyy"年"m"月"', 56: 'm"月"d"日"', 57: '[$-411]ge.m.d', 58: '[$-411]ggge"年"m"月"d"日"',
};
