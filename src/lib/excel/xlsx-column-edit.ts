import { unzipSync, zipSync, type Zippable } from "fflate";
import { cellValueText, columnToLetters, readXlsxBook } from "@/lib/compare/office-reader";

/**
 * Excel（.xlsx）の列編集（工程3：CSV列編集のExcel対応）。
 *
 * read-excel-file / write-excel-file で読み直して書き出すと、ブック全体の書式・数式・ほかのシートまで作り直しになり、
 * 「対象外のシートやデータを維持する」ことができない。そのため、既存の Excel・Word の処理
 * （src/lib/word/docx-text-ops.ts・src/lib/compare/office-reader.ts）と同じく、既存の fflate（ZIP）と
 * ブラウザ標準の DOMParser / XMLSerializer だけで、選んだシートのXMLだけを書き換える（新しい依存は追加しない）。
 *
 * - 書き換えるのは、選んだシート（xl/worksheets/sheetN.xml）と、必要なときだけブックの名前の定義・計算の順番の情報。
 *   ほかのシート・書式（styles.xml）・共有文字列・画像などのファイルは、バイト列のまま保持する。
 * - セルの値（数値・日付・文字・真偽値）と書式（スタイル番号）は、そのままの形で新しい位置へ移す（文字への変換はしない）。
 * - 数式はできるだけ数式のまま残す。行・列の位置が変わるときは、数式の中のセル参照を新しい位置に合わせて書き直す
 *   （adjustFormula。編集したシートの数式と、ほかのシートの数式のうち編集したシートを参照しているもの）。
 *   安全に書き直せない数式（参照先が削除された・範囲の中の並びが変わる・INDIRECT など位置に依存する関数を使う 等）だけを、
 *   計算結果の値に置き換え、その数を知らせる。位置が変わらない（列名の変更だけの）ときは、数式には触れない。
 * - 列の幅・セルの結合・条件付き書式・入力規則・ハイパーリンク・オートフィルターなどの範囲は、新しい位置に合わせる
 *   （結合やオートフィルターが、削除・並び替えで1つの範囲にならないときは外し、その数を知らせる）。
 * - Excelの「テーブル」・メモ（コメント）があるシートで行・列の位置を変えることには対応しない（テーブルの定義・メモの位置を
 *   正しく直せないため。理由を表示して止める）。画像・グラフの位置は直さないため、その旨を知らせる。
 * 処理はすべてブラウザの中で行い、ファイルは送信しない。
 */

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

export interface XlsxEditSheet {
  name: string;
  hidden: boolean;
  /** 表示用の値（文字）。1行目〜最後の行、A列〜最後の列。数式は計算結果の値、日付は yyyy/mm/dd */
  rows: string[][];
  formulaCount: number;
}

/** プレビュー・列の一覧用に、ブックの全シートの値を読む（元のファイルは変更しない） */
export async function loadXlsxForColumnEdit(file: File): Promise<XlsxEditSheet[]> {
  const book = await readXlsxBook(file, false);
  return book.sheets.map((sheet) => {
    const rows: string[][] = Array.from({ length: sheet.maxRow }, () => Array.from({ length: sheet.maxCol }, () => ""));
    let formulaCount = 0;
    for (const cell of sheet.cells.values()) {
      rows[cell.row - 1][cell.col - 1] = cellValueText(cell);
      if (cell.formula !== null) formulaCount++;
    }
    return { name: sheet.name, hidden: sheet.hidden, rows, formulaCount };
  });
}

export interface XlsxColumnEditInput {
  file: File;
  /** 編集するシートの番号（0始まり。loadXlsxForColumnEdit の並び） */
  sheetIndex: number;
  /** 残す列の元の番号（0始まり）を、出力したい順に並べたもの。含めなかった列は削除する */
  columnOrder: number[];
  /** 元の列の番号 → 新しい見出し名（見出しありのときだけ。見出しの行＝対象の範囲の最初の行） */
  renames?: Record<number, string>;
  hasHeader: boolean;
  /** 対象にする行の範囲（1始まり・両端を含む）。範囲外の行は出力に含めない。省略時はすべて */
  rowStart?: number;
  rowEnd?: number;
}

/** 数式の扱いの結果（画面で、数式のまま残した数と、値に置き換えた数をはっきり知らせるために使う） */
export interface XlsxFormulaReport {
  /** 編集したシートで、数式のまま残した数（参照先を新しい位置に合わせて調整したものを含む） */
  kept: number;
  /** 編集したシートで、参照先を安全に調整できないため、計算結果の値に置き換えた数 */
  converted: number;
  /** 値に置き換えたもののうち、計算結果がファイルに保存されていなかったため空欄になった数 */
  convertedEmpty: number;
  /** ほかのシートで、このシートへの参照を新しい位置に合わせて調整した数式の数 */
  otherAdjusted: number;
  /** ほかのシートで、このシートへの参照を安全に調整できないため、値に置き換えた数式の数 */
  otherConverted: number;
}

