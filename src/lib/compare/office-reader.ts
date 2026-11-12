import { unzipSync } from "fflate";

/**
 * Excel・Word比較（工程4）で使う、.xlsx・.docx の読み取り（読み取り専用。元のファイルは変更しない）。
 *
 * 既存の read-excel-file は、セルの値は取れるが、数式・非表示シート・セルの番地の情報が取れない。
 * mammoth（DOCX→HTML）は、表の行・段落の区切りが比較に向かない形になる。
 * そのため、既存ツール（src/lib/word/docx-text-ops.ts・src/lib/excel/ooxml-page-settings.ts）と同じく、
 * 既存の fflate（ZIPの展開）と、ブラウザ標準の DOMParser だけで、中のXMLを直接読む（新しい依存は追加しない）。
 */

export type OfficeKind = "xlsx" | "docx";

export type FileProblem = "legacy-or-protected" | "unsupported" | "broken";

/** 拡張子と、先頭のバイト（ZIPか、古い形式・暗号化の入れ物か）で、ファイルの種類を確かめる */
export async function detectOfficeKind(file: File): Promise<{ kind: OfficeKind; macro: boolean } | { problem: FileProblem; message: string }> {
  const name = file.name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isCfb = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1] ?? "";
  if (ext === "xls" || ext === "doc") {
    return {
      problem: "legacy-or-protected",
      message: `${file.name}：古い形式（.${ext}）は読み込めません。Excel・Wordで「.${ext}x」形式で保存し直してから選んでください。`,
    };
  }
  if (ext !== "xlsx" && ext !== "xlsm" && ext !== "docx") {
    return { problem: "unsupported", message: `${file.name}：対応している形式は、Excel（.xlsx・.xlsm）とWord（.docx）です。` };
  }
  if (isCfb) {
    return {
      problem: "legacy-or-protected",
      message: `${file.name}：パスワードで保護されたファイルか、拡張子と中身が違う古い形式のファイルのため、読み込めません。保護を外して保存し直してから選んでください。`,
    };
  }
  if (!isZip) {
    return { problem: "broken", message: `${file.name}：ファイルが壊れているか、Excel・Wordのファイルではないため、読み込めません。` };
  }
  return ext === "docx" ? { kind: "docx", macro: false } : { kind: "xlsx", macro: ext === "xlsm" };
}

function unzip(bytes: Uint8Array, fileName: string): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error(`${fileName}：ファイルが壊れているため、読み込めません。`);
  }
}

const decoder = new TextDecoder("utf-8");

function parseXml(bytes: Uint8Array | undefined, fileName: string): Document | null {
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`${fileName}：ファイルの中身を読み取れませんでした（壊れているか、対応していない形式の可能性があります）。`);
  }
  return doc;
}

/** 名前空間の接頭辞（x: など）が付いていても付いていなくても、要素の名前で探す */
function byLocal(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", local));
}

function childrenByLocal(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export type CellKind = "number" | "date" | "string" | "boolean" | "error";

export interface XlsxCell {
  /** 番地（例：B4） */
  ref: string;
  row: number; // 1始まり
  col: number; // 1始まり
  kind: CellKind;
  /** 数値・日付はExcelの数値（日付はシリアル値）、文字はその文字、真偽値は "TRUE"/"FALSE"、エラーは "#N/A" など */
  value: number | string;
  /** 数式（先頭の = は付けない）。数式でないセルは null */
  formula: string | null;
  /** 数式の計算結果がファイルに保存されていないとき true（その場合 value は空文字） */
  noCachedValue: boolean;
  /** 表示形式のコード（General など）。分かるときだけ */
  numFmt: string | null;
}

export interface XlsxSheetData {
  name: string;
  hidden: boolean;
  /** 値のあるセル（空欄は含まない） */
  cells: Map<string, XlsxCell>;
  maxRow: number;
  maxCol: number;
  mergeCount: number;
  /** 結合セルの範囲（"A1:B2" の形） */
  merges: string[];
}

export interface XlsxBook {
  sheets: XlsxSheetData[];
  macro: boolean;
  definedNameCount: number;
}

/** 1つのファイルで読み込むセルの上限（ブラウザのメモリを使いすぎないため） */
export const MAX_CELLS_PER_FILE = 400_000;

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_FORMAT_CODES: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "yyyy/m/d",
  22: "yyyy/m/d h:mm",
  49: "@",
};

