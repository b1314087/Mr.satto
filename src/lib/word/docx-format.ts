import { unzipSync } from "fflate";

/**
 * DOCX（word/document.xml・styles.xml 等）から、段落・文字・表・ヘッダー/フッターの「書式」を
 * 直接読み取る（Word→PDFの再現度向上）。
 *
 * mammoth（DOCX→HTML）は内容（文字・見出し・リスト・画像・リンク）は読めるが、
 * 中央/右揃え・文字サイズ・文字色・蛍光ペン・取り消し線・上付き/下付き・字下げ・タブ位置・
 * 段落の枠線と背景色・表のセル結合/背景色/列幅・ヘッダー/フッターは読み捨てる。
 * ここでは、それらを word/*.xml から直接読み、スタイルの継承（既定値 → 段落スタイル →
 * 文字スタイル → 直接指定）も解決した「最終的な書式」にして返す。
 *
 * 読み取りに失敗しても例外は投げず、「情報なし」（null/空）を返す。呼び出し側は必ず
 * 従来の描画（書式なし）にフォールバックする。
 */

const TWIPS_PER_PT = 20;
const DEFAULT_TAB_PT = 36;

export interface RunFmt {
  sizePt: number | null;
  /** 6桁の16進（#なし）。自動色はnull */
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 蛍光ペン・文字の背景色（6桁の16進）。無ければnull */
  highlight: string | null;
  script: "super" | "sub" | null;
  hidden: boolean;
}

export interface TabStopFmt {
  posPt: number;
  kind: "left" | "right" | "center" | "decimal";
}

export interface BorderFmt {
  widthPt: number;
  color: string | null;
}

export interface ParaBorders {
  top: BorderFmt | null;
  bottom: BorderFmt | null;
  left: BorderFmt | null;
  right: BorderFmt | null;
}

export interface ParaFmt {
  align: "left" | "center" | "right" | "justify" | null;
  leftPt: number | null;
  rightPt: number | null;
  /** 1行目の字下げ（正）・ぶら下げ（負）。pt */
  firstLinePt: number | null;
  beforePt: number | null;
  afterPt: number | null;
  lineRule: "auto" | "exact" | "atLeast" | null;
  /** auto: 240を1行とする値、exact/atLeast: pt */
  lineValue: number | null;
  fill: string | null;
  borders: ParaBorders | null;
  tabs: TabStopFmt[];
  /** この段落で使う既定の文字サイズ（空の段落の高さの計算に使う） */
  baseSizePt: number | null;
  /** 段落スタイルのID（「同じスタイルの段落の間は間隔を空けない」の判定に使う） */
  styleId: string | null;
  /** 同じスタイルの段落の間に、段落の前後の間隔を入れない（w:contextualSpacing） */
  contextual: boolean;
  /** 文字ごとの書式つきの文字列（タブは \t、改行は \n） */
  runs: { text: string; fmt: RunFmt }[];
}

export interface CellFmt {
  gridSpan: number;
  vMerge: "restart" | "continue" | null;
  fill: string | null;
  vAlign: "top" | "center" | "bottom";
  paragraphs: ParaFmt[];
  /** セルに直接指定された罫線（undefined=指定なし、null=罫線なし） */
  borders: { top?: BorderFmt | null; bottom?: BorderFmt | null; left?: BorderFmt | null; right?: BorderFmt | null };
}

export interface RowFmt {
  cells: CellFmt[];
  heightPt: number | null;
  isHeader: boolean;
}

export interface TableBorders {
  top: BorderFmt | null;
  bottom: BorderFmt | null;
  left: BorderFmt | null;
  right: BorderFmt | null;
  insideH: BorderFmt | null;
  insideV: BorderFmt | null;
}

export interface TableFmt {
  gridPt: number[];
  rows: RowFmt[];
  indentPt: number;
  borders: TableBorders;
  align: "left" | "center" | "right";
  cellPadLeftPt: number;
  cellPadRightPt: number;
}

export interface HeaderFooterFmt {
  paragraphs: ParaFmt[];
}

export type HeaderFooterKind = "default" | "first" | "even";

