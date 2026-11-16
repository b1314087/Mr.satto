import { inflateSync, unzlibSync } from "fflate";
import { CfbError, CfbFile } from "./cfb";

/**
 * 古い形式のWord文書（.doc。Word 97〜2003）を読む。外部のライブラリは使わず、仕様（[MS-DOC]）に沿って読む。
 *
 * 読み取るもの：本文の文字（日本語を含む）／文字の書式（フォント・大きさ・色・太字・斜体・下線・取り消し線・上付き下付き・蛍光ペン）／
 *   段落の書式（揃え・字下げ・段落の前後の間隔・行間・改ページ・段落スタイル）／スタイル（見出しなど）／箇条書き・段落番号／
 *   表（行・セル・列の幅・セルの結合・罫線・セルの色・行の高さ）／行内の画像（PNG・JPEG・EMF・WMF・BMP）／
 *   ヘッダー・フッター（先頭ページ・奇数偶数を含む）とページ番号／脚注／改ページ・セクション（用紙の大きさ・向き・余白・縦書き・行数の指定）。
 * 読めないもの（文字列の折り返しを設定した画像・図形・テキストボックス・グラフ・数式エディタ・埋め込みオブジェクト・変更履歴など）は、
 * 数を数えて知らせる（黙って消さない）。
 */

export class DocError extends Error {}

export interface CharProps {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  dstrike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  vanish?: boolean;
  /** docx の w:u の値（single・double など） */
  underline?: string;
  sizeHalfPt?: number;
  /** RRGGBB または "auto" */
  color?: string;
  fontAscii?: number;
  fontEastAsia?: number;
  fontOther?: number;
  vertAlign?: "superscript" | "subscript" | "baseline";
  highlight?: string;
  /** 文字の網かけ（背景の色）RRGGBB */
  shading?: string;
  charStyle?: number;
  // 特別な文字（画像・脚注の参照など）
  special?: boolean;
  picLocation?: number;
  ole2?: boolean;
  data?: boolean;
  deleted?: boolean;
  symbol?: { font: number; char: number };
}

export interface ParaProps {
  istd?: number;
  jc?: "left" | "center" | "right" | "both" | "distribute";
  indLeft?: number;
  indRight?: number;
  indFirst?: number;
  spBefore?: number;
  spAfter?: number;
  line?: { val: number; mult: boolean };
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  outlineLvl?: number;
  inTable?: boolean;
  ttp?: boolean;
  itap?: number;
  innerCell?: boolean;
  innerTtp?: boolean;
  ilfo?: number;
  ilvl?: number;
}

export interface Border {
  /** docx の w:val（single・double・dotted など） */
  val: string;
  /** 太さ（1/8pt） */
  sz: number;
  color: string;
}

export interface TableCellDef {
  width: number;
  hMergeFirst: boolean;
  hMerged: boolean;
  vMerge: "none" | "restart" | "continue";
  vAlign: "top" | "center" | "bottom";
  borders: { top?: Border; left?: Border; bottom?: Border; right?: Border };
  shading?: string;
}

export interface TableRowProps {
  centers: number[];
  cells: TableCellDef[];
  heightTwips?: number;
  exactHeight?: boolean;
  header?: boolean;
  cantSplit?: boolean;
  jc?: "left" | "center" | "right";
  tableBorders?: { top?: Border; left?: Border; bottom?: Border; right?: Border; insideH?: Border; insideV?: Border };
  leftIndent?: number;
  /** セルの内側の余白（twip） */
  cellMargins?: { top?: number; left?: number; bottom?: number; right?: number };
}

export interface SectProps {
  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  headerDist: number;
  footerDist: number;
  landscape: boolean;
  breakType: "nextPage" | "continuous" | "nextColumn" | "evenPage" | "oddPage";
  titlePage: boolean;
  columns: number;
  columnSpace: number;
  vertical: boolean;
  gridType?: "default" | "lines" | "linesAndChars" | "snapToChars";
  linePitch?: number;
  charSpace?: number;
  pgnStart?: number;
}

export type Inline =
  | { kind: "text"; text: string; props: CharProps }
  | { kind: "tab"; props: CharProps }
  | { kind: "break"; type: "line" | "page" | "column"; props: CharProps }
  | { kind: "image"; image: number; props: CharProps }
  | { kind: "field"; instr: "PAGE" | "NUMPAGES"; result: string; props: CharProps }
  | { kind: "footnoteRef"; id: number; props: CharProps }
  | { kind: "footnoteMark"; props: CharProps }
  | { kind: "symbol"; font: string; char: number; props: CharProps };

export interface DocParagraph {
  type: "p";
  props: ParaProps;
  markProps: CharProps;
  inlines: Inline[];
  /** このあとでセクションが終わる（その段落のあとに置くセクションの番号） */
  sectionEnd?: number;
}

export interface DocTable {
  type: "table";
  rows: { props: TableRowProps; cells: DocBlock[][] }[];
}

export type DocBlock = DocParagraph | DocTable;

export interface DocImage {
  bytes: Uint8Array;
  ext: "png" | "jpeg" | "emf" | "wmf" | "bmp";
  widthEmu: number;
  heightEmu: number;
}

export interface DocStyle {
  istd: number;
  sti: number;
  name: string;
  type: "paragraph" | "character" | "table" | "numbering";
  basedOn: number | null;
  next: number | null;
  para: ParaProps;
  char: CharProps;
}

export interface DocListLevel {
  start: number;
  nfc: number;
  text: string;
  jc: "left" | "center" | "right";
  follow: "tab" | "space" | "nothing";
  para: ParaProps;
  char: CharProps;
}

export interface DocList {
  lsid: number;
  levels: DocListLevel[];
}

export interface DocModel {
  body: DocBlock[];
  sections: SectProps[];
  /** セクションごとのヘッダー・フッター（even・default・first） */
  headers: { header: Partial<Record<"default" | "first" | "even", DocBlock[]>>; footer: Partial<Record<"default" | "first" | "even", DocBlock[]>> }[];
  footnotes: Map<number, DocBlock[]>;
  fonts: string[];
  styles: DocStyle[];
  defaultFonts: { ascii: number; eastAsia: number; other: number };
  lists: DocList[];
  /** LFO（段落が指す番号付きの一覧）→ lists の番号 */
  lfoToList: number[];
  images: DocImage[];
  evenAndOddHeaders: boolean;
  unsupported: {
    floatingObjects: number;
    textBoxes: number;
    oleObjects: number;
    nestedTables: number;
    unknownImages: number;
    revisions: number;
    comments: number;
    endnotes: number;
    fields: number;
  };
}

// ---------------------------------------------------------------------------
// 小さな読み取りの道具

function u16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8);
}
function i16(b: Uint8Array, p: number): number {
  const v = u16(b, p);
  return v > 0x7fff ? v - 0x10000 : v;
}
function u32(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}
function i32(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
}