/** 表示形式のコードが日付・時刻のものか（"..." や [Red] の中の文字は見ない） */
export function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[ymdhsge]/i.test(stripped.replace(/General/gi, "")) && !/^[#0.,%E+\-\s]*$/.test(stripped);
}

export function columnToLetters(col: number): string {
  let s = "";
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

function richText(si: Element): string {
  // <si><t>…</t></si> または <si><r><t>…</t></r>…</si>。ふりがな（rPh）の文字は含めない
  const parts: string[] = [];
  for (const t of byLocal(si, "t")) {
    let p: Element | null = t.parentElement;
    let inPhonetic = false;
    while (p && p !== si) {
      if (p.localName === "rPh") inPhonetic = true;
      p = p.parentElement;
    }
    if (!inPhonetic) parts.push(t.textContent ?? "");
  }
  return parts.join("");
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/");
  parts.pop();
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export async function readXlsxBook(file: File, macro: boolean): Promise<XlsxBook> {
  const entries = unzip(new Uint8Array(await file.arrayBuffer()), file.name);
  const workbook = parseXml(entries["xl/workbook.xml"], file.name);
  if (!workbook) throw new Error(`${file.name}：Excelのファイルとして読み取れませんでした（ブックの情報がありません）。`);
  const rels = parseXml(entries["xl/_rels/workbook.xml.rels"], file.name);
  const relTarget = new Map<string, string>();
  if (rels) {
    for (const r of byLocal(rels, "Relationship")) {
      relTarget.set(r.getAttribute("Id") ?? "", resolveTarget("xl/workbook.xml", r.getAttribute("Target") ?? ""));
    }
  }

  const shared: string[] = [];
  const sst = parseXml(entries["xl/sharedStrings.xml"], file.name);
  if (sst) for (const si of byLocal(sst, "si")) shared.push(richText(si));

  // スタイル番号 → 表示形式のコード
  const xfFormat: (string | null)[] = [];
  const styles = parseXml(entries["xl/styles.xml"], file.name);
  if (styles) {
    const custom = new Map<number, string>();
    for (const nf of byLocal(styles, "numFmt")) custom.set(Number(nf.getAttribute("numFmtId")), nf.getAttribute("formatCode") ?? "");
    const cellXfs = byLocal(styles, "cellXfs")[0];
    if (cellXfs) {
      for (const xf of childrenByLocal(cellXfs, "xf")) {
        const id = Number(xf.getAttribute("numFmtId") ?? "0");
        const code = custom.get(id) ?? BUILTIN_FORMAT_CODES[id] ?? (BUILTIN_DATE_FORMATS.has(id) ? "yyyy/m/d" : null);
        xfFormat.push(code);
      }
    }
  }

  const definedNameCount = byLocal(workbook, "definedName").filter((d) => !(d.getAttribute("name") ?? "").startsWith("_xlnm.")).length;
  const sheets: XlsxSheetData[] = [];
  let totalCells = 0;
  for (const sheetEl of byLocal(workbook, "sheet")) {
    const name = sheetEl.getAttribute("name") ?? `Sheet${sheets.length + 1}`;
    const state = sheetEl.getAttribute("state");
    const rid = sheetEl.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? sheetEl.getAttribute("r:id") ?? "";
    const path = relTarget.get(rid);
    const xml = path ? parseXml(entries[path], file.name) : null;
    const cells = new Map<string, XlsxCell>();
    let maxRow = 0;
    let maxCol = 0;
    let mergeCount = 0;
    const merges: string[] = [];
    if (xml) {
      mergeCount = byLocal(xml, "mergeCell").length;
      for (const mc of byLocal(xml, "mergeCell")) {
        const ref = mc.getAttribute("ref");
        if (ref && ref.includes(":")) merges.push(ref);
      }
      // 共有数式（<f t="shared" si="0" ref="…">）は、元の数式の文字だけを使う（番地をずらした数式は作らない）
      const sharedFormulas = new Map<string, string>();
      for (const c of byLocal(xml, "c")) {
        const ref = c.getAttribute("r");
        const pos = ref ? parseRef(ref) : null;
        if (!ref || !pos) continue;
        const fEl = childrenByLocal(c, "f")[0];
        let formula: string | null = null;
        if (fEl) {
          const text = fEl.textContent ?? "";
          const si = fEl.getAttribute("si");
          if (fEl.getAttribute("t") === "shared" && si !== null) {
            if (text) sharedFormulas.set(si, text);
            formula = text || (sharedFormulas.get(si) ? `${sharedFormulas.get(si)}（共有数式）` : "（共有数式）");
          } else {
            formula = text || null;
          }
        }
        const t = c.getAttribute("t") ?? "n";
        const vEl = childrenByLocal(c, "v")[0];
        const raw = vEl?.textContent ?? null;
        const styleIndex = Number(c.getAttribute("s") ?? "0");
        const numFmt = xfFormat[styleIndex] ?? null;
        let kind: CellKind = "string";
        let value: number | string = "";
        if (t === "s") {
          value = raw !== null ? (shared[Number(raw)] ?? "") : "";
        } else if (t === "inlineStr") {
          const is = childrenByLocal(c, "is")[0];
          value = is ? richText(is) : "";
        } else if (t === "str") {
          value = raw ?? "";
        } else if (t === "b") {
          kind = "boolean";
          value = raw === "1" ? "TRUE" : "FALSE";
        } else if (t === "e") {
          kind = "error";
          value = raw ?? "#ERROR";
        } else if (raw !== null && raw !== "") {
          const n = Number(raw);
          kind = numFmt && isDateFormatCode(numFmt) ? "date" : "number";
          value = Number.isFinite(n) ? n : raw;
          if (!Number.isFinite(n)) kind = "string";
        }
        const noCachedValue = formula !== null && (raw === null || raw === "") && t !== "inlineStr";
        // 値も数式もない（書式だけの）セルは、空欄として扱う。空の文字（""）も空欄とする
        if (formula === null && (value === "" || value === null)) continue;
        if (noCachedValue) kind = "string";
        cells.set(ref, { ref, row: pos.row, col: pos.col, kind, value, formula, noCachedValue, numFmt });
        if (pos.row > maxRow) maxRow = pos.row;
        if (pos.col > maxCol) maxCol = pos.col;
        totalCells++;
        if (totalCells > MAX_CELLS_PER_FILE) {
          throw new Error(
            `${file.name}：値の入ったセルが多すぎます（${MAX_CELLS_PER_FILE.toLocaleString("ja-JP")}個まで）。シートを分けるか、比べる範囲だけを別のファイルにしてから選んでください。`
          );
        }
      }
    }
    sheets.push({ name, hidden: state === "hidden" || state === "veryHidden", cells, maxRow, maxCol, mergeCount, merges });
  }
  if (sheets.length === 0) throw new Error(`${file.name}：読み取れるシートがありません。`);
  return { sheets, macro, definedNameCount };
}

/** Excelのシリアル値を「2026/10/01」「2026/10/01 9:30」の形にする（1900年の日付系） */
export function serialToDateText(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const date = `${y}/${mo}/${da}`;
  return h === 0 && mi === 0 ? date : `${date} ${h}:${String(mi).padStart(2, "0")}`;
}

/** 比較・表示に使う、セルの値の文字（数値はそのまま、日付は yyyy/mm/dd） */
export function cellValueText(cell: XlsxCell): string {
  if (cell.noCachedValue) return "";
  if (cell.kind === "date" && typeof cell.value === "number") return serialToDateText(cell.value);
  if (typeof cell.value === "number") return String(cell.value);
  return cell.value;
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

export type DocxBlock =
  | { kind: "paragraph"; text: string; headingLevel: number | null; heading: string | null }
  | { kind: "table"; tableIndex: number; rows: string[][]; heading: string | null };

export interface DocxContent {
  blocks: DocxBlock[];
  hasHeaderFooter: boolean;
  hasFootnotes: boolean;
  hasComments: boolean;
  hasTrackedChanges: boolean;
  imageCount: number;
}

function runText(el: Element): string {
  // 段落・セルの中を、出てくる順にたどる（w:t の文字、タブ、改行）。削除の変更履歴（w:delText）は含めない
  let out = "";
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const ln = child.localName;
      if (ln === "t") out += child.textContent ?? "";
      else if (ln === "tab") out += "\t";
      else if (ln === "br" || ln === "cr") out += "\n";
      else if (ln === "noBreakHyphen") out += "-";
      else if (ln === "Fallback" || ln === "delText" || ln === "instrText" || ln === "rPr" || ln === "pPr") continue;
      else walk(child);
    }
  };
  walk(el);
  return out;
}

function headingLevelOf(p: Element, styleNames: Map<string, string>): number | null {
  const pPr = childrenByLocal(p, "pPr")[0];
  if (!pPr) return null;
  const outline = childrenByLocal(pPr, "outlineLvl")[0];
  const styleId = childrenByLocal(pPr, "pStyle")[0]?.getAttribute("w:val") ?? null;
  const name = styleId ? (styleNames.get(styleId) ?? styleId) : "";
  const m = /^(?:heading|見出し)\s*(\d)$/i.exec(name.replace(/\s+/g, " ").trim()) ?? /^heading(\d)$/i.exec(styleId ?? "");
  if (m) return Number(m[1]);
  if (name.toLowerCase() === "title" || name === "表題") return 0;
  if (outline) {
    const v = Number(outline.getAttribute("w:val"));
    if (Number.isFinite(v) && v < 9) return v + 1;
  }
  return null;
}

function hasText(entries: Record<string, Uint8Array>, pattern: RegExp): boolean {
  return Object.keys(entries).some((k) => {
    if (!pattern.test(k)) return false;
    const xml = decoder.decode(entries[k]);
    return /<w:t[ >][^<]*\S/.test(xml);
  });
}

export async function readDocxContent(file: File): Promise<DocxContent> {
  const entries = unzip(new Uint8Array(await file.arrayBuffer()), file.name);
  const doc = parseXml(entries["word/document.xml"], file.name);
  if (!doc) throw new Error(`${file.name}：Wordの文書として読み取れませんでした（本文がありません）。`);
  const body = byLocal(doc, "body")[0];
  if (!body) throw new Error(`${file.name}：Wordの本文が見つかりませんでした。`);

  const styleNames = new Map<string, string>();
  const styles = parseXml(entries["word/styles.xml"], file.name);
  if (styles) {
    for (const s of byLocal(styles, "style")) {
      const id = s.getAttribute("w:styleId") ?? "";
      const nameEl = childrenByLocal(s, "name")[0];
      if (id && nameEl) styleNames.set(id, nameEl.getAttribute("w:val") ?? id);
    }
  }

  const blocks: DocxBlock[] = [];
  let tableIndex = 0;
  let currentHeading: string | null = null;
  const visit = (container: Element) => {
    for (const el of Array.from(container.children)) {
      const ln = el.localName;
      if (ln === "p") {
        const text = runText(el);
        const level = headingLevelOf(el, styleNames);
        if (level !== null && text.trim() !== "") currentHeading = text.trim();
        blocks.push({ kind: "paragraph", text, headingLevel: level, heading: level !== null ? null : currentHeading });
      } else if (ln === "tbl") {
        tableIndex++;
        const rows: string[][] = [];
        for (const tr of childrenByLocal(el, "tr")) {
          const cells: string[] = [];
          for (const tc of childrenByLocal(tr, "tc")) {
            cells.push(
              childrenByLocal(tc, "p")
                .map((p) => runText(p))
                .concat(childrenByLocal(tc, "tbl").map((t) => runText(t)))
                .join("\n")
            );
          }
          rows.push(cells);
        }
        blocks.push({ kind: "table", tableIndex, rows, heading: currentHeading });
      } else if (ln === "sdt") {
        const content = childrenByLocal(el, "sdtContent")[0];
        if (content) visit(content);
      } else if (ln === "customXml") {
        visit(el);
      }
    }
  };
  visit(body);

  return {
    blocks,
    hasHeaderFooter: hasText(entries, /^word\/(header|footer)\d*\.xml$/),
    hasFootnotes: hasText(entries, /^word\/(footnotes|endnotes)\.xml$/),
    hasComments: !!entries["word/comments.xml"] && hasText(entries, /^word\/comments\.xml$/),
    hasTrackedChanges: byLocal(doc, "ins").length + byLocal(doc, "del").length > 0,
    imageCount: byLocal(doc, "drawing").length + byLocal(doc, "pict").length,
  };
}