export interface XlsxColumnEditOutput {
  blob: Blob;
  rowCount: number;
  columnCount: number;
  /** 利用者に知らせること（外した結合の数など） */
  notices: string[];
  /** 数式の扱い（行・列の位置が変わらないときは null） */
  formulas: XlsxFormulaReport | null;
}

// ---------------------------------------------------------------------------
// 番地・範囲の変換（DOMを使わない純粋な関数。テストしやすいように分けている）
// ---------------------------------------------------------------------------

interface CellPos {
  row: number; // 1始まり
  col: number; // 1始まり
}

export function letterToColumn(letters: string): number {
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

export function parseCellRef(ref: string): CellPos | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { col: letterToColumn(m[1]), row: Number(m[2]) };
}

export function toCellRef(pos: CellPos): string {
  return `${columnToLetters(pos.col)}${pos.row}`;
}

/** 行・列の対応（元の番号 → 新しい番号。削除するものは null） */
export interface AxisMaps {
  row: (r: number) => number | null;
  col: (c: number) => number | null;
}

/** 元の連続した番号 a..b を、新しい番号の「連続した区間」の並びにする（削除・並び替えで分かれる） */
export function mapRuns(a: number, b: number, map: (n: number) => number | null): [number, number][] {
  const mapped: number[] = [];
  for (let n = a; n <= b; n++) {
    const m = map(n);
    if (m !== null) mapped.push(m);
  }
  mapped.sort((x, y) => x - y);
  const runs: [number, number][] = [];
  for (const m of mapped) {
    const last = runs[runs.length - 1];
    if (last && m === last[1] + 1) last[1] = m;
    else if (!last || m !== last[1]) runs.push([m, m]);
  }
  return runs;
}

/** 範囲（"A1"・"A1:C3"）を、新しい位置の範囲の並びにする。読めない形の範囲は null（そのまま残す） */
export function remapRange(range: string, maps: AxisMaps): string[] | null {
  const parts = range.split(":");
  const a = parseCellRef(parts[0]);
  const b = parts.length === 2 ? parseCellRef(parts[1]) : a;
  if (!a || !b || parts.length > 2) return null;
  const rowRuns = mapRuns(Math.min(a.row, b.row), Math.max(a.row, b.row), maps.row);
  const colRuns = mapRuns(Math.min(a.col, b.col), Math.max(a.col, b.col), maps.col);
  const out: string[] = [];
  for (const [r1, r2] of rowRuns) {
    for (const [c1, c2] of colRuns) {
      const start = toCellRef({ row: r1, col: c1 });
      const end = toCellRef({ row: r2, col: c2 });
      out.push(start === end ? start : `${start}:${end}`);
    }
  }
  return out;
}