export interface SectionRefs {
  headers: Partial<Record<HeaderFooterKind, string>>;
  footers: Partial<Record<HeaderFooterKind, string>>;
  titlePg: boolean;
  headerDistancePt: number;
  footerDistancePt: number;
}

export type BodyFmt = { tag: "p"; para: ParaFmt } | { tag: "tbl"; table: TableFmt | null };

export interface DocxFormatting {
  body: BodyFmt[];
  defaultTabPt: number;
  evenAndOdd: boolean;
  headers: Partial<Record<HeaderFooterKind, HeaderFooterFmt>>;
  footers: Partial<Record<HeaderFooterKind, HeaderFooterFmt>>;
  refs: SectionRefs | null;
}

/** ページ番号・総ページ数をヘッダー/フッターの文字列へ埋め込むための目印の文字 */
export const PAGE_NUMBER_CHAR = "";
export const PAGE_COUNT_CHAR = "";

// ---------------------------------------------------------------------------
// XML ヘルパー
// ---------------------------------------------------------------------------
function kids(el: Element | null | undefined, tag: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (const c of Array.from(el.children)) if (c.tagName === tag) out.push(c);
  return out;
}
function kid(el: Element | null | undefined, tag: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return null;
}
function attr(el: Element | null | undefined, name: string): string | null {
  return el ? el.getAttribute(name) : null;
}
/** OOXMLの真偽値（属性なし=true、"0"/"false"/"off"=false） */
function onOff(el: Element | null | undefined): boolean | null {
  if (!el) return null;
  const v = el.getAttribute("w:val");
  if (v === null) return true;
  return !(v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off");
}
function num(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function hex(v: string | null): string | null {
  if (!v || v === "auto") return null;
  return /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: "FFFF00",
  green: "00FF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
  blue: "0000FF",
  red: "FF0000",
  darkBlue: "000080",
  darkCyan: "008080",
  darkGreen: "008000",
  darkMagenta: "800080",
  darkRed: "800000",
  darkYellow: "808000",
  darkGray: "808080",
  lightGray: "C0C0C0",
  black: "000000",
  white: "FFFFFF",
};

// ---------------------------------------------------------------------------
// 書式（部分指定）
// ---------------------------------------------------------------------------
type RunPartial = Partial<RunFmt>;
type ParaPartial = Partial<Omit<ParaFmt, "runs" | "tabs" | "baseSizePt" | "styleId">> & { tabs?: TabStopFmt[]; tabClears?: number[] };

function parseRPr(rPr: Element | null): RunPartial {
  const out: RunPartial = {};
  if (!rPr) return out;
  const b = onOff(kid(rPr, "w:b"));
  if (b !== null) out.bold = b;
  const i = onOff(kid(rPr, "w:i"));
  if (i !== null) out.italic = i;
  const u = kid(rPr, "w:u");
  if (u) out.underline = (u.getAttribute("w:val") ?? "single") !== "none";
  const s = onOff(kid(rPr, "w:strike")) ?? onOff(kid(rPr, "w:dstrike"));
  if (s !== null) out.strike = s;
  const col = kid(rPr, "w:color");
  if (col) out.color = hex(col.getAttribute("w:val"));
  const sz = num(attr(kid(rPr, "w:sz"), "w:val"));
  if (sz !== null && sz > 0) out.sizePt = sz / 2;
  const hl = kid(rPr, "w:highlight");
  if (hl) {
    const name = hl.getAttribute("w:val") ?? "";
    out.highlight = name === "none" ? null : (HIGHLIGHT[name] ?? null);
  } else {
    const shd = kid(rPr, "w:shd");
    if (shd) {
      const fill = hex(shd.getAttribute("w:fill"));
      if (fill && fill !== "FFFFFF") out.highlight = fill;
    }
  }
  const va = attr(kid(rPr, "w:vertAlign"), "w:val");
  if (va === "superscript") out.script = "super";
  else if (va === "subscript") out.script = "sub";
  else if (va === "baseline") out.script = null;
  const vanish = onOff(kid(rPr, "w:vanish"));
  if (vanish !== null) out.hidden = vanish;
  return out;
}

function parseBorder(el: Element | null): BorderFmt | null | undefined {
  if (!el) return undefined;
  const val = el.getAttribute("w:val");
  if (!val || val === "nil" || val === "none") return null;
  const sz = num(el.getAttribute("w:sz"));
  return { widthPt: Math.max(0.25, (sz ?? 4) / 8), color: hex(el.getAttribute("w:color")) };
}

function parsePPr(pPr: Element | null, sizeForChars: number): ParaPartial {
  const out: ParaPartial = {};
  if (!pPr) return out;
  const jc = attr(kid(pPr, "w:jc"), "w:val");
  if (jc) {
    if (jc === "center") out.align = "center";
    else if (jc === "right" || jc === "end") out.align = "right";
    else if (jc === "both" || jc === "distribute" || jc === "thaiDistribute" || jc === "justify") out.align = "justify";
    else out.align = "left";
  }
  const ind = kid(pPr, "w:ind");
  if (ind) {
    const left = num(ind.getAttribute("w:left") ?? ind.getAttribute("w:start"));
    const leftChars = num(ind.getAttribute("w:leftChars") ?? ind.getAttribute("w:startChars"));
    if (left !== null) out.leftPt = left / TWIPS_PER_PT;
    else if (leftChars !== null) out.leftPt = (leftChars / 100) * sizeForChars;
    const right = num(ind.getAttribute("w:right") ?? ind.getAttribute("w:end"));
    const rightChars = num(ind.getAttribute("w:rightChars") ?? ind.getAttribute("w:endChars"));
    if (right !== null) out.rightPt = right / TWIPS_PER_PT;
    else if (rightChars !== null) out.rightPt = (rightChars / 100) * sizeForChars;
    const first = num(ind.getAttribute("w:firstLine"));
    const firstChars = num(ind.getAttribute("w:firstLineChars"));
    const hang = num(ind.getAttribute("w:hanging"));
    const hangChars = num(ind.getAttribute("w:hangingChars"));
    if (hang !== null && hang > 0) out.firstLinePt = -hang / TWIPS_PER_PT;
    else if (hangChars !== null && hangChars > 0) out.firstLinePt = -(hangChars / 100) * sizeForChars;
    else if (first !== null) out.firstLinePt = first / TWIPS_PER_PT;
    else if (firstChars !== null) out.firstLinePt = (firstChars / 100) * sizeForChars;
  }
  const sp = kid(pPr, "w:spacing");
  if (sp) {
    const before = num(sp.getAttribute("w:before"));
    const after = num(sp.getAttribute("w:after"));
    const beforeLines = num(sp.getAttribute("w:beforeLines"));
    const afterLines = num(sp.getAttribute("w:afterLines"));
    if (sp.getAttribute("w:beforeAutospacing") !== "1") {
      if (before !== null) out.beforePt = before / TWIPS_PER_PT;
      else if (beforeLines !== null) out.beforePt = (beforeLines / 100) * sizeForChars;
    }
    if (sp.getAttribute("w:afterAutospacing") !== "1") {
      if (after !== null) out.afterPt = after / TWIPS_PER_PT;
      else if (afterLines !== null) out.afterPt = (afterLines / 100) * sizeForChars;
    }
    const line = num(sp.getAttribute("w:line"));
    if (line !== null) {
      const rule = sp.getAttribute("w:lineRule");
      if (rule === "exact" || rule === "atLeast") {
        out.lineRule = rule;
        out.lineValue = line / TWIPS_PER_PT;
      } else {
        out.lineRule = "auto";
        out.lineValue = line;
      }
    }
  }
  const ctx = onOff(kid(pPr, "w:contextualSpacing"));
  if (ctx !== null) out.contextual = ctx;
  const shd = kid(pPr, "w:shd");
  if (shd) {
    const fill = hex(shd.getAttribute("w:fill"));
    out.fill = fill;
  }
  const bdr = kid(pPr, "w:pBdr");
  if (bdr) {
    const b: ParaBorders = { top: null, bottom: null, left: null, right: null };
    let any = false;
    for (const [side, tag] of [
      ["top", "w:top"],
      ["bottom", "w:bottom"],
      ["left", "w:left"],
      ["right", "w:right"],
    ] as const) {
      const parsed = parseBorder(kid(bdr, tag));
      if (parsed) {
        b[side] = parsed;
        any = true;
      }
    }
    out.borders = any ? b : null;
  }
  const tabsEl = kid(pPr, "w:tabs");
  if (tabsEl) {
    const tabs: TabStopFmt[] = [];
    const clears: number[] = [];
    for (const t of kids(tabsEl, "w:tab")) {
      const pos = num(t.getAttribute("w:pos"));
      if (pos === null) continue;
      const val = t.getAttribute("w:val") ?? "left";
      if (val === "clear") clears.push(pos / TWIPS_PER_PT);
      else if (val === "right" || val === "end") tabs.push({ posPt: pos / TWIPS_PER_PT, kind: "right" });
      else if (val === "center") tabs.push({ posPt: pos / TWIPS_PER_PT, kind: "center" });
      else if (val === "decimal") tabs.push({ posPt: pos / TWIPS_PER_PT, kind: "decimal" });
      else if (val === "left" || val === "start") tabs.push({ posPt: pos / TWIPS_PER_PT, kind: "left" });
    }
    out.tabs = tabs;
    out.tabClears = clears;
  }
  return out;
}

// ---------------------------------------------------------------------------
// styles.xml
// ---------------------------------------------------------------------------
interface StyleDef {
  id: string;
  type: string;
  basedOn: string | null;
  isDefault: boolean;
  pPr: Element | null;
  rPr: Element | null;
  tblPr: Element | null;
}

interface StyleSheet {
  styles: Map<string, StyleDef>;
  defaultParaStyle: string | null;
  docRPr: Element | null;
  docPPr: Element | null;
}

function parseStyles(xmlText: string | null): StyleSheet {
  const sheet: StyleSheet = { styles: new Map(), defaultParaStyle: null, docRPr: null, docPPr: null };
  if (!xmlText) return sheet;
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return sheet;
  const dd = doc.getElementsByTagName("w:docDefaults")[0];
  if (dd) {
    sheet.docRPr = kid(kid(dd, "w:rPrDefault"), "w:rPr");
    sheet.docPPr = kid(kid(dd, "w:pPrDefault"), "w:pPr");
  }
  for (const s of Array.from(doc.getElementsByTagName("w:style"))) {
    const id = s.getAttribute("w:styleId");
    if (!id) continue;
    const def: StyleDef = {
      id,
      type: s.getAttribute("w:type") ?? "paragraph",
      basedOn: attr(kid(s, "w:basedOn"), "w:val"),
      isDefault: s.getAttribute("w:default") === "1",
      pPr: kid(s, "w:pPr"),
      rPr: kid(s, "w:rPr"),
      tblPr: kid(s, "w:tblPr"),
    };
    sheet.styles.set(id, def);
    if (def.type === "paragraph" && def.isDefault) sheet.defaultParaStyle = id;
  }
  return sheet;
}

/** スタイルの継承の鎖（基になるスタイル → 自分の順） */
function styleChain(sheet: StyleSheet, id: string | null): StyleDef[] {
  const chain: StyleDef[] = [];
  const seen = new Set<string>();
  let cur = id ? sheet.styles.get(id) : undefined;
  while (cur && !seen.has(cur.id) && chain.length < 12) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.basedOn ? sheet.styles.get(cur.basedOn) : undefined;
  }
  return chain;
}

const BASE_RUN: RunFmt = { sizePt: null, color: null, bold: false, italic: false, underline: false, strike: false, highlight: null, script: null, hidden: false };

function mergeRun(base: RunFmt, over: RunPartial): RunFmt {
  const out = { ...base };
  for (const k of Object.keys(over) as (keyof RunFmt)[]) {
    const v = over[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function mergePara(base: ParaPartial, over: ParaPartial): ParaPartial {
  const out: ParaPartial = { ...base };
  for (const k of Object.keys(over) as (keyof ParaPartial)[]) {
    if (k === "tabs" || k === "tabClears") continue;
    const v = over[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  if (over.tabs || over.tabClears) {
    let tabs = [...(base.tabs ?? [])];
    for (const c of over.tabClears ?? []) tabs = tabs.filter((t) => Math.abs(t.posPt - c) > 0.5);
    tabs = [...tabs, ...(over.tabs ?? [])];
    out.tabs = tabs;
  }
  return out;
}

class Resolver {
  constructor(private readonly sheet: StyleSheet) {}

  docRun(): RunFmt {
    return mergeRun(BASE_RUN, parseRPr(this.sheet.docRPr));
  }

  /** 段落スタイルまで解決した、その段落の既定の文字書式（表の中の段落は、表スタイルの指定も反映する） */
  paraStyleRun(styleId: string | null, tableStyleId: string | null = null): RunFmt {
    let run = this.docRun();
    for (const s of styleChain(this.sheet, tableStyleId)) run = mergeRun(run, parseRPr(s.rPr));
    for (const s of styleChain(this.sheet, styleId ?? this.sheet.defaultParaStyle)) run = mergeRun(run, parseRPr(s.rPr));
    return run;
  }

  /** 優先順位: 文書の既定 < 表スタイル < 段落スタイル < 段落への直接指定 */
  paraProps(styleId: string | null, direct: Element | null, sizePt: number, tableStyleId: string | null = null): ParaPartial {
    let p: ParaPartial = parsePPr(this.sheet.docPPr, sizePt);
    for (const s of styleChain(this.sheet, tableStyleId)) p = mergePara(p, parsePPr(s.pPr, sizePt));
    for (const s of styleChain(this.sheet, styleId ?? this.sheet.defaultParaStyle)) p = mergePara(p, parsePPr(s.pPr, sizePt));
    return mergePara(p, parsePPr(direct, sizePt));
  }

  charStyleRun(styleId: string | null): RunPartial {
    let out: RunPartial = {};
    for (const s of styleChain(this.sheet, styleId)) out = { ...out, ...parseRPr(s.rPr) };
    return out;
  }

  tableBorders(styleId: string | null, direct: Element | null): TableBorders {
    const out: TableBorders = { top: null, bottom: null, left: null, right: null, insideH: null, insideV: null };
    const apply = (bordersEl: Element | null) => {
      if (!bordersEl) return;
      const map: [keyof TableBorders, string[]][] = [
        ["top", ["w:top"]],
        ["bottom", ["w:bottom"]],
        ["left", ["w:left", "w:start"]],
        ["right", ["w:right", "w:end"]],
        ["insideH", ["w:insideH"]],
        ["insideV", ["w:insideV"]],
      ];
      for (const [key, tags] of map) {
        for (const tag of tags) {
          const parsed = parseBorder(kid(bordersEl, tag));
          if (parsed !== undefined) out[key] = parsed;
        }
      }
    };
    for (const s of styleChain(this.sheet, styleId)) apply(kid(s.tblPr, "w:tblBorders"));
    apply(kid(direct, "w:tblBorders"));
    return out;
  }
}

// ---------------------------------------------------------------------------
// 段落
// ---------------------------------------------------------------------------
type FieldMode = "result" | "placeholder";

function readParagraph(pEl: Element, rs: Resolver, mode: FieldMode, tableStyleId: string | null = null): ParaFmt {
  const pPr = kid(pEl, "w:pPr");
  const styleId = attr(kid(pPr, "w:pStyle"), "w:val");
  const baseRun = rs.paraStyleRun(styleId, tableStyleId);
  const baseSize = baseRun.sizePt ?? 10.5;
  const props = rs.paraProps(styleId, pPr, baseSize, tableStyleId);

  const runs: { text: string; fmt: RunFmt }[] = [];
  const push = (text: string, fmt: RunFmt) => {
    if (text === "" || fmt.hidden) return;
    const last = runs[runs.length - 1];
    if (last && JSON.stringify(last.fmt) === JSON.stringify(fmt)) last.text += text;
    else runs.push({ text, fmt });
  };

  // 複雑なフィールド（ページ番号など）の状態
  const fieldStack: { instr: string; phase: "instr" | "result"; skip: boolean; emitted: boolean }[] = [];

  const readRun = (r: Element) => {
    const rPr = kid(r, "w:rPr");
    const charStyle = attr(kid(rPr, "w:rStyle"), "w:val");
    const fmt = mergeRun(mergeRun(baseRun, rs.charStyleRun(charStyle)), parseRPr(rPr));
    for (const c of Array.from(r.children)) {
      switch (c.tagName) {
        case "w:fldChar": {
          const t = c.getAttribute("w:fldCharType");
          if (t === "begin") fieldStack.push({ instr: "", phase: "instr", skip: false, emitted: false });
          else if (t === "separate") {
            const f = fieldStack[fieldStack.length - 1];
            if (f) {
              f.phase = "result";
              if (mode === "placeholder") {
                const instr = f.instr.trim().toUpperCase();
                if (/^PAGE\b/.test(instr)) {
                  push(PAGE_NUMBER_CHAR, fmt);
                  f.skip = true;
                  f.emitted = true;
                } else if (/^NUMPAGES\b/.test(instr)) {
                  push(PAGE_COUNT_CHAR, fmt);
                  f.skip = true;
                  f.emitted = true;
                }
              }
            }
          } else if (t === "end") {
            const f = fieldStack.pop();
            // 結果の部分（separate）が無いフィールド: 終わりの時点で目印を入れる
            if (f && mode === "placeholder" && !f.emitted) {
              const instr = f.instr.trim().toUpperCase();
              if (/^PAGE\b/.test(instr)) push(PAGE_NUMBER_CHAR, fmt);
              else if (/^NUMPAGES\b/.test(instr)) push(PAGE_COUNT_CHAR, fmt);
            }
          }
          break;
        }
        case "w:instrText": {
          const f = fieldStack[fieldStack.length - 1];
          if (f && f.phase === "instr") f.instr += c.textContent ?? "";
          break;
        }
        case "w:t": {
          if (fieldStack.some((f) => f.skip || f.phase === "instr")) break;
          push(c.textContent ?? "", fmt);
          break;
        }
        case "w:tab":
        case "w:ptab":
          if (fieldStack.some((f) => f.skip)) break;
          push("\t", fmt);
          break;
        case "w:br": {
          const type = c.getAttribute("w:type");
          if (type === "page" || type === "column") break;
          push("\n", fmt);
          break;
        }
        case "w:cr":
          push("\n", fmt);
          break;
        case "w:noBreakHyphen":
          push("-", fmt);
          break;
        default:
          break;
      }
    }
  };

  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      switch (c.tagName) {
        case "w:r":
          readRun(c);
          break;
        case "w:hyperlink":
        case "w:ins":
        case "w:smartTag":
        case "w:sdt":
        case "w:sdtContent":
        case "w:customXml":
        case "w:fldSimple": {
          if (c.tagName === "w:fldSimple" && mode === "placeholder") {
            const instr = (c.getAttribute("w:instr") ?? "").trim().toUpperCase();
            const rPr = kid(kid(c, "w:r"), "w:rPr");
            const fmt = mergeRun(baseRun, parseRPr(rPr));
            if (/^PAGE\b/.test(instr)) {
              push(PAGE_NUMBER_CHAR, fmt);
              break;
            }
            if (/^NUMPAGES\b/.test(instr)) {
              push(PAGE_COUNT_CHAR, fmt);
              break;
            }
          }
          walk(c);
          break;
        }
        default:
          break;
      }
    }
  };
  walk(pEl);

  return {
    align: props.align ?? null,
    leftPt: props.leftPt ?? null,
    rightPt: props.rightPt ?? null,
    firstLinePt: props.firstLinePt ?? null,
    beforePt: props.beforePt ?? null,
    afterPt: props.afterPt ?? null,
    lineRule: props.lineRule ?? null,
    lineValue: props.lineValue ?? null,
    fill: props.fill ?? null,
    borders: props.borders ?? null,
    tabs: props.tabs ?? [],
    baseSizePt: baseRun.sizePt,
    styleId,
    contextual: props.contextual ?? false,
    runs,
  };
}

// ---------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------
function readTable(tbl: Element, rs: Resolver): TableFmt | null {
  const tblPr = kid(tbl, "w:tblPr");
  const styleId = attr(kid(tblPr, "w:tblStyle"), "w:val");
  const borders = rs.tableBorders(styleId, tblPr);
  const grid = kids(kid(tbl, "w:tblGrid"), "w:gridCol")
    .map((g) => (num(g.getAttribute("w:w")) ?? 0) / TWIPS_PER_PT)
    .filter((w) => w >= 0);
  if (grid.length === 0) return null;
  const jc = attr(kid(tblPr, "w:jc"), "w:val");
  const indent = (num(attr(kid(tblPr, "w:tblInd"), "w:w")) ?? 0) / TWIPS_PER_PT;
  const mar = kid(tblPr, "w:tblCellMar");
  const padL = (num(attr(kid(mar, "w:left") ?? kid(mar, "w:start"), "w:w")) ?? 108) / TWIPS_PER_PT;
  const padR = (num(attr(kid(mar, "w:right") ?? kid(mar, "w:end"), "w:w")) ?? 108) / TWIPS_PER_PT;

  const rows: RowFmt[] = [];
  for (const tr of kids(tbl, "w:tr")) {
    const trPr = kid(tr, "w:trPr");
    const h = num(attr(kid(trPr, "w:trHeight"), "w:val"));
    const cells: CellFmt[] = [];
    for (const tc of kids(tr, "w:tc")) {
      const tcPr = kid(tc, "w:tcPr");
      const span = Math.max(1, num(attr(kid(tcPr, "w:gridSpan"), "w:val")) ?? 1);
      const vm = kid(tcPr, "w:vMerge");
      const vMerge: CellFmt["vMerge"] = vm ? (vm.getAttribute("w:val") === "restart" ? "restart" : "continue") : null;
      const shd = kid(tcPr, "w:shd");
      const va = attr(kid(tcPr, "w:vAlign"), "w:val");
      const cb = kid(tcPr, "w:tcBorders");
      const cellBorders: CellFmt["borders"] = {};
      if (cb) {
        for (const [side, tags] of [
          ["top", ["w:top"]],
          ["bottom", ["w:bottom"]],
          ["left", ["w:left", "w:start"]],
          ["right", ["w:right", "w:end"]],
        ] as const) {
          for (const tag of tags) {
            const parsed = parseBorder(kid(cb, tag));
            if (parsed !== undefined) cellBorders[side] = parsed;
          }
        }
      }
      const paragraphs: ParaFmt[] = [];
      for (const p of kids(tc, "w:p")) paragraphs.push(readParagraph(p, rs, "result", styleId));
      cells.push({
        gridSpan: span,
        vMerge,
        fill: shd ? hex(shd.getAttribute("w:fill")) : null,
        vAlign: va === "center" ? "center" : va === "bottom" ? "bottom" : "top",
        paragraphs,
        borders: cellBorders,
      });
    }
    rows.push({ cells, heightPt: h !== null ? h / TWIPS_PER_PT : null, isHeader: !!kid(trPr, "w:tblHeader") });
  }
  if (rows.length === 0) return null;
  return {
    gridPt: grid,
    rows,
    indentPt: indent,
    borders,
    align: jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : "left",
    cellPadLeftPt: padL,
    cellPadRightPt: padR,
  };
}

// ---------------------------------------------------------------------------
// セクション（ヘッダー/フッターの参照）
// ---------------------------------------------------------------------------
function readSectionRefs(sectPr: Element): SectionRefs {
  const refs: SectionRefs = { headers: {}, footers: {}, titlePg: false, headerDistancePt: 36, footerDistancePt: 36 };
  const pgMar = kid(sectPr, "w:pgMar");
  const hd = num(attr(pgMar, "w:header"));
  const fd = num(attr(pgMar, "w:footer"));
  if (hd !== null) refs.headerDistancePt = hd / TWIPS_PER_PT;
  if (fd !== null) refs.footerDistancePt = fd / TWIPS_PER_PT;
  refs.titlePg = onOff(kid(sectPr, "w:titlePg")) === true;
  for (const [tag, target] of [
    ["w:headerReference", refs.headers],
    ["w:footerReference", refs.footers],
  ] as const) {
    for (const r of kids(sectPr, tag)) {
      const type = (r.getAttribute("w:type") ?? "default") as HeaderFooterKind;
      const id = r.getAttribute("r:id");
      if (id && (type === "default" || type === "first" || type === "even")) target[type] = id;
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const EMPTY: DocxFormatting = { body: [], defaultTabPt: DEFAULT_TAB_PT, evenAndOdd: false, headers: {}, footers: {}, refs: null };

/** DOCXから書式を読み取る。失敗した場合は空の結果（呼び出し側は従来の描画に戻る）。 */
export function parseDocxFormatting(arrayBuffer: ArrayBuffer): DocxFormatting {
  try {
    const entries = unzipSync(new Uint8Array(arrayBuffer), {
      filter: (info) =>
        info.name === "word/document.xml" ||
        info.name === "word/styles.xml" ||
        info.name === "word/settings.xml" ||
        info.name === "word/_rels/document.xml.rels" ||
        /^word\/(header|footer)\d*\.xml$/.test(info.name),
    });
    const text = (name: string) => (entries[name] ? new TextDecoder("utf-8").decode(entries[name]) : null);
    const docText = text("word/document.xml");
    if (!docText) return EMPTY;
    const parser = new DOMParser();
    const doc = parser.parseFromString(docText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return EMPTY;
    const body = doc.getElementsByTagName("w:body")[0];
    if (!body) return EMPTY;

    const rs = new Resolver(parseStyles(text("word/styles.xml")));

    let defaultTabPt = DEFAULT_TAB_PT;
    let evenAndOdd = false;
    const settingsText = text("word/settings.xml");
    if (settingsText) {
      const sd = parser.parseFromString(settingsText, "application/xml");
      const dt = num(attr(sd.getElementsByTagName("w:defaultTabStop")[0] ?? null, "w:val"));
      if (dt !== null && dt > 0) defaultTabPt = dt / TWIPS_PER_PT;
      evenAndOdd = onOff(sd.getElementsByTagName("w:evenAndOddHeaders")[0] ?? null) === true;
    }

    const bodyFmt: BodyFmt[] = [];
    for (const child of Array.from(body.children)) {
      if (child.tagName === "w:p") bodyFmt.push({ tag: "p", para: readParagraph(child, rs, "result") });
      else if (child.tagName === "w:tbl") {
        let table: TableFmt | null = null;
        try {
          table = readTable(child, rs);
        } catch {
          table = null;
        }
        bodyFmt.push({ tag: "tbl", table });
      }
    }

    // 最初のセクションの設定（段落内のsectPrが先にあればそれ、無ければ末尾のsectPr）
    const firstSectPr =
      Array.from(body.getElementsByTagName("w:sectPr")).find((s) => s.parentElement?.tagName === "w:pPr") ??
      kids(body, "w:sectPr")[0] ??
      null;
    let refs: SectionRefs | null = null;
    const headers: DocxFormatting["headers"] = {};
    const footers: DocxFormatting["footers"] = {};
    if (firstSectPr) {
      refs = readSectionRefs(firstSectPr);
      const relsText = text("word/_rels/document.xml.rels");
      const targets = new Map<string, string>();
      if (relsText) {
        const rd = parser.parseFromString(relsText, "application/xml");
        for (const r of Array.from(rd.getElementsByTagName("Relationship"))) {
          const id = r.getAttribute("Id");
          const t = r.getAttribute("Target");
          if (id && t) targets.set(id, t.replace(/^\/?(word\/)?/, "word/"));
        }
      }
      const load = (rid: string | undefined): HeaderFooterFmt | undefined => {
        if (!rid) return undefined;
        const target = targets.get(rid);
        const partText = target ? text(target) : null;
        if (!partText) return undefined;
        const pd = parser.parseFromString(partText, "application/xml");
        if (pd.getElementsByTagName("parsererror").length > 0) return undefined;
        const root = pd.documentElement;
        const paragraphs = kids(root, "w:p").map((p) => readParagraph(p, rs, "placeholder"));
        return paragraphs.length > 0 ? { paragraphs } : undefined;
      };
      for (const k of ["default", "first", "even"] as const) {
        const h = load(refs.headers[k]);
        if (h) headers[k] = h;
        const f = load(refs.footers[k]);
        if (f) footers[k] = f;
      }
    }
    return { body: bodyFmt, defaultTabPt, evenAndOdd, headers, footers, refs };
  } catch {
    return EMPTY;
  }
}