/** 1バイトの文字（圧縮された部分）の、Windows-1252 で 0x80〜0x9F に入る文字 */
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const ICO: (string | null)[] = [null, "000000", "0000FF", "00FFFF", "00FF00", "FF00FF", "FF0000", "FFFF00", "FFFFFF", "000080", "008080", "008000", "800080", "800000", "808000", "808080", "C0C0C0"];
const HIGHLIGHT = ["none", "black", "blue", "cyan", "green", "magenta", "red", "yellow", "white", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray"];
const UNDERLINE: Record<number, string> = {
  0: "none", 1: "single", 2: "words", 3: "double", 4: "dotted", 6: "thick", 7: "dash", 9: "dotDash", 10: "dotDotDash", 11: "wave", 20: "dottedHeavy",
  23: "dashedHeavy", 25: "dashDotHeavy", 26: "dashDotDotHeavy", 27: "wavyHeavy", 39: "dashLong", 43: "wavyDouble", 55: "dashLongHeavy",
};
const BRC_TYPE: Record<number, string> = {
  1: "single", 2: "thick", 3: "double", 5: "single", 6: "dotted", 7: "dashed", 8: "dotDash", 9: "dotDotDash", 10: "triple", 11: "thinThickSmallGap",
  12: "thickThinSmallGap", 13: "thinThickThinSmallGap", 14: "thinThickMediumGap", 15: "thickThinMediumGap", 16: "thinThickThinMediumGap",
  17: "thinThickLargeGap", 18: "thickThinLargeGap", 19: "thinThickThinLargeGap", 20: "wave", 21: "doubleWave", 22: "dashSmallGap",
  23: "dashDotStroked", 24: "threeDEmboss", 25: "threeDEngrave", 26: "outset", 27: "inset",
};

function colorRef(b: Uint8Array, p: number): string {
  if (b[p + 3] === 0xff) return "auto";
  return [b[p], b[p + 1], b[p + 2]].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function brc80(b: Uint8Array, p: number): Border | undefined {
  if (u32(b, p) === 0xffffffff) return undefined;
  const sz = b[p];
  const type = b[p + 1];
  const ico = b[p + 2];
  if (type === 0 || type === 0xff) return undefined;
  return { val: BRC_TYPE[type] ?? "single", sz: Math.max(2, sz), color: ICO[ico] ?? "auto" };
}

function brc(b: Uint8Array, p: number): Border | undefined {
  // 新しい形の罫線（8バイト）：色（COLORREF）・太さ・種類
  if (u32(b, p + 4) === 0xffffffff) return undefined;
  const sz = b[p + 4];
  const type = b[p + 5];
  if (type === 0 || type === 0xff) return undefined;
  const c = colorRef(b, p);
  return { val: BRC_TYPE[type] ?? "single", sz: Math.max(2, sz), color: c === "auto" ? "auto" : c };
}

// ---------------------------------------------------------------------------
// 書式の指定（sprm）を読む

interface SprmTarget {
  char?: CharProps;
  /** 太字などの切り替え（0x80・0x81）の基準になる、スタイルの文字の書式 */
  baseChar?: CharProps;
  para?: ParaProps;
  row?: TableRowProps;
  sect?: SectProps;
  dataStream?: Uint8Array | null;
}

function sprmSize(sprm: number, b: Uint8Array, p: number): number {
  const spra = sprm >> 13;
  switch (spra) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    case 6:
      if (sprm === 0xd608 || sprm === 0xd606) return u16(b, p) + 1; // sprmTDefTable：大きさは2バイト
      if (sprm === 0xc615 && b[p] === 255) {
        // sprmPChgTabs の特別な形
        const del = b[p + 1];
        const add = b[p + 2 + del * 4];
        return 1 + 1 + del * 4 + 1 + add * 3;
      }
      return b[p] + 1;
  }
  return 1;
}

function toggle(v: number, base: boolean | undefined): boolean {
  if (v === 0x80) return !!base;
  if (v === 0x81) return !base;
  return v === 1;
}

function applyGrpprl(b: Uint8Array, start: number, end: number, t: SprmTarget): void {
  let p = start;
  while (p + 2 <= end) {
    const sprm = u16(b, p);
    p += 2;
    const size = sprmSize(sprm, b, p);
    if (p + size > end + 1) break;
    const o = p; // 値の位置
    const c = t.char;
    const para = t.para;
    const row = t.row;
    const sect = t.sect;
    switch (sprm) {
      // 文字
      case 0x0835:
        if (c) c.bold = toggle(b[o], t.baseChar?.bold);
        break;
      case 0x0836:
        if (c) c.italic = toggle(b[o], t.baseChar?.italic);
        break;
      case 0x0837:
        if (c) c.strike = toggle(b[o], t.baseChar?.strike);
        break;
      case 0x2a53:
        if (c) c.dstrike = toggle(b[o], t.baseChar?.dstrike);
        break;
      case 0x083a:
        if (c) c.smallCaps = toggle(b[o], t.baseChar?.smallCaps);
        break;
      case 0x083b:
        if (c) c.caps = toggle(b[o], t.baseChar?.caps);
        break;
      case 0x083c:
        if (c) c.vanish = toggle(b[o], t.baseChar?.vanish);
        break;
      case 0x2a3e:
        if (c) c.underline = UNDERLINE[b[o]] ?? "single";
        break;
      case 0x4a43:
        if (c) c.sizeHalfPt = u16(b, o);
        break;
      case 0x2a42:
        if (c && !c.color) c.color = ICO[b[o]] ?? "auto";
        break;
      case 0x6870:
        if (c) c.color = colorRef(b, o);
        break;
      case 0x4a4f:
        if (c) c.fontAscii = u16(b, o);
        break;
      case 0x4a50:
        if (c) c.fontEastAsia = u16(b, o);
        break;
      case 0x4a51:
        if (c) c.fontOther = u16(b, o);
        break;
      case 0x2a48:
        if (c) c.vertAlign = b[o] === 1 ? "superscript" : b[o] === 2 ? "subscript" : "baseline";
        break;
      case 0x2a0c:
        if (c) c.highlight = HIGHLIGHT[b[o]] ?? "none";
        break;
      case 0x4a30:
        if (c) c.charStyle = u16(b, o);
        break;
      case 0x4866:
        if (c) {
          const shd = u16(b, o);
          const back = (shd >> 5) & 0x1f;
          if (((shd >> 10) & 0x3f) !== 0 && ICO[back]) c.shading = ICO[back] ?? undefined;
        }
        break;
      case 0xca71:
        if (c) {
          const back = colorRef(b, o + 1 + 4);
          if (back !== "auto") c.shading = back;
        }
        break;
      case 0x0855:
        if (c) c.special = b[o] === 1;
        break;
      case 0x6a03:
        if (c) c.picLocation = u32(b, o);
        break;
      case 0x080a:
        if (c) c.ole2 = b[o] === 1;
        break;
      case 0x0806:
        if (c) c.data = b[o] === 1;
        break;
      case 0x0800:
        if (c) c.deleted = b[o] === 1;
        break;
      case 0x6a09:
        if (c) c.symbol = { font: u16(b, o), char: u16(b, o + 2) };
        break;
      // 段落
      case 0x4600:
        if (para) para.istd = u16(b, o);
        break;
      case 0x2403:
      case 0x2461:
        if (para) para.jc = (["left", "center", "right", "both", "distribute"] as const)[b[o]] ?? "left";
        break;
      case 0x840f:
      case 0x845e:
        if (para) para.indLeft = i16(b, o);
        break;
      case 0x8411:
      case 0x8460:
        if (para) para.indFirst = i16(b, o);
        break;
      case 0x840e:
      case 0x845d:
        if (para) para.indRight = i16(b, o);
        break;
      case 0xa413:
        if (para) para.spBefore = u16(b, o);
        break;
      case 0xa414:
        if (para) para.spAfter = u16(b, o);
        break;
      case 0x6412:
        if (para) para.line = { val: i16(b, o), mult: i16(b, o + 2) === 1 };
        break;
      case 0x2405:
        if (para) para.keepLines = b[o] === 1;
        break;
      case 0x2406:
        if (para) para.keepNext = b[o] === 1;
        break;
      case 0x2407:
        if (para) para.pageBreakBefore = b[o] === 1;
        break;
      case 0x2640:
        if (para) para.outlineLvl = b[o];
        break;
      case 0x2416:
        if (para) para.inTable = b[o] === 1;
        break;
      case 0x2417:
        if (para) para.ttp = b[o] === 1;
        break;
      case 0x6649:
        if (para) para.itap = i32(b, o);
        break;
      case 0x244b:
        if (para) para.innerCell = b[o] === 1;
        break;
      case 0x244c:
        if (para) para.innerTtp = b[o] === 1;
        break;
      case 0x460b:
        if (para) para.ilfo = i16(b, o);
        break;
      case 0x260a:
        if (para) para.ilvl = b[o];
        break;
      case 0x6646: {
        // sprmPHugePapx：段落の書式がDataストリームにある
        const ds = t.dataStream;
        if (ds && para) {
          const fc = u32(b, o);
          const cb = u16(ds, fc);
          if (fc + 2 + cb <= ds.length) {
            para.istd = u16(ds, fc + 2);
            applyGrpprl(ds, fc + 4, fc + 2 + cb, t);
          }
        }
        break;
      }
      // 表の行
      case 0xd608:
        if (row) {
          const itcMac = b[o + 2];
          row.centers = [];
          for (let i = 0; i <= itcMac; i++) row.centers.push(i16(b, o + 3 + i * 2));
          const tcStart = o + 3 + (itcMac + 1) * 2;
          const opEnd = o + size;
          row.cells = [];
          for (let i = 0; i < itcMac; i++) {
            const tp = tcStart + i * 20;
            const width = row.centers[i + 1] - row.centers[i];
            if (tp + 20 > opEnd) {
              row.cells.push({ width, hMergeFirst: false, hMerged: false, vMerge: "none", vAlign: "top", borders: {} });
              continue;
            }
            const grf = u16(b, tp);
            const vm = (grf >> 5) & 0x03;
            const va = (grf >> 7) & 0x03;
            row.cells.push({
              width,
              hMergeFirst: (grf & 0x03) === 1,
              hMerged: (grf & 0x03) >= 2,
              vMerge: vm === 3 ? "restart" : vm === 1 ? "continue" : "none",
              vAlign: va === 1 ? "center" : va === 2 ? "bottom" : "top",
              borders: { top: brc80(b, tp + 4), left: brc80(b, tp + 8), bottom: brc80(b, tp + 12), right: brc80(b, tp + 16) },
            });
          }
        }
        break;
      case 0xd613:
        if (row && b[o] >= 24) {
          row.tableBorders = { top: brc80(b, o + 1), left: brc80(b, o + 5), bottom: brc80(b, o + 9), right: brc80(b, o + 13), insideH: brc80(b, o + 17), insideV: brc80(b, o + 21) };
        }
        break;
      case 0xd605:
        if (row && b[o] >= 48) {
          row.tableBorders = { top: brc(b, o + 1), left: brc(b, o + 9), bottom: brc(b, o + 17), right: brc(b, o + 25), insideH: brc(b, o + 33), insideV: brc(b, o + 41) };
        }
        break;
      case 0xd609:
        // sprmTDefTableShd80：セルの色（2バイトずつ・色の番号）
        if (row) {
          const n = Math.floor(b[o] / 2);
          for (let i = 0; i < n && i < row.cells.length; i++) {
            const shd = u16(b, o + 1 + i * 2);
            const back = (shd >> 5) & 0x1f;
            const ipat = (shd >> 10) & 0x3f;
            if (ipat !== 0 && back && ICO[back]) row.cells[i].shading = ICO[back] ?? undefined;
          }
        }
        break;
      case 0xd612:
      case 0xd670:
        // sprmTDefTableShd・sprmTDefTableShdRaw：セルの色（10バイトずつ・RGB）
        if (row) {
          const n = Math.floor(b[o] / 10);
          for (let i = 0; i < n && i < row.cells.length; i++) {
            const back = colorRef(b, o + 1 + i * 10 + 4);
            if (back !== "auto") row.cells[i].shading = back;
          }
        }
        break;
      case 0xd634:
      case 0xd632:
        // sprmTCellPaddingDefault・sprmTCellPadding：セルの内側の余白
        if (row && b[o] >= 6) {
          const grf = b[o + 3];
          const fts = b[o + 4];
          const w = u16(b, o + 5);
          if (fts === 3) {
            const m = (row.cellMargins ??= {});
            if (grf & 0x01) m.top = w;
            if (grf & 0x02) m.left = w;
            if (grf & 0x04) m.bottom = w;
            if (grf & 0x08) m.right = w;
          }
        }
        break;
      case 0x9407:
        if (row) {
          const h = i16(b, o);
          row.heightTwips = Math.abs(h);
          row.exactHeight = h < 0;
        }
        break;
      case 0x3404:
        if (row) row.header = b[o] === 1;
        break;
      case 0x3403:
        if (row) row.cantSplit = b[o] === 1;
        break;
      case 0x5400:
      case 0x548a:
        if (row) row.jc = (["left", "center", "right"] as const)[u16(b, o)] ?? "left";
        break;
      case 0x9601:
        if (row) row.leftIndent = i16(b, o);
        break;
      // セクション
      case 0x3009:
        if (sect) sect.breakType = (["continuous", "nextColumn", "nextPage", "evenPage", "oddPage"] as const)[b[o]] ?? "nextPage";
        break;
      case 0x300a:
        if (sect) sect.titlePage = b[o] === 1;
        break;
      case 0xb01f:
        if (sect) sect.pageWidth = u16(b, o);
        break;
      case 0xb020:
        if (sect) sect.pageHeight = u16(b, o);
        break;
      case 0xb021:
        if (sect) sect.marginLeft = u16(b, o);
        break;
      case 0xb022:
        if (sect) sect.marginRight = u16(b, o);
        break;
      case 0x9023:
        if (sect) sect.marginTop = Math.abs(i16(b, o));
        break;
      case 0x9024:
        if (sect) sect.marginBottom = Math.abs(i16(b, o));
        break;
      case 0xb017:
        if (sect) sect.headerDist = u16(b, o);
        break;
      case 0xb018:
        if (sect) sect.footerDist = u16(b, o);
        break;
      case 0x301d:
        if (sect) sect.landscape = b[o] === 2;
        break;
      case 0x500b:
        if (sect) sect.columns = u16(b, o) + 1;
        break;
      case 0x900c:
        if (sect) sect.columnSpace = u16(b, o);
        break;
      case 0x5033:
        if (sect) sect.vertical = u16(b, o) === 1 || u16(b, o) === 3;
        break;
      case 0x5032:
        if (sect) sect.gridType = (["default", "linesAndChars", "lines", "snapToChars"] as const)[u16(b, o)] ?? "default";
        break;
      case 0x9031:
        if (sect) sect.linePitch = u16(b, o);
        break;
      case 0x7030:
        if (sect) sect.charSpace = i32(b, o);
        break;
      case 0x501c:
        if (sect) sect.pgnStart = u16(b, o);
        break;
    }
    p += size;
  }
}

function defaultSection(): SectProps {
  return {
    pageWidth: 11906,
    pageHeight: 16838,
    marginLeft: 1701,
    marginRight: 1701,
    marginTop: 1985,
    marginBottom: 1701,
    headerDist: 851,
    footerDist: 992,
    landscape: false,
    breakType: "nextPage",
    titlePage: false,
    columns: 1,
    columnSpace: 425,
    vertical: false,
  };
}

// ---------------------------------------------------------------------------
// 本体

interface Piece {
  cpStart: number;
  cpEnd: number;
  fc: number;
  compressed: boolean;
  prm: number;
}

interface FkpRange {
  fcStart: number;
  fcEnd: number;
  /** grpprl の位置（WordDocument の中）。書式なしは -1 */
  start: number;
  end: number;
  istd: number;
}

export function readDoc(bytes: Uint8Array): DocModel {
  let cfb: CfbFile;
  try {
    cfb = new CfbFile(bytes);
  } catch (e) {
    throw new DocError(e instanceof CfbError ? e.message : "ファイルを読み込めませんでした。");
  }
  const wd = cfb.stream("WordDocument");
  if (!wd) {
    if (cfb.has("Workbook")) throw new DocError("このファイルはExcelのファイル（.xls）です。「Excel旧形式→新形式」で変換してください。");
    if (cfb.has("EncryptedPackage")) throw new DocError("パスワードで保護されたファイルです。Wordでパスワードを解除してから、お試しください。");
    throw new DocError("Wordのデータが見つかりません。.doc形式のファイルか、ご確認ください。");
  }
  if (wd.length < 0x200 || u16(wd, 0) !== 0xa5ec) throw new DocError("Word 97〜2003形式（.doc）のファイルではありません。");
  const nFib = u16(wd, 2);
  if (nFib < 0x00c1) throw new DocError("Word 6.0／95形式以前のファイルには対応していません。Word 97〜2003形式（.doc）で保存されたファイルをお使いください。");
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw new DocError("パスワードで保護されたファイルです。Wordでパスワードを解除してから、お試しください。");
  const table = cfb.stream(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) throw new DocError("ファイルが壊れています（書式の情報が見つかりません）。");
  const dataStream = cfb.stream("Data");

  // FIB：各部分の位置
  let p = 32;
  const csw = u16(wd, p);
  p += 2 + csw * 2;
  const cslw = u16(wd, p);
  const lw = p + 2;
  const ccpText = i32(wd, lw + 3 * 4);
  const ccpFtn = i32(wd, lw + 4 * 4);
  const ccpHdd = i32(wd, lw + 5 * 4);
  const ccpAtn = i32(wd, lw + 7 * 4);
  const ccpEdn = i32(wd, lw + 8 * 4);
  const ccpTxbx = i32(wd, lw + 9 * 4);
  const ccpHdrTxbx = i32(wd, lw + 10 * 4);
  p = lw + cslw * 4;
  const cbRgFcLcb = u16(wd, p);
  const fcl = p + 2;
  const fcLcb = (i: number): [number, number] => (i < cbRgFcLcb ? [u32(wd, fcl + i * 8), u32(wd, fcl + i * 8 + 4)] : [0, 0]);

  // 1. ピース（本文の文字の、ファイルの中の場所）
  const [fcClx, lcbClx] = fcLcb(33);
  const prcs: [number, number][] = [];
  const pieces: Piece[] = [];
  {
    let q = fcClx;
    const end = fcClx + lcbClx;
    while (q < end && table[q] === 0x01) {
      const cb = u16(table, q + 1);
      prcs.push([q + 3, q + 3 + cb]);
      q += 3 + cb;
    }
    if (table[q] !== 0x02) throw new DocError("ファイルが壊れています（本文の情報が見つかりません）。");
    const lcb = u32(table, q + 1);
    const plc = q + 5;
    const n = (lcb - 4) / 12;
    for (let i = 0; i < n; i++) {
      const cpStart = u32(table, plc + i * 4);
      const cpEnd = u32(table, plc + (i + 1) * 4);
      const pcd = plc + (n + 1) * 4 + i * 8;
      const fcRaw = u32(table, pcd + 2);
      const compressed = (fcRaw & 0x40000000) !== 0;
      pieces.push({ cpStart, cpEnd, fc: compressed ? (fcRaw & 0x3fffffff) / 2 : fcRaw, compressed, prm: u16(table, pcd + 6) });
    }
  }
  const totalCp = pieces.length ? pieces[pieces.length - 1].cpEnd : 0;
  const charAt = (cp: number): { ch: number; fc: number; piece: Piece } | null => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const pc = pieces[mid];
      if (cp < pc.cpStart) hi = mid - 1;
      else if (cp >= pc.cpEnd) lo = mid + 1;
      else {
        const off = cp - pc.cpStart;
        if (pc.compressed) {
          const fc = pc.fc + off;
          const raw = wd[fc];
          return { ch: CP1252[raw] ?? raw, fc, piece: pc };
        }
        const fc = pc.fc + off * 2;
        return { ch: u16(wd, fc), fc, piece: pc };
      }
    }
    return null;
  };

  // 2. 文字の書式（CHPX）と段落の書式（PAPX）の一覧
  const readBte = (index: number, isPap: boolean): FkpRange[] => {
    const [fc, lcb] = fcLcb(index);
    if (!lcb) return [];
    const n = (lcb - 4) / 8;
    const out: FkpRange[] = [];
    for (let i = 0; i < n; i++) {
      const pn = u32(table, fc + (n + 1) * 4 + i * 4) & 0x3fffff;
      const page = pn * 512;
      if (page + 512 > wd.length) continue;
      const crun = wd[page + 511];
      for (let j = 0; j < crun; j++) {
        const fcStart = u32(wd, page + j * 4);
        const fcEnd = u32(wd, page + (j + 1) * 4);
        if (isPap) {
          const bx = page + (crun + 1) * 4 + j * 13;
          const off = wd[bx] * 2;
          if (off === 0) {
            out.push({ fcStart, fcEnd, start: -1, end: -1, istd: 0 });
            continue;
          }
          let cb = wd[page + off];
          let start = page + off + 1;
          let size: number;
          if (cb === 0) {
            cb = wd[start];
            start += 1;
            size = cb * 2;
          } else size = cb * 2 - 1;
          out.push({ fcStart, fcEnd, start: start + 2, end: start + size, istd: u16(wd, start) });
        } else {
          const off = wd[page + (crun + 1) * 4 + j] * 2;
          if (off === 0) out.push({ fcStart, fcEnd, start: -1, end: -1, istd: 0 });
          else {
            const cb = wd[page + off];
            out.push({ fcStart, fcEnd, start: page + off + 1, end: page + off + 1 + cb, istd: 0 });
          }
        }
      }
    }
    return out.sort((a, b) => a.fcStart - b.fcStart);
  };
  const chpx = readBte(12, false);
  const papx = readBte(13, true);
  const findRange = (list: FkpRange[], fc: number): FkpRange | null => {
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = list[mid];
      if (fc < r.fcStart) hi = mid - 1;
      else if (fc >= r.fcEnd) lo = mid + 1;
      else return r;
    }
    return null;
  };

  // 3. フォントの名前
  const fonts: string[] = [];
  {
    const [fc, lcb] = fcLcb(15);
    if (lcb) {
      let q = fc;
      let count = u16(table, q);
      q += 2;
      if (count === 0xffff) {
        count = u16(table, q);
        q += 2;
      }
      q += 2; // cbExtra
      for (let i = 0; i < count && q < fc + lcb; i++) {
        const cch = table[q];
        const start = q + 1;
        let name = "";
        for (let k = start + 39; k + 1 < start + cch; k += 2) {
          const ch = u16(table, k);
          if (ch === 0) break;
          name += String.fromCharCode(ch);
        }
        fonts.push(name || "ＭＳ 明朝");
        q = start + cch;
      }
    }
  }

  // 4. スタイル
  const styles: DocStyle[] = [];
  const defaultFonts = { ascii: 0, eastAsia: 0, other: 0 };
  {
    const [fc, lcb] = fcLcb(1);
    if (lcb) {
      const cbStshi = u16(table, fc);
      const stshi = fc + 2;
      const cstd = u16(table, stshi);
      const cbBase = u16(table, stshi + 2);
      defaultFonts.ascii = u16(table, stshi + 12);
      defaultFonts.eastAsia = u16(table, stshi + 14);
      defaultFonts.other = u16(table, stshi + 16);
      let q = stshi + cbStshi;
      const raw: { istd: number; sti: number; stk: number; base: number; next: number; name: string; upx: [number, number, number][] }[] = [];
      for (let istd = 0; istd < cstd && q < fc + lcb; istd++) {
        const cbStd = u16(table, q);
        const s = q + 2;
        q = s + cbStd;
        if (cbStd === 0) continue;
        const sti = u16(table, s) & 0x0fff;
        const stk = u16(table, s + 2) & 0x000f;
        const base = u16(table, s + 2) >> 4;
        const cupx = u16(table, s + 4) & 0x000f;
        const next = u16(table, s + 4) >> 4;
        let r = s + cbBase;
        const cch = u16(table, r);
        let name = "";
        for (let k = 0; k < cch; k++) name += String.fromCharCode(u16(table, r + 2 + k * 2));
        r += 2 + cch * 2 + 2;
        const upx: [number, number, number][] = [];
        for (let k = 0; k < cupx && r < q; k++) {
          if ((r - s) % 2 === 1) r++;
          const cbUpx = u16(table, r);
          upx.push([k, r + 2, r + 2 + cbUpx]);
          r += 2 + cbUpx;
        }
        raw.push({ istd, sti, stk, base: base === 0x0fff ? -1 : base, next, name, upx });
      }
      for (const st of raw) {
        const para: ParaProps = {};
        const char: CharProps = {};
        const type = st.stk === 1 ? "paragraph" : st.stk === 2 ? "character" : st.stk === 3 ? "table" : "numbering";
        if (type === "paragraph") {
          const [, ps, pe] = st.upx[0] ?? [0, 0, 0];
          if (pe > ps + 2) applyGrpprl(table, ps + 2, pe, { para, dataStream });
          const [, cs, ce] = st.upx[1] ?? [0, 0, 0];
          if (ce > cs) applyGrpprl(table, cs, ce, { char, baseChar: {} });
        } else if (type === "character") {
          const [, cs, ce] = st.upx[0] ?? [0, 0, 0];
          if (ce > cs) applyGrpprl(table, cs, ce, { char, baseChar: {} });
        }
        styles.push({ istd: st.istd, sti: st.sti, name: st.name, type, basedOn: st.base >= 0 ? st.base : null, next: st.next, para, char });
      }
    }
  }
  const styleById = new Map(styles.map((s) => [s.istd, s]));
  /** スタイルの文字の書式を、元のスタイルまでたどって合わせる（太字などの切り替えの基準） */
  const resolvedCharCache = new Map<number, CharProps>();
  const resolvedStyleChar = (istd: number, depth = 0): CharProps => {
    const cached = resolvedCharCache.get(istd);
    if (cached) return cached;
    const st = styleById.get(istd);
    if (!st || depth > 20) return {};
    const base = st.basedOn !== null ? resolvedStyleChar(st.basedOn, depth + 1) : {};
    const out = { ...base, ...st.char };
    resolvedCharCache.set(istd, out);
    return out;
  };

  // 5. 箇条書き・段落番号
  const lists: DocList[] = [];
  const lfoToList: number[] = [];
  {
    const [fcLst, lcbLst] = fcLcb(73);
    if (lcbLst) {
      const cLst = u16(table, fcLst);
      const lstfs: { lsid: number; simple: boolean }[] = [];
      for (let i = 0; i < cLst; i++) {
        const q = fcLst + 2 + i * 28;
        lstfs.push({ lsid: i32(table, q), simple: (table[q + 26] & 0x01) !== 0 });
      }
      let q = fcLst + 2 + cLst * 28;
      for (const l of lstfs) {
        const levels: DocListLevel[] = [];
        const n = l.simple ? 1 : 9;
        for (let k = 0; k < n; k++) {
          const start = i32(table, q);
          const nfc = table[q + 4];
          const jcByte = table[q + 5] & 0x03;
          const nums = Array.from(table.subarray(q + 6, q + 15));
          const follow = table[q + 15];
          const cbChpx = table[q + 24];
          const cbPapx = table[q + 25];
          let r = q + 28;
          const para: ParaProps = {};
          const char: CharProps = {};
          applyGrpprl(table, r, r + cbPapx, { para });
          r += cbPapx;
          applyGrpprl(table, r, r + cbChpx, { char, baseChar: {} });
          r += cbChpx;
          const cch = u16(table, r);
          let text = "";
          for (let c = 0; c < cch; c++) {
            const ch = u16(table, r + 2 + c * 2);
            if (nums.includes(c + 1) && ch < 9) text += `%${ch + 1}`;
            else text += String.fromCharCode(ch);
          }
          r += 2 + cch * 2;
          levels.push({ start, nfc, text, jc: (["left", "center", "right"] as const)[jcByte] ?? "left", follow: follow === 1 ? "space" : follow === 2 ? "nothing" : "tab", para, char });
          q = r;
        }
        lists.push({ lsid: l.lsid, levels });
      }
    }
    const [fcLfo, lcbLfo] = fcLcb(74);
    if (lcbLfo) {
      const lfoMac = u32(table, fcLfo);
      for (let i = 0; i < lfoMac; i++) {
        const lsid = i32(table, fcLfo + 4 + i * 16);
        lfoToList.push(lists.findIndex((l) => l.lsid === lsid));
      }
    }
  }

  // 6. セクション
  const sections: SectProps[] = [];
  const sectionCps: number[] = [];
  {
    const [fc, lcb] = fcLcb(6);
    if (lcb) {
      const n = (lcb - 4) / 16;
      for (let i = 0; i < n; i++) {
        const cpEnd = u32(table, fc + (i + 1) * 4);
        const sed = fc + (n + 1) * 4 + i * 12;
        const fcSepx = i32(table, sed + 2);
        const sect = defaultSection();
        if (fcSepx !== -1 && fcSepx + 2 <= wd.length) {
          const cb = u16(wd, fcSepx);
          applyGrpprl(wd, fcSepx + 2, fcSepx + 2 + cb, { sect });
        }
        sections.push(sect);
        sectionCps.push(cpEnd);
      }
    }
    if (sections.length === 0) {
      sections.push(defaultSection());
      sectionCps.push(ccpText);
    }
  }

  // 7. フィールド・脚注・画像
  const unsupported: DocModel["unsupported"] = { floatingObjects: 0, textBoxes: 0, oleObjects: 0, nestedTables: 0, unknownImages: 0, revisions: 0, comments: 0, endnotes: 0, fields: 0 };
  if (ccpTxbx > 0 || ccpHdrTxbx > 0) unsupported.textBoxes = Math.max(1, (fcLcb(56)[1] - 4) / 26 | 0);
  if (ccpAtn > 0) unsupported.comments = Math.max(1, (fcLcb(4)[1] - 4) / 34 | 0);
  if (ccpEdn > 0) unsupported.endnotes = Math.max(1, (fcLcb(46)[1] - 4) / 6 | 0);
  const images: DocImage[] = [];
  const footnoteRefs: number[] = [];
  const footnoteTxt: number[] = [];
  {
    const [fcR, lcbR] = fcLcb(2);
    if (lcbR) {
      const n = (lcbR - 4) / 6;
      for (let i = 0; i < n; i++) footnoteRefs.push(u32(table, fcR + i * 4));
    }
    const [fcT, lcbT] = fcLcb(3);
    if (lcbT) {
      const n = (lcbT - 4) / 4;
      for (let i = 0; i <= n; i++) footnoteTxt.push(u32(table, fcT + i * 4));
    }
  }

  const readImage = (loc: number): number | null => {
    if (!dataStream || loc + 0x44 > dataStream.length) return null;
    const lcb = u32(dataStream, loc);
    const cbHeader = u16(dataStream, loc + 4);
    const mm = u16(dataStream, loc + 6);
    const end = Math.min(dataStream.length, loc + lcb);
    // 表示の大きさ（twip）と倍率（1/1000）・切り取り
    const dxaGoal = i16(dataStream, loc + 0x1c);
    const dyaGoal = i16(dataStream, loc + 0x1e);
    const mx = u16(dataStream, loc + 0x20) || 1000;
    const my = u16(dataStream, loc + 0x22) || 1000;
    const cropL = i16(dataStream, loc + 0x24);
    const cropT = i16(dataStream, loc + 0x26);
    const cropR = i16(dataStream, loc + 0x28);
    const cropB = i16(dataStream, loc + 0x2a);
    let q = loc + cbHeader;
    if (mm === 0x66) q += 1 + dataStream[q];
    // BLIP（画像のデータ）を探す
    for (; q + 8 <= end; ) {
      const recType = u16(dataStream, q + 2);
      const recLen = u32(dataStream, q + 4);
      const inst = u16(dataStream, q) >> 4;
      if (recType === 0xf004 || recType === 0xf003 || recType === 0xf001) {
        q += 8; // 入れ物の中へ
        continue;
      }
      if (recType === 0xf007) {
        q += 8 + 36; // FBSE の本体の後ろに BLIP が続く
        continue;
      }
      if (recType >= 0xf018 && recType <= 0xf117) {
        const body = q + 8;
        let ext: DocImage["ext"] | null = null;
        let data: Uint8Array | null = null;
        if (recType === 0xf01e || recType === 0xf01d || recType === 0xf02a) {
          const two = recType === 0xf01e ? inst === 0x6e1 : inst === 0x46b || inst === 0x6e3;
          const start = body + 16 + (two ? 16 : 0) + 1;
          data = dataStream.slice(start, body + recLen);
          ext = recType === 0xf01e ? "png" : "jpeg";
        } else if (recType === 0xf01a || recType === 0xf01b) {
          const two = recType === 0xf01a ? inst === 0x3d5 : inst === 0x217;
          const hdr = body + 16 + (two ? 16 : 0);
          const cbSave = u32(dataStream, hdr + 28);
          const compression = dataStream[hdr + 32];
          const raw = dataStream.subarray(hdr + 34, Math.min(body + recLen, hdr + 34 + cbSave));
          try {
            data = compression === 0 ? inflateZlib(raw) : raw.slice();
          } catch {
            data = null;
          }
          ext = recType === 0xf01a ? "emf" : "wmf";
          if (data && ext === "wmf") {
            data = withPlaceableHeader(data, i32(dataStream, hdr + 4), i32(dataStream, hdr + 8), i32(dataStream, hdr + 12), i32(dataStream, hdr + 16));
          }
        } else if (recType === 0xf01f) {
          const two = inst === 0x7a9;
          const start = body + 16 + (two ? 16 : 0) + 1;
          const dib = dataStream.subarray(start, body + recLen);
          data = dibToBmp(dib);
          ext = "bmp";
        }
        if (!data || !ext) {
          unsupported.unknownImages++;
          return null;
        }
        const wTw = Math.max(1, (dxaGoal * mx) / 1000 - ((cropL + cropR) * mx) / 1000);
        const hTw = Math.max(1, (dyaGoal * my) / 1000 - ((cropT + cropB) * my) / 1000);
        images.push({ bytes: data, ext, widthEmu: Math.round(wTw * 635), heightEmu: Math.round(hTw * 635) });
        return images.length - 1;
      }
      q += 8 + recLen;
    }
    unsupported.unknownImages++;
    return null;
  };

  // 8. 文字の範囲（CP）を、段落・表に組み立てる
  const footnoteIdByCp = new Map<number, number>();
  footnoteRefs.forEach((cp, i) => footnoteIdByCp.set(cp, i + 1));

  const charPropsAt = (fc: number, piece: Piece, istd: number): CharProps => {
    const baseChar = resolvedStyleChar(istd);
    const char: CharProps = {};
    const r = findRange(chpx, fc);
    if (r && r.start >= 0) applyGrpprl(wd, r.start, r.end, { char, baseChar });
    if (piece.prm & 0x01) {
      const prc = prcs[piece.prm >> 1];
      if (prc) applyGrpprl(table, prc[0], prc[1], { char, baseChar });
    }
    return char;
  };
  const paraPropsAt = (fc: number, piece: Piece): { para: ParaProps; row: TableRowProps } => {
    const para: ParaProps = {};
    const row: TableRowProps = { centers: [], cells: [] };
    const r = findRange(papx, fc);
    if (r) {
      para.istd = r.istd;
      if (r.start >= 0) applyGrpprl(wd, r.start, r.end, { para, row, dataStream });
    }
    if (piece.prm & 0x01) {
      const prc = prcs[piece.prm >> 1];
      if (prc) applyGrpprl(table, prc[0], prc[1], { para, row, dataStream });
    }
    return { para, row };
  };

  interface RawPara {
    props: ParaProps;
    row: TableRowProps;
    markProps: CharProps;
    inlines: Inline[];
    mark: number;
    cpEnd: number;
  }

  /** CP の範囲の文字を段落に分ける（フィールドは結果の文字だけ、PAGE・NUMPAGES はページ番号のフィールドにする） */
  const readParagraphs = (cpStart: number, cpEnd: number): RawPara[] => {
    const out: RawPara[] = [];
    // 先に、段落の終わりの位置と段落スタイルを調べる（太字などの切り替えは、段落スタイルを基準にするため）
    const markIstd: { cp: number; istd: number }[] = [];
    for (let cp = cpStart; cp < cpEnd; cp++) {
      const info = charAt(cp);
      if (!info) continue;
      if (info.ch === 0x0d || info.ch === 0x07 || (info.ch === 0x0c && sectionCps.includes(cp + 1))) {
        markIstd.push({ cp, istd: findRange(papx, info.fc)?.istd ?? 0 });
      }
    }
    let markIdx = 0;
    const istdFor = (cp: number) => {
      while (markIdx < markIstd.length && markIstd[markIdx].cp < cp) markIdx++;
      return markIdx < markIstd.length ? markIstd[markIdx].istd : 0;
    };
    let inlines: Inline[] = [];
    let text = "";
    let textProps: CharProps | null = null;
    let textKey = "";
    // フィールド：[instrの文字, 結果の中か]
    const fieldStack: { instr: string; inResult: boolean; resultInlines: number }[] = [];
    const flush = () => {
      if (text && textProps) inlines.push({ kind: "text", text, props: textProps });
      text = "";
      textProps = null;
      textKey = "";
    };
    const hidden = () => fieldStack.some((f) => !f.inResult);
    for (let cp = cpStart; cp < cpEnd; cp++) {
      const info = charAt(cp);
      if (!info) continue;
      const { ch, fc, piece } = info;
      const isParaEnd = ch === 0x0d || ch === 0x07 || (ch === 0x0c && sectionCps.includes(cp + 1));
      if (isParaEnd) {
        flush();
        const { para, row } = paraPropsAt(fc, piece);
        const markProps = charPropsAt(fc, piece, para.istd ?? 0);
        out.push({ props: para, row, markProps, inlines, mark: ch, cpEnd: cp + 1 });
        inlines = [];
        continue;
      }
      const props = charPropsAt(fc, piece, istdFor(cp));
      if (props.deleted) {
        unsupported.revisions++;
        continue;
      }
      if (ch === 0x13) {
        flush();
        fieldStack.push({ instr: "", inResult: false, resultInlines: inlines.length });
        unsupported.fields++;
        continue;
      }
      if (ch === 0x14 && fieldStack.length) {
        flush();
        const f = fieldStack[fieldStack.length - 1];
        f.inResult = true;
        f.resultInlines = inlines.length;
        continue;
      }
      if (ch === 0x15 && fieldStack.length) {
        flush();
        const f = fieldStack.pop()!;
        const name = f.instr.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
        if (name === "PAGE" || name === "NUMPAGES") {
          const resultText = inlines
            .slice(f.resultInlines)
            .map((i) => (i.kind === "text" ? i.text : ""))
            .join("");
          inlines.splice(f.resultInlines);
          inlines.push({ kind: "field", instr: name, result: resultText || "1", props });
          unsupported.fields--;
        } else if (!f.inResult) {
          // 結果のないフィールド（目次の印など）は何も出さない
        } else {
          unsupported.fields--;
        }
        continue;
      }
      if (fieldStack.length && !fieldStack[fieldStack.length - 1].inResult) {
        fieldStack[fieldStack.length - 1].instr += String.fromCharCode(ch);
        continue;
      }
      if (hidden()) continue;
      if (props.special) {
        if (ch === 0x01 && props.picLocation !== undefined && !props.ole2) {
          flush();
          const img = readImage(props.picLocation);
          if (img !== null) inlines.push({ kind: "image", image: img, props });
          continue;
        }
        if (ch === 0x01 || props.ole2) {
          unsupported.oleObjects++;
          continue;
        }
        if (ch === 0x08) {
          unsupported.floatingObjects++;
          continue;
        }
        if (ch === 0x02) {
          flush();
          const id = footnoteIdByCp.get(cp);
          if (id !== undefined && cpStart < ccpText) inlines.push({ kind: "footnoteRef", id, props });
          else inlines.push({ kind: "footnoteMark", props });
          continue;
        }
        if (props.symbol) {
          flush();
          inlines.push({ kind: "symbol", font: fonts[props.symbol.font] ?? "Symbol", char: props.symbol.char, props });
          continue;
        }
        if (ch < 0x20) continue;
      }
      if (ch === 0x09) {
        flush();
        inlines.push({ kind: "tab", props });
        continue;
      }
      if (ch === 0x0b) {
        flush();
        inlines.push({ kind: "break", type: "line", props });
        continue;
      }
      if (ch === 0x0c) {
        flush();
        inlines.push({ kind: "break", type: "page", props });
        continue;
      }
      if (ch === 0x0e) {
        flush();
        inlines.push({ kind: "break", type: "column", props });
        continue;
      }
      let c = ch;
      if (c === 0x1e) c = 0x2011; // 改行しないハイフン
      else if (c === 0x1f) continue; // 任意のハイフン
      else if (c === 0xa0) c = 0xa0;
      else if (c < 0x20) continue;
      const key = JSON.stringify(props);
      if (key !== textKey) {
        flush();
        textKey = key;
        textProps = props;
      }
      text += String.fromCharCode(c);
    }
    flush();
    if (inlines.length) out.push({ props: {}, row: { centers: [], cells: [] }, markProps: {}, inlines, mark: 0x0d, cpEnd });
    return out;
  };

  /** 段落の並びを、表と段落に組み立てる */
  const buildBlocks = (paras: RawPara[], withSections: boolean): DocBlock[] => {
    const blocks: DocBlock[] = [];
    let i = 0;
    const toPara = (rp: RawPara): DocParagraph => {
      const para: DocParagraph = { type: "p", props: rp.props, markProps: rp.markProps, inlines: rp.inlines };
      if (withSections) {
        const s = sectionCps.indexOf(rp.cpEnd);
        if (s >= 0 && s < sectionCps.length - 1) para.sectionEnd = s;
      }
      return para;
    };
    while (i < paras.length) {
      const rp = paras[i];
      if (!rp.props.inTable && !(rp.props.itap && rp.props.itap > 0)) {
        blocks.push(toPara(rp));
        i++;
        continue;
      }
      // 表：行の終わり（TTP）まで、セルの終わり（0x07）でセルを分ける
      const tbl: DocTable = { type: "table", rows: [] };
      let cells: DocBlock[][] = [];
      let cell: DocBlock[] = [];
      while (i < paras.length && (paras[i].props.inTable || (paras[i].props.itap ?? 0) > 0)) {
        const q = paras[i];
        if ((q.props.itap ?? 1) > 1) {
          // 入れ子の表：外側のセルの中の段落として入れる
          if (!q.props.innerTtp) cell.push({ type: "p", props: { ...q.props, inTable: false }, markProps: q.markProps, inlines: q.inlines });
          if (q.props.innerTtp) unsupported.nestedTables++;
          i++;
          continue;
        }
        if (q.props.ttp) {
          tbl.rows.push({ props: q.row, cells });
          cells = [];
          cell = [];
          i++;
          continue;
        }
        cell.push({ type: "p", props: { ...q.props, inTable: false }, markProps: q.markProps, inlines: q.inlines });
        if (q.mark === 0x07) {
          cells.push(cell);
          cell = [];
        }
        i++;
      }
      if (cells.length || cell.length) {
        if (cell.length) cells.push(cell);
        tbl.rows.push({ props: { centers: [], cells: [] }, cells });
      }
      if (tbl.rows.length) blocks.push(tbl);
    }
    return blocks;
  };

  const body = buildBlocks(readParagraphs(0, ccpText), true);

  // 脚注
  const footnotes = new Map<number, DocBlock[]>();
  // PlcffndTxt は、脚注の数＋2個の位置を持つ（最後の1つは区切り）。脚注の数は参照の数に合わせる
  for (let k = 0; k < footnoteRefs.length && k + 1 < footnoteTxt.length; k++) {
    const s = ccpText + footnoteTxt[k];
    const e = ccpText + footnoteTxt[k + 1];
    if (e > s) footnotes.set(k + 1, buildBlocks(readParagraphs(s, e), false));
  }

  // ヘッダー・フッター
  const headers: DocModel["headers"] = sections.map(() => ({ header: {}, footer: {} }));
  {
    const [fc, lcb] = fcLcb(11);
    if (lcb && ccpHdd > 0) {
      const n = lcb / 4;
      const cps: number[] = [];
      for (let i = 0; i < n; i++) cps.push(u32(table, fc + i * 4));
      const base = ccpText + ccpFtn;
      const story = (idx: number): DocBlock[] | null => {
        if (idx + 1 >= cps.length) return null;
        const s = cps[idx];
        const e = cps[idx + 1];
        if (e <= s) return null;
        const paras = readParagraphs(base + s, base + e);
        // 物語の最後の段落記号は区切りなので、空の最後の段落は除く
        if (paras.length > 1 && paras[paras.length - 1].inlines.length === 0) paras.pop();
        return buildBlocks(paras, false);
      };
      const prev: Record<string, DocBlock[] | null> = {};
      sections.forEach((_, si) => {
        const order: [keyof DocModel["headers"][number], "even" | "default" | "first"][] = [
          ["header", "even"],
          ["header", "default"],
          ["footer", "even"],
          ["footer", "default"],
          ["header", "first"],
          ["footer", "first"],
        ];
        order.forEach(([kind, type], k) => {
          const blocks = story(6 + si * 6 + k);
          const key = `${kind}-${type}`;
          // 空のときは、前のセクションのものを引き継ぐ（Wordの決まり）
          const use = blocks ?? prev[key] ?? null;
          if (use) headers[si][kind][type] = use;
          prev[key] = use;
        });
      });
    }
  }

  // 見開きページ（奇数・偶数で違うヘッダー）の設定
  let evenAndOddHeaders = false;
  {
    const [fc, lcb] = fcLcb(31);
    if (lcb >= 2) evenAndOddHeaders = (table[fc] & 0x01) !== 0;
  }
  void totalCp;

  return { body, sections, headers, footnotes, fonts, styles, defaultFonts, lists, lfoToList, images, evenAndOddHeaders, unsupported };
}