/** 空白区切りの範囲の並び（sqref）を変換する。すべて消えたら空文字 */
export function remapSqref(sqref: string, maps: AxisMaps): string {
  const out: string[] = [];
  for (const part of sqref.trim().split(/\s+/).filter(Boolean)) {
    const mapped = remapRange(part, maps);
    if (mapped === null) out.push(part);
    else out.push(...mapped);
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// 数式の中のセル参照の書き直し（DOMを使わない純粋な関数）
// ---------------------------------------------------------------------------

export interface FormulaAdjustContext {
  maps: AxisMaps;
  /** 編集したシートの名前 */
  sheetName: string;
  /** 接頭辞（シート名!）のない参照が、編集したシートを指すか（編集したシートの数式なら true） */
  localIsEdited: boolean;
  /** 共有数式（下へのコピーなど）を1つずつの数式に戻すときの、元の数式からのずれ（相対参照だけをずらす） */
  shift?: { rows: number; cols: number };
}

export type FormulaAdjustResult = { ok: true; text: string } | { ok: false; reason: string };

/** 位置そのものに依存する関数（行・列を動かすと結果が変わる、または参照を文字で持つため直せない） */
const POSITION_DEPENDENT_FUNCTIONS = /(^|[^A-Za-z0-9_.])(INDIRECT|OFFSET|ROW|COLUMN|CELL|ADDRESS|INFO|GETPIVOTDATA|FORMULATEXT)\s*\(/i;

const MAX_ROW = 1_048_576;
const MAX_COL = 16_384;

interface RefPart {
  colAbs: boolean;
  col: number | null;
  rowAbs: boolean;
  row: number | null;
}

function parsePart(text: string): RefPart | null {
  const m = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d+)?$/.exec(text);
  if (!m || (!m[2] && !m[4])) return null;
  if (m[2] && !m[4] && m[3]) return null; // 「A$」のような形は無い
  return {
    colAbs: m[2] ? m[1] === "$" : false,
    col: m[2] ? letterToColumn(m[2]) : null,
    rowAbs: m[4] ? (m[2] ? m[3] === "$" : m[1] === "$") : false,
    row: m[4] ? Number(m[4]) : null,
  };
}

function formatPart(p: RefPart): string {
  return `${p.col !== null ? `${p.colAbs ? "$" : ""}${columnToLetters(p.col)}` : ""}${p.row !== null ? `${p.rowAbs ? "$" : ""}${p.row}` : ""}`;
}

/** a..b のすべてが、並びを保ったまま、連続した新しい番号に移るか（ずれるだけか）。移る先の始まりを返す */
function translatedStart(a: number, b: number, map: (n: number) => number | null): number | null {
  const start = map(a);
  if (start === null) return null;
  for (let n = a + 1; n <= b; n++) {
    if (map(n) !== start + (n - a)) return null;
  }
  return start;
}

function unquoteSheet(prefix: string): string {
  return prefix.startsWith("'") ? prefix.slice(1, -1).replace(/''/g, "'") : prefix;
}

/** 文字列（"…"）の外側だけを取り出す（関数名・角かっこの確認用） */
function outsideStrings(formula: string): string {
  return formula.replace(/"(?:[^"]|"")*"/g, '""');
}

/**
 * 数式の中のセル参照を、行・列の新しい位置に合わせて書き直す。
 * 安全に書き直せるのは、参照するセル・範囲が「そのまま新しい位置へずれるだけ」のとき（削除されず、範囲の中の並びも変わらない）。
 * そうでない参照（削除されたセル、並び替え・削除で中身が変わる範囲）や、位置に依存する関数・テーブルの参照（角かっこ）を
 * 含む数式は、書き直さずに ok: false を返す（呼び出し側で計算結果の値に置き換える）。ほかのシートへの参照は変えない。
 */
export function adjustFormula(formula: string, ctx: FormulaAdjustContext): FormulaAdjustResult {
  const outside = outsideStrings(formula);
  if (outside.includes("[")) return { ok: false, reason: "テーブル・外部ブックの参照" };
  if (POSITION_DEPENDENT_FUNCTIONS.test(outside)) return { ok: false, reason: "位置に依存する関数" };
  const shift = ctx.shift ?? { rows: 0, cols: 0 };
  const target = ctx.sheetName.toLowerCase();
  const refRe =
    /(?:('(?:[^']|'')+'|[^\s'!:"(),+\-*/^&=<>;{}%\[\]]+)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![A-Za-z0-9_(.!])/y;
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') {
      const m = /"(?:[^"]|"")*"/y;
      m.lastIndex = i;
      const sm = m.exec(formula);
      const len = sm ? sm[0].length : formula.length - i;
      out += formula.slice(i, i + len);
      i += len;
      continue;
    }
    const prev = i > 0 ? formula[i - 1] : "";
    if (prev === "" || !/[A-Za-z0-9_.$#\u0080-\uFFFF]/.test(prev)) {
      refRe.lastIndex = i;
      const m = refRe.exec(formula);
      if (m) {
        const prefix = m[1];
        const parts = m[2].split(":").map(parsePart);
        if (parts.some((p) => p === null)) return { ok: false, reason: "読めない参照" };
        const refParts = parts as RefPart[];
        // 1) 共有数式を戻すときは、相対参照をずらす（シートに関係なく）
        for (const p of refParts) {
          if (p.col !== null && !p.colAbs) p.col += shift.cols;
          if (p.row !== null && !p.rowAbs) p.row += shift.rows;
          if ((p.col !== null && (p.col < 1 || p.col > MAX_COL)) || (p.row !== null && (p.row < 1 || p.row > MAX_ROW))) {
            return { ok: false, reason: "範囲外の参照" };
          }
        }
        // 2) 編集したシートへの参照だけを、新しい位置に合わせる
        const pointsToEdited = prefix ? unquoteSheet(prefix).toLowerCase() === target : ctx.localIsEdited;
        if (pointsToEdited) {
          const a = refParts[0];
          const b = refParts[1] ?? refParts[0];
          if (a.col !== null && b.col !== null) {
            const c1 = Math.min(a.col, b.col);
            const start = translatedStart(c1, Math.max(a.col, b.col), ctx.maps.col);
            if (start === null) return { ok: false, reason: "削除・並び替えされた列への参照" };
            const delta = start - c1;
            a.col += delta;
            if (b !== a) b.col! += delta;
          }
          if (a.row !== null && b.row !== null) {
            const r1 = Math.min(a.row, b.row);
            const start = translatedStart(r1, Math.max(a.row, b.row), ctx.maps.row);
            if (start === null) return { ok: false, reason: "削除された行への参照" };
            const delta = start - r1;
            a.row += delta;
            if (b !== a) b.row! += delta;
          }
        }
        out += (prefix ? `${prefix}!` : "") + refParts.map(formatPart).join(":");
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { ok: true, text: out };
}

// ---------------------------------------------------------------------------
// XML の補助
// ---------------------------------------------------------------------------

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function parseXml(bytes: Uint8Array | undefined, what: string): Document {
  if (!bytes) throw new Error(`Excelファイルの中に${what}が見つかりませんでした（壊れているか、対応していない形式の可能性があります）`);
  const doc = new DOMParser().parseFromString(decoder.decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Excelファイルの${what}を読み取れませんでした（壊れているか、対応していない形式の可能性があります）`);
  }
  return doc;
}

function serialize(doc: Document, original: Uint8Array): Uint8Array {
  const text = new XMLSerializer().serializeToString(doc);
  const decl = /^<\?xml[^>]*\?>/.exec(decoder.decode(original.subarray(0, 200)))?.[0] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return encoder.encode(text.startsWith("<?xml") ? text : `${decl}\n${text}`);
}

function byLocal(root: Element | Document, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", local));
}

function childrenByLocal(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
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

/** シート名を、数式の中の書き方（'シート 1'! または Sheet1!）にする */
function sheetRefPatterns(name: string): string[] {
  const quoted = `'${name.replace(/'/g, "''")}'!`;
  // 空白や記号を含まない名前（日本語の名前を含む）は、引用符なしでも書ける
  return /^[^\s'!\[\]:*?/\\\-+,()&^=<>;{}%$#@"0-9][^\s'!\[\]:*?/\\\-+,()&^=<>;{}%$#@"]*$/u.test(name) ? [quoted, `${name}!`] : [quoted];
}

/** 数式のセルを、計算結果の値だけのセルにする（計算結果が保存されていなければ空欄）。空欄になったら true */
function convertFormulaCellToValue(doc: Document, c: Element, f: Element): boolean {
  c.removeChild(f);
  const v = childrenByLocal(c, "v")[0];
  if (!v || (v.textContent ?? "") === "") {
    if (v) c.removeChild(v);
    c.removeAttribute("t");
    return true;
  }
  if (c.getAttribute("t") === "str") {
    // 数式の結果の文字は、数式なしのセルでは「文字」として持つ
    const text = v.textContent ?? "";
    c.removeChild(v);
    c.setAttribute("t", "inlineStr");
    const is = doc.createElementNS(MAIN_NS, "is");
    const t = doc.createElementNS(MAIN_NS, "t");
    t.setAttributeNS(XML_NS, "xml:space", "preserve");
    t.textContent = text;
    is.appendChild(t);
    c.appendChild(is);
  }
  return false;
}

interface SheetFormulaResult {
  /** 書き直して数式のまま残した数（edited のときは、触れずに残した数も含む） */
  kept: number;
  /** 実際に参照を書き直した数 */
  adjusted: number;
  converted: number;
  convertedEmpty: number;
}

/**
 * 1つのシートの数式を、新しい位置に合わせて書き直す（セルを動かす前の、元の番地のまま呼ぶ）。
 * - edited=true（編集したシート）：すべての数式を対象にする。配列数式の範囲（ref）も新しい位置に合わせる。
 * - edited=false（ほかのシート）：編集したシートを参照している数式だけを対象にする。
 * 共有数式（下へのコピーなど）は、対象になったグループを1つずつの数式に戻してから書き直す。
 * 安全に書き直せない数式は、計算結果の値に置き換える。
 */
function processSheetFormulas(doc: Document, maps: AxisMaps, sheetName: string, edited: boolean): SheetFormulaResult {
  const result: SheetFormulaResult = { kept: 0, adjusted: 0, converted: 0, convertedEmpty: 0 };
  const patterns = sheetRefPatterns(sheetName).map((p) => p.toLowerCase());
  const refersToEdited = (text: string) => edited || patterns.some((p) => text.toLowerCase().includes(p));
  const cells = byLocal(doc, "c");
  // 共有数式の元の数式（si → 文字・番地）
  const masters = new Map<string, { text: string; row: number; col: number }>();
  for (const c of cells) {
    const f = childrenByLocal(c, "f")[0];
    const pos = parseCellRef(c.getAttribute("r") ?? "");
    if (f && pos && f.getAttribute("t") === "shared" && (f.textContent ?? "") !== "") {
      masters.set(f.getAttribute("si") ?? "", { text: f.textContent ?? "", ...pos });
    }
  }
  for (const c of cells) {
    const f = childrenByLocal(c, "f")[0];
    if (!f) continue;
    const pos = parseCellRef(c.getAttribute("r") ?? "");
    const type = f.getAttribute("t");
    let text = f.textContent ?? "";
    let shift = { rows: 0, cols: 0 };
    let shared = false;
    if (type === "shared") {
      const master = masters.get(f.getAttribute("si") ?? "");
      if (!master || !pos) {
        if (!edited) continue;
        result.converted++;
        if (convertFormulaCellToValue(doc, c, f)) result.convertedEmpty++;
        continue;
      }
      shared = true;
      text = master.text;
      shift = { rows: pos.row - master.row, cols: pos.col - master.col };
    }
    if (!refersToEdited(text)) continue;
    let adjusted: FormulaAdjustResult =
      type === "dataTable" ? { ok: false, reason: "データテーブル" } : adjustFormula(text, { maps, sheetName, localIsEdited: edited, shift });
    // 配列数式の範囲（編集したシートの番地）も、ずれるだけのときに限り新しい位置に合わせる
    let newArrayRef: string | null = null;
    if (adjusted.ok && edited && type === "array" && f.getAttribute("ref")) {
      const ref = f.getAttribute("ref")!;
      const parts = ref.split(":").map((x) => parseCellRef(x));
      const a = parts[0];
      const b = parts[1] ?? parts[0];
      const cs = a && b ? translatedStart(Math.min(a.col, b.col), Math.max(a.col, b.col), maps.col) : null;
      const rs = a && b ? translatedStart(Math.min(a.row, b.row), Math.max(a.row, b.row), maps.row) : null;
      if (a && b && cs !== null && rs !== null) {
        const start = toCellRef({ row: rs, col: cs });
        const end = toCellRef({ row: rs + Math.abs(b.row - a.row), col: cs + Math.abs(b.col - a.col) });
        newArrayRef = start === end ? start : `${start}:${end}`;
      } else {
        adjusted = { ok: false, reason: "配列数式の範囲" };
      }
    }
    if (!adjusted.ok) {
      result.converted++;
      if (convertFormulaCellToValue(doc, c, f)) result.convertedEmpty++;
      continue;
    }
    if (adjusted.text !== (f.textContent ?? "") || shared) result.adjusted++;
    result.kept++;
    f.textContent = adjusted.text;
    if (shared) {
      // 1つずつの数式に戻した（共有の印を外す）
      f.removeAttribute("t");
      f.removeAttribute("si");
      f.removeAttribute("ref");
    }
    if (newArrayRef) f.setAttribute("ref", newArrayRef);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export async function editXlsxColumns(input: XlsxColumnEditInput): Promise<XlsxColumnEditOutput> {
  const { file, sheetIndex, columnOrder, renames, hasHeader } = input;
  if (columnOrder.length === 0) throw new Error("残す列を1つ以上選択してください");
  const sheets = await loadXlsxForColumnEdit(file);
  const view = sheets[sheetIndex];
  if (!view) throw new Error("編集するシートが見つかりませんでした。ファイルを選び直してください。");
  const maxRow = view.rows.length;
  const maxCol = view.rows[0]?.length ?? 0;
  if (maxRow === 0 || maxCol === 0) throw new Error(`シート「${view.name}」には値の入ったセルがありません。`);
  if (new Set(columnOrder).size !== columnOrder.length || columnOrder.some((c) => !Number.isInteger(c) || c < 0 || c >= maxCol)) {
    throw new Error("列の指定が正しくありません。ファイルを選び直してください。");
  }
  const rowStart = input.rowStart ?? 1;
  const rowEnd = Math.min(input.rowEnd ?? maxRow, maxRow);
  if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd) || rowStart < 1 || rowStart > rowEnd) {
    throw new Error(`対象にする行の範囲が正しくありません（1〜${maxRow}行目の間で、開始行が終了行以下になるように指定してください）`);
  }
  const rowsLimited = rowStart !== 1 || rowEnd !== maxRow;

  // 列の対応：残す列は選んだ順に1列目から。値の範囲より右の列（書式だけの列）は、削除した列の数だけ左へ詰める
  const newColOf = new Map<number, number>();
  columnOrder.forEach((c, i) => newColOf.set(c + 1, i + 1));
  const keptCount = columnOrder.length;
  const colMap = (c: number): number | null => (c <= maxCol ? (newColOf.get(c) ?? null) : keptCount + (c - maxCol));
  // 行の対応：範囲を指定したときは、範囲の最初の行が1行目になる（範囲外の行は削除）。指定しないときはそのまま
  const rowMap = (r: number): number | null => (!rowsLimited ? r : r >= rowStart && r <= rowEnd ? r - rowStart + 1 : null);
  const maps: AxisMaps = { row: rowMap, col: colMap };
  const columnsChanged = keptCount !== maxCol || columnOrder.some((c, i) => c !== i);
  const positionsChanged = columnsChanged || rowsLimited;
  const headerRenames = hasHeader
    ? Object.entries(renames ?? {})
        .map(([k, v]) => [Number(k), v.trim()] as const)
        .filter(([c, v]) => v !== "" && newColOf.has(c + 1))
    : [];

  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error(`${file.name} を読み込めませんでした。Excelファイル(.xlsx)が破損している可能性があります。`);
  }

  const workbookBytes = zip["xl/workbook.xml"];
  const workbook = parseXml(workbookBytes, "ブックの情報");
  const wbRelsBytes = zip["xl/_rels/workbook.xml.rels"];
  const wbRels = parseXml(wbRelsBytes, "ブックの関連情報");
  const relTarget = new Map<string, string>();
  for (const r of byLocal(wbRels, "Relationship")) relTarget.set(r.getAttribute("Id") ?? "", resolveTarget("xl/workbook.xml", r.getAttribute("Target") ?? ""));
  const sheetEls = byLocal(workbook, "sheet");
  const sheetEl = sheetEls[sheetIndex];
  const sheetPath = sheetEl ? relTarget.get(sheetEl.getAttributeNS(REL_NS, "id") ?? sheetEl.getAttribute("r:id") ?? "") : undefined;
  if (!sheetEl || !sheetPath || !zip[sheetPath]) throw new Error("編集するシートのデータが見つかりませんでした。");
  const sheetBytes = zip[sheetPath];
  const sheet = parseXml(sheetBytes, "シートのデータ");
  const notices: string[] = [];

  // 正しく直せない要素があるシートは、位置を変える前に止める
  if (byLocal(sheet, "tablePart").length > 0) {
    throw new Error(
      `シート「${view.name}」にはExcelの「テーブル」があるため、列の編集には対応していません。Excelで「範囲に変換」してから選ぶか、ほかのシートを選んでください。`
    );
  }
  if (positionsChanged && byLocal(sheet, "legacyDrawing").length > 0) {
    throw new Error(
      `シート「${view.name}」にはメモ（コメント）があるため、列の削除・並び替えや行の範囲の指定には対応していません（メモの位置を正しく直せないため）。メモを削除してから選ぶか、列名の変更だけにしてください。`
    );
  }
  if (positionsChanged && byLocal(sheet, "drawing").length > 0) {
    notices.push("このシートの画像・グラフの位置や、グラフが参照する範囲は変更していません。必要に応じてExcelで確認してください。");
  }

  const sheetData = byLocal(sheet, "sheetData")[0];
  if (!sheetData) throw new Error("シートのデータが見つかりませんでした。");

  // 0) 数式：セルを動かす前に、参照を新しい位置に合わせて書き直す（安全に書き直せないものだけ値に置き換える）
  const editedFormulas: SheetFormulaResult | null = positionsChanged ? processSheetFormulas(sheet, maps, view.name, true) : null;

  // 1) セル：新しい位置へ移す（値・書式・数式はそのまま）。削除する行・列のセルは取り除く
  let implicitRow = 0;
  for (const rowEl of childrenByLocal(sheetData, "row")) {
    const r = Number(rowEl.getAttribute("r") ?? implicitRow + 1);
    implicitRow = r;
    const newR = rowMap(r);
    if (newR === null) {
      sheetData.removeChild(rowEl);
      continue;
    }
    rowEl.setAttribute("r", String(newR));
    rowEl.removeAttribute("spans");
    const cells: { el: Element; col: number }[] = [];
    let implicitCol = 0;
    for (const c of childrenByLocal(rowEl, "c")) {
      const pos = parseCellRef(c.getAttribute("r") ?? "");
      const col = pos ? pos.col : implicitCol + 1;
      implicitCol = col;
      const newC = colMap(col);
      rowEl.removeChild(c);
      if (newC === null) continue;
      c.setAttribute("r", toCellRef({ row: newR, col: newC }));
      cells.push({ el: c, col: newC });
    }
    cells.sort((a, b) => a.col - b.col);
    for (const { el } of cells) rowEl.appendChild(el);
  }
  // 行も新しい番号の順に並べ直す（並びは変わらないが、念のため）
  const rowEls = childrenByLocal(sheetData, "row").sort((a, b) => Number(a.getAttribute("r")) - Number(b.getAttribute("r")));
  for (const el of rowEls) sheetData.appendChild(el);

  // 2) 見出しの名前の変更（見出しの行＝対象の範囲の最初の行。出力では1行目になる）
  if (headerRenames.length > 0) {
    const headerRowNumber = 1;
    let headerRow = childrenByLocal(sheetData, "row").find((el) => Number(el.getAttribute("r")) === headerRowNumber);
    if (!headerRow) {
      headerRow = sheet.createElementNS(MAIN_NS, "row");
      headerRow.setAttribute("r", String(headerRowNumber));
      sheetData.insertBefore(headerRow, sheetData.firstChild);
    }
    for (const [oldColIndex, name] of headerRenames) {
      const newCol = newColOf.get(oldColIndex + 1)!;
      const ref = toCellRef({ row: headerRowNumber, col: newCol });
      let cell = childrenByLocal(headerRow, "c").find((c) => c.getAttribute("r") === ref);
      if (!cell) {
        cell = sheet.createElementNS(MAIN_NS, "c");
        cell.setAttribute("r", ref);
        const after = childrenByLocal(headerRow, "c").find((c) => (parseCellRef(c.getAttribute("r") ?? "")?.col ?? 0) > newCol);
        headerRow.insertBefore(cell, after ?? null);
      }
      for (const child of Array.from(cell.children)) cell.removeChild(child);
      cell.setAttribute("t", "inlineStr");
      const is = sheet.createElementNS(MAIN_NS, "is");
      const t = sheet.createElementNS(MAIN_NS, "t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.textContent = name;
      is.appendChild(t);
      cell.appendChild(is);
    }
  }

  if (positionsChanged) {
    // 3) 列の幅・書式（<cols>）を新しい列に合わせる
    const colsEl = byLocal(sheet, "cols")[0];
    if (colsEl && columnsChanged) {
      const defs = childrenByLocal(colsEl, "col").map((el) => ({ el, min: Number(el.getAttribute("min")), max: Number(el.getAttribute("max")) }));
      const defOf = (c: number) => defs.find((d) => c >= d.min && c <= d.max);
      const created: Element[] = [];
      for (let oldCol = 1; oldCol <= maxCol; oldCol++) {
        const newCol = colMap(oldCol);
        const def = defOf(oldCol);
        if (newCol === null || !def) continue;
        const el = def.el.cloneNode(true) as Element;
        el.setAttribute("min", String(newCol));
        el.setAttribute("max", String(newCol));
        created.push(el);
      }
      // 値の範囲より右の列の設定は、削除した列の数だけ左へ詰める
      for (const d of defs) {
        if (d.max <= maxCol) continue;
        const el = d.el.cloneNode(true) as Element;
        el.setAttribute("min", String(colMap(Math.max(d.min, maxCol + 1))));
        el.setAttribute("max", String(Math.min(16384, colMap(d.max) ?? d.max)));
        created.push(el);
      }
      for (const d of defs) colsEl.removeChild(d.el);
      created.sort((a, b) => Number(a.getAttribute("min")) - Number(b.getAttribute("min")));
      for (const el of created) colsEl.appendChild(el);
      if (created.length === 0) colsEl.parentNode?.removeChild(colsEl);
    }

    // 4) 範囲を持つ要素を新しい位置に合わせる
    let droppedMerges = 0;
    for (const mc of byLocal(sheet, "mergeCell")) {
      const mapped = remapRange(mc.getAttribute("ref") ?? "", maps);
      if (mapped && mapped.length === 1 && mapped[0].includes(":")) mc.setAttribute("ref", mapped[0]);
      else if (mapped !== null) {
        mc.parentNode?.removeChild(mc);
        droppedMerges++;
      }
    }
    const mergeCells = byLocal(sheet, "mergeCells")[0];
    if (mergeCells) {
      const n = childrenByLocal(mergeCells, "mergeCell").length;
      if (n === 0) mergeCells.parentNode?.removeChild(mergeCells);
      else mergeCells.setAttribute("count", String(n));
    }
    if (droppedMerges > 0) notices.push(`削除・並び替えで1つの範囲にならないセルの結合を${droppedMerges}か所外しました。`);

    for (const af of byLocal(sheet, "autoFilter")) {
      const mapped = remapRange(af.getAttribute("ref") ?? "", maps);
      if (mapped && mapped.length === 1) af.setAttribute("ref", mapped[0]);
      else if (mapped !== null) {
        af.parentNode?.removeChild(af);
        notices.push("オートフィルターの範囲が1つにまとまらないため、オートフィルターを外しました。");
      }
    }
    for (const local of ["conditionalFormatting", "dataValidation", "protectedRange", "ignoredError"]) {
      for (const el of byLocal(sheet, local)) {
        const sq = el.getAttribute("sqref");
        if (sq === null) continue;
        const mapped = remapSqref(sq, maps);
        if (mapped === "") el.parentNode?.removeChild(el);
        else el.setAttribute("sqref", mapped);
      }
    }
    for (const local of ["dataValidations", "ignoredErrors", "protectedRanges"]) {
      for (const el of byLocal(sheet, local)) {
        if (el.children.length === 0) el.parentNode?.removeChild(el);
        else if (el.hasAttribute("count")) el.setAttribute("count", String(el.children.length));
      }
    }
    for (const h of byLocal(sheet, "hyperlink")) {
      const mapped = remapRange(h.getAttribute("ref") ?? "", maps);
      if (mapped && mapped.length > 0) h.setAttribute("ref", mapped[0]);
      else if (mapped !== null) h.parentNode?.removeChild(h);
    }
    const hyperlinks = byLocal(sheet, "hyperlinks")[0];
    if (hyperlinks && hyperlinks.children.length === 0) hyperlinks.parentNode?.removeChild(hyperlinks);
    // 選択中のセル・表示の位置は、A1に戻す（消えた位置を指したままにしない）
    for (const sel of byLocal(sheet, "selection")) {
      sel.setAttribute("activeCell", "A1");
      sel.setAttribute("sqref", "A1");
    }
    for (const pane of byLocal(sheet, "pane")) {
      const tl = pane.getAttribute("topLeftCell");
      if (tl) {
        const mapped = remapRange(tl, maps);
        if (mapped && mapped.length === 1) pane.setAttribute("topLeftCell", mapped[0]);
      }
    }
    for (const local of ["rowBreaks", "colBreaks"]) {
      for (const el of byLocal(sheet, local)) el.parentNode?.removeChild(el);
    }
  }

  // 5) 使っている範囲（dimension）を新しい大きさにする
  const outRows = rowsLimited ? rowEnd - rowStart + 1 : maxRow;
  const dim = byLocal(sheet, "dimension")[0];
  if (dim) dim.setAttribute("ref", `A1:${toCellRef({ row: outRows, col: keptCount })}`);

  const out: Record<string, Uint8Array> = { ...zip, [sheetPath]: serialize(sheet, sheetBytes) };

  let formulaReport: XlsxFormulaReport | null = null;
  if (positionsChanged) {
    // 計算の順番の情報（calcChain）は、数式のセルの番地を指しているため取り除く（Excelが開くときに作り直す）
    if (out["xl/calcChain.xml"]) {
      delete out["xl/calcChain.xml"];
      for (const r of byLocal(wbRels, "Relationship")) {
        if ((r.getAttribute("Target") ?? "").endsWith("calcChain.xml")) r.parentNode?.removeChild(r);
      }
      out["xl/_rels/workbook.xml.rels"] = serialize(wbRels, wbRelsBytes);
      const ctBytes = zip["[Content_Types].xml"];
      if (ctBytes) {
        const ct = parseXml(ctBytes, "ファイルの種類の情報");
        for (const o of byLocal(ct, "Override")) {
          if ((o.getAttribute("PartName") ?? "").endsWith("/calcChain.xml")) o.parentNode?.removeChild(o);
        }
        out["[Content_Types].xml"] = serialize(ct, ctBytes);
      }
    }

    // ほかのシートの数式のうち、このシートを参照しているものも、新しい位置に合わせて書き直す
    const patterns = sheetRefPatterns(view.name).map((p) => p.toLowerCase());
    let otherAdjusted = 0;
    let otherConverted = 0;
    sheetEls.forEach((el, i) => {
      if (i === sheetIndex) return;
      const path = relTarget.get(el.getAttributeNS(REL_NS, "id") ?? el.getAttribute("r:id") ?? "");
      const bytes = path ? zip[path] : undefined;
      if (!bytes) return;
      // 数式の中の文字は、文字参照（&#21517; など）で書かれていることがあるため、XMLとして読んでから調べる
      const other = parseXml(bytes, "シートのデータ");
      if (!byLocal(other, "f").some((f) => patterns.some((p) => (f.textContent ?? "").toLowerCase().includes(p)))) return;
      const r = processSheetFormulas(other, maps, view.name, false);
      otherAdjusted += r.adjusted;
      otherConverted += r.converted;
      if (r.adjusted > 0 || r.converted > 0) out[path!] = serialize(other, bytes);
    });

    // 名前の定義も、このシートを参照しているものは、同じ方法で書き直す（書き直せないものは知らせるだけ）
    let workbookChanged = false;
    let referencingNames = 0;
    for (const dn of byLocal(workbook, "definedName")) {
      const text = dn.textContent ?? "";
      if (!patterns.some((p) => text.toLowerCase().includes(p))) continue;
      const adjusted = adjustFormula(text, { maps, sheetName: view.name, localIsEdited: false });
      if (adjusted.ok) {
        if (adjusted.text !== text) {
          dn.textContent = adjusted.text;
          workbookChanged = true;
        }
      } else {
        referencingNames++;
      }
    }
    // 数式が残っているときは、開いたときに計算し直すようにする（保存されている計算結果が古くならないように）
    const anyFormula = (editedFormulas?.kept ?? 0) > 0 || otherAdjusted > 0;
    if (anyFormula) {
      let calcPr = byLocal(workbook, "calcPr")[0];
      if (!calcPr) {
        // ブックの中の要素の並び順（スキーマ）に合わせ、calcPr の後ろに来る要素の前に入れる
        calcPr = workbook.createElementNS(MAIN_NS, "calcPr");
        const after = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
        const before = Array.from(workbook.documentElement.children).find((el) => after.includes(el.localName)) ?? null;
        workbook.documentElement.insertBefore(calcPr, before);
      }
      calcPr.setAttribute("fullCalcOnLoad", "1");
      workbookChanged = true;
    }
    if (workbookChanged) out["xl/workbook.xml"] = serialize(workbook, workbookBytes);
    if (referencingNames > 0) {
      notices.push(
        `名前の定義${referencingNames}個が、このシートのセルを参照していますが、新しい位置に合わせて書き直せませんでした。正しい範囲になっているか、Excelで確認してください。`
      );
    }
    formulaReport = {
      kept: editedFormulas?.kept ?? 0,
      converted: editedFormulas?.converted ?? 0,
      convertedEmpty: editedFormulas?.convertedEmpty ?? 0,
      otherAdjusted,
      otherConverted,
    };
  }

  const zipped = zipSync(out as Zippable, { level: 6 });
  return {
    blob: new Blob([new Uint8Array(zipped)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    rowCount: outRows,
    columnCount: keptCount,
    notices,
    formulas: formulaReport,
  };
}