// ---------------------------------------------------------------------------
// 画像の形式の調整

/** zlib（deflate）を展開する（EMF・WMF は圧縮されて入っている） */
function inflateZlib(data: Uint8Array): Uint8Array {
  try {
    return unzlibSync(data);
  } catch {
    return inflateSync(data);
  }
}

/** WMF に「置き換え可能なヘッダー」（大きさの情報）が無いときは付ける（Word が画像の縦横の比を判断できるように） */
function withPlaceableHeader(wmf: Uint8Array, left: number, top: number, right: number, bottom: number): Uint8Array {
  if (u32(wmf, 0) === 0x9ac6cdd7) return wmf;
  const clamp = (v: number) => Math.max(-32768, Math.min(32767, v));
  const head = new Uint8Array(22);
  const v = new DataView(head.buffer);
  v.setUint32(0, 0x9ac6cdd7, true);
  v.setInt16(6, clamp(left), true);
  v.setInt16(8, clamp(top), true);
  v.setInt16(10, clamp(right > left ? right : left + 1000), true);
  v.setInt16(12, clamp(bottom > top ? bottom : top + 1000), true);
  v.setUint16(14, 1440, true);
  let sum = 0;
  for (let k = 0; k < 10; k++) sum ^= v.getUint16(k * 2, true);
  v.setUint16(20, sum, true);
  const out = new Uint8Array(22 + wmf.length);
  out.set(head);
  out.set(wmf, 22);
  return out;
}

/** DIB（BITMAPINFOHEADER から始まる画像）を、BMP ファイルにする */
function dibToBmp(dib: Uint8Array): Uint8Array {
  const headerSize = u32(dib, 0);
  const bitCount = u16(dib, 14);
  const clrUsed = u32(dib, 32);
  const colors = bitCount <= 8 ? clrUsed || 1 << bitCount : clrUsed;
  const offset = 14 + headerSize + colors * 4;
  const out = new Uint8Array(14 + dib.length);
  out[0] = 0x42;
  out[1] = 0x4d;
  const v = new DataView(out.buffer);
  v.setUint32(2, out.length, true);
  v.setUint32(10, offset, true);
  out.set(dib, 14);
  return out;
}
