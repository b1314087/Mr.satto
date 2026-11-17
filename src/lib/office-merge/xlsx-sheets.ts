import {
  addRel,
  byLocal,
  childrenByLocal,
  ContentTypes,
  emptyRelsDoc,
  firstChild,
  listRels,
  OoxmlError,
  readRels,
  readXml,
  REL_NS,
  relativeTarget,
  relsPathOf,
  relTypeIs,
  resolveTarget,
  uniquePartName,
  unzipPackage,
  verifyXmlParts,
  xmlBytes,
  zipPackage,
  type Files,
} from "./ooxml-package";

/**
 * Excel のシート分割・シート結合（2026-11-17）。
 *
 * どちらも、値を取り出して表を作り直すのではなく、ファイルの中の XML（シート・書式・図形など）をそのまま使う。
 * そのため、値・数式・書式（フォント・色・罫線）・セルの結合・列の幅・行の高さ・非表示の行/列・シートの表示/非表示を保つ。
 *
 * - 分割：選んだシートごとに、そのシートだけを残したブックを作る。
 *   ほかのシートを参照する数式は、参照先がなくなるため、保存されている計算結果の値に置き換える（数を知らせる）。
 * - 結合：複数のブックのシートを、選んだ順に1つのブックへまとめる。
 *   書式・共有の文字列・名前の定義・表（テーブル）・図形・グラフを番号を付け直して取り込む。
 *   同じ名前のシートは「名前 (2)」のように名前を変え、そのシートを参照する数式・グラフも合わせて直す。
 * 処理はすべてブラウザの中で行う。
 */

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_SST = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

export const MAX_XLSX_SHEETS_MB = 100;
export const MAX_XLSX_MERGE_FILES = 30;

export interface SheetInfo {
  name: string;
  /** visible・hidden・veryHidden */
  state: string;
  /** worksheet（表のシート）・chartsheet（グラフだけのシート） */
  kind: "worksheet" | "chartsheet" | "other";
  index: number;
}

export interface XlsxSheetsOutput {
  name: string;
  bytes: Uint8Array;
}

export interface XlsxSheetsResult {
  files: XlsxSheetsOutput[];
  notices: string[];
}

// ---------------------------------------------------------------------------
// ブックを開く
// ---------------------------------------------------------------------------

interface Book {
  files: Files;
  ct: ContentTypes;
  wbPath: string;
  wb: Document;
  wbRels: Document;
  label: string;
}

function el(doc: Document, local: string): Element {
  return doc.createElementNS(MAIN_NS, local);
}

function openBook(bytes: Uint8Array, label: string): Book {
  const files = unzipPackage(bytes, label);
  if (files["EncryptedPackage"]) throw new OoxmlError(`${label}はパスワードが付いているため、開けません。`);
  const rootRels = listRels(readRels(files, ""));
  const office = rootRels.find((r) => relTypeIs(r.type, "officeDocument"));
  const wbPath = office ? resolveTarget("", office.target) : "xl/workbook.xml";
  const ct = new ContentTypes(files);
  const type = ct.typeOf(wbPath) ?? "";
  if (!files[wbPath] || !/spreadsheetml/.test(type)) throw new OoxmlError(`${label}は、Excel（.xlsx）のブックとして読み取れませんでした。`);
  if (/macroEnabled/i.test(type)) throw new OoxmlError(`${label}はマクロ付きのブック（.xlsm）のため、扱えません。`);
  if (/binary/i.test(type)) throw new OoxmlError(`${label}はバイナリ形式（.xlsb）のため、扱えません。`);
  const wb = readXml(files, wbPath, label)!;
  return { files, ct, wbPath, wb, wbRels: readRels(files, wbPath), label };
}

function sheetEls(book: Book): Element[] {
  const sheets = byLocal(book.wb, "sheets")[0];
  return sheets ? childrenByLocal(sheets, "sheet") : [];
}

function sheetPartPath(book: Book, sheetEl: Element): string | null {
  const rid = sheetEl.getAttributeNS(REL_NS, "id");
  const rel = listRels(book.wbRels).find((r) => r.id === rid);
  return rel ? resolveTarget(book.wbPath, rel.target) : null;
}

export async function listSheets(bytes: Uint8Array, label: string): Promise<SheetInfo[]> {
  const book = openBook(bytes, label);
  return sheetEls(book).map((s, index) => {
    const rid = s.getAttributeNS(REL_NS, "id");
    const rel = listRels(book.wbRels).find((r) => r.id === rid);
    const kind = rel && relTypeIs(rel.type, "worksheet") ? "worksheet" : rel && relTypeIs(rel.type, "chartsheet") ? "chartsheet" : "other";
    return { name: s.getAttribute("name") ?? `Sheet${index + 1}`, state: s.getAttribute("state") ?? "visible", kind, index };
  });
}

// ---------------------------------------------------------------------------
// 数式の中のシート名
// ---------------------------------------------------------------------------

/** シート名を、数式の中の書き方にする（必要なら ' で囲む） */
export function quoteSheet(name: string): string {
  if (/^[A-Za-z_\u0080-￿][A-Za-z0-9_.\u0080-￿]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^R\d*C\d*$/i.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

const SHEET_REF_RE = /('(?:[^']|'')+'|\[\d+\][^!'"(),;:\s]*|[A-Za-z0-9_.\u0080-￿]+)(?::('(?:[^']|'')+'|[A-Za-z0-9_.\u0080-￿]+))?!/g;

function unquote(token: string): string {
  return token.startsWith("'") ? token.slice(1, -1).replace(/''/g, "'") : token;
}

/** 数式の文字列リテラル（"..."）の外側にだけ、処理を当てる */
function mapOutsideStrings(formula: string, fn: (part: string) => string): string {
  const parts = formula.split(/("(?:[^"]|"")*")/);
  return parts.map((p, i) => (i % 2 === 1 ? p : fn(p))).join("");
}

/** 数式が参照しているシート名（3D参照の両端を含む）。外部のブック（[1]Sheet!）は "[external]" */
export function sheetRefsIn(formula: string): string[] {
  const out: string[] = [];
  mapOutsideStrings(formula, (part) => {
    for (const m of part.matchAll(SHEET_REF_RE)) {
      if (m[1].startsWith("[") || /^'\[/.test(m[1])) out.push("[external]");
      else {
        out.push(unquote(m[1]));
        if (m[2]) out.push(unquote(m[2]));
      }
    }
    return part;
  });
  return out;
}

/** 数式の中のシート名を置き換える（大文字・小文字は区別しない） */
export function renameSheetRefs(formula: string, renames: Map<string, string>): string {
  if (renames.size === 0) return formula;
  const lower = new Map(Array.from(renames, ([k, v]) => [k.toLowerCase(), v]));
  return mapOutsideStrings(formula, (part) =>
    part.replace(SHEET_REF_RE, (whole, a: string, b: string | undefined) => {
      if (a.startsWith("[")) return whole;
      const na = lower.get(unquote(a).toLowerCase());
      const nb = b ? lower.get(unquote(b).toLowerCase()) : undefined;
      if (na === undefined && nb === undefined) return whole;
      if (b) {
        const left = na ?? unquote(a);
        const right = nb ?? unquote(b);
        const both = quoteSheet(left) !== left || quoteSheet(right) !== right;
        return both ? `'${left.replace(/'/g, "''")}:${right.replace(/'/g, "''")}'!` : `${left}:${right}!`;
      }
      return `${quoteSheet(na!)}!`;
    }),
  );
}

function usesName(formula: string, name: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9_.\\u0080-\\uFFFF!\\]'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_.\\u0080-\\uFFFF(!\\[])`, "i");
  let hit = false;
  mapOutsideStrings(formula, (p) => {
    if (re.test(p)) hit = true;
    return p;
  });
  return hit;
}

/** シート名に使えない文字を除き、31文字以内で、ほかと重ならない名前にする */
export function uniqueSheetName(wanted: string, used: Set<string>): string {
  const base = wanted.replace(/[\[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").slice(0, 31) || "Sheet";
  const taken = (n: string) => used.has(n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const n = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!taken(n)) return n;
  }
}

// ---------------------------------------------------------------------------
// 共通の後片付け
// ---------------------------------------------------------------------------

/** どこからもたどれない部品を消す（消したシートの図形・コメントなど） */
function removeUnreachable(book: Book) {
  const reach = new Set<string>(["[Content_Types].xml"]);
  const visit = (part: string) => {
    const relsPath = relsPathOf(part);
    if (!book.files[relsPath]) return;
    reach.add(relsPath);
    for (const r of listRels(readRels(book.files, part))) {
      if (r.external) continue;
      const t = resolveTarget(part, r.target);
      if (reach.has(t) || !book.files[t]) continue;
      reach.add(t);
      visit(t);
    }
  };
  visit("");
  for (const name of Object.keys(book.files)) {
    if (reach.has(name)) continue;
    delete book.files[name];
    book.ct.removeOverride(name);
  }
}

/** 計算の順番の記録（calcChain）と、シート名の一覧を持つ文書のプロパティ（app.xml）を外す（Excel が作り直す） */
function dropDerivedParts(book: Book) {
  for (const r of listRels(book.wbRels)) {
    if (relTypeIs(r.type, "calcChain")) {
      r.el.parentNode?.removeChild(r.el);
      const p = resolveTarget(book.wbPath, r.target);
      delete book.files[p];
      book.ct.removeOverride(p);
    }
  }
  const rootRels = readRels(book.files, "");
  for (const r of listRels(rootRels)) {
    if (relTypeIs(r.type, "extended-properties")) {
      r.el.parentNode?.removeChild(r.el);
      const p = resolveTarget("", r.target);
      delete book.files[p];
      book.ct.removeOverride(p);
    }
  }
  book.files["_rels/.rels"] = xmlBytes(rootRels);
}

function setFullCalcOnLoad(book: Book) {
  const root = book.wb.documentElement;
  let calcPr = firstChild(root, "calcPr");
  if (!calcPr) {
    calcPr = el(book.wb, "calcPr");
    // calcPr は definedNames の後（oleSize などの前）に置く
    const after = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
    const before = Array.from(root.children).find((c) => after.includes(c.localName));
    root.insertBefore(calcPr, before ?? null);
  }
  calcPr.setAttribute("fullCalcOnLoad", "1");
}

function writeBook(book: Book): Uint8Array {
  book.files[book.wbPath] = xmlBytes(book.wb);
  book.files[relsPathOf(book.wbPath)] = xmlBytes(book.wbRels);
  removeUnreachable(book);
  book.files["[Content_Types].xml"] = xmlBytes(book.ct.doc);
  verifyXmlParts(book.files, "作ったブック");
  return zipPackage(book.files);
}

/** 共有の数式（t="shared"）の、元になる数式の文字。si → 文字 */
function sharedFormulaTexts(sheet: Document): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of byLocal(sheet, "f")) {
    if (f.getAttribute("t") === "shared" && f.getAttribute("ref") && f.textContent) m.set(f.getAttribute("si") ?? "", f.textContent);
  }
  return m;
}

/**
 * 条件に当たる数式を、保存されている計算結果の値に置き換える。共有の数式は、同じグループごと置き換える。
 * 戻り値：置き換えた数
 */
function formulasToValues(sheet: Document, hit: (formula: string) => boolean): number {
  const shared = sharedFormulaTexts(sheet);
  const sharedHit = new Set(Array.from(shared).filter(([, t]) => hit(t)).map(([si]) => si));
  let n = 0;
  for (const f of byLocal(sheet, "f")) {
    if (f.namespaceURI !== MAIN_NS) continue;
    const isShared = f.getAttribute("t") === "shared";
    const text = isShared ? shared.get(f.getAttribute("si") ?? "") ?? "" : f.textContent ?? "";
    if (!(isShared ? sharedHit.has(f.getAttribute("si") ?? "") : hit(text))) continue;
    const c = f.parentElement;
    f.parentNode?.removeChild(f);
    n++;
    if (c && c.getAttribute("t") === "str") {
      // 数式の結果の文字は、そのまま文字のセルにする
      const v = firstChild(c, "v");
      c.setAttribute("t", "inlineStr");
      const is = el(sheet, "is");
      const t = el(sheet, "t");
      t.textContent = v?.textContent ?? "";
      if (/^\s|\s$/.test(t.textContent)) t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      is.appendChild(t);
      if (v) c.removeChild(v);
      c.appendChild(is);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 分割
// ---------------------------------------------------------------------------

/**
 * シートの中の、なくなるシート（removedLower）・なくなる名前の定義（removedNames）を参照するものを直す。
 * - 数式は、保存されている計算結果の値に置き換える（参照先がなくなる・別のブックの同じ名前のシートを指してしまうのを防ぐ）。
 * - 入力規則・条件付き書式は外す。
 */
function dropRefsToRemoved(sheet: Document, removedLower: Set<string>, removedNames: string[], removedTables: string[] = []): { converted: number; removedRules: number } {
  if (removedLower.size === 0 && removedNames.length === 0 && removedTables.length === 0) return { converted: 0, removedRules: 0 };
  const tableRes = removedTables.filter(Boolean).map((t) => new RegExp(`(^|[^A-Za-z0-9_.\\u0080-\\uFFFF])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[`, "i"));
  const hit = (f: string) =>
    sheetRefsIn(f).some((r) => r !== "[external]" && removedLower.has(r.toLowerCase())) ||
    removedNames.some((n) => n !== "" && usesName(f, n)) ||
    tableRes.some((re) => mapOutsideStrings(f, (p) => (re.test(p) ? "\u0000" : p)).includes("\u0000"));
  const converted = formulasToValues(sheet, hit);
  let removedRules = 0;
  for (const dv of byLocal(sheet, "dataValidation")) {
    const text = byLocal(dv, "formula1").concat(byLocal(dv, "formula2")).map((x) => x.textContent ?? "").join(" ");
    if (hit(text)) {
      dv.parentNode?.removeChild(dv);
      removedRules++;
    }
  }
  for (const cf of byLocal(sheet, "conditionalFormatting")) {
    for (const rule of childrenByLocal(cf, "cfRule")) {
      const text = byLocal(rule, "formula").map((x) => x.textContent ?? "").join(" ");
      if (hit(text)) {
        rule.parentNode?.removeChild(rule);
        removedRules++;
      }
    }
    if (childrenByLocal(cf, "cfRule").length === 0) cf.parentNode?.removeChild(cf);
  }
  for (const dvs of byLocal(sheet, "dataValidations")) {
    const count = childrenByLocal(dvs, "dataValidation").length;
    if (count === 0) dvs.parentNode?.removeChild(dvs);
    else dvs.setAttribute("count", String(count));
  }
  return { converted, removedRules };
}

/** シートの中にある表（テーブル）の名前 */
function tablesOnSheets(book: Book, sheets: Element[]): string[] {
  const out: string[] = [];
  for (const el of sheets) {
    const p = sheetPartPath(book, el);
    if (!p || !book.files[relsPathOf(p)]) continue;
    for (const r of listRels(readRels(book.files, p))) {
      if (r.external || !relTypeIs(r.type, "table")) continue;
      const t = readXml(book.files, resolveTarget(p, r.target), "テーブル");
      const name = t?.documentElement.getAttribute("displayName") ?? t?.documentElement.getAttribute("name");
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * ブックを、keep のシート（元の並びの番号）だけにする。残すシートの順番は元のまま。
 * 名前の定義・数式・入力規則・条件付き書式で、外したシートを参照するものも直す。
 */
function keepOnlySheets(book: Book, keep: number[], notices: Set<string>): { converted: number } {
  const sheets = sheetEls(book);
  const keepSet = new Set(keep.filter((i) => i >= 0 && i < sheets.length));
  if (keepSet.size === sheets.length) return { converted: 0 };
  if (keepSet.size === 0) throw new OoxmlError(`${book.label}で、残すシートが選ばれていません。`);
  const removedLower = new Set(sheets.filter((_, i) => !keepSet.has(i)).map((s) => (s.getAttribute("name") ?? "").toLowerCase()));
  const removedTables = tablesOnSheets(book, sheets.filter((_, i) => !keepSet.has(i)));
  const newIndex = new Map<number, number>();
  let n = 0;
  sheets.forEach((s, i) => {
    if (keepSet.has(i)) {
      newIndex.set(i, n++);
      return;
    }
    const rid = s.getAttributeNS(REL_NS, "id");
    for (const r of listRels(book.wbRels)) if (r.id === rid) r.el.parentNode?.removeChild(r.el);
    s.parentNode?.removeChild(s);
  });
  // 表示されたシートが1つもなくなるときは、最初のシートを表示にする（ブックには表示されたシートが1つ以上必要なため）
  const kept = sheetEls(book);
  if (!kept.some((s) => (s.getAttribute("state") ?? "visible") === "visible")) {
    kept[0].removeAttribute("state");
    notices.add("残したシートがすべて非表示だったため、最初のシートを表示にしました（ブックには表示されたシートが1つ以上必要なため）。");
  }
  // 名前の定義：外したシートだけの名前・外したシートを参照する名前を外し、シートの番号を付け直す
  const removedNames: string[] = [];
  const definedNames = byLocal(book.wb, "definedNames")[0];
  if (definedNames) {
    for (const dn of childrenByLocal(definedNames, "definedName")) {
      const local = dn.getAttribute("localSheetId");
      const refsRemoved = sheetRefsIn(dn.textContent ?? "").some((r) => r !== "[external]" && removedLower.has(r.toLowerCase()));
      const localGone = local !== null && !newIndex.has(Number(local));
      if (localGone || refsRemoved) {
        if (!localGone) removedNames.push(dn.getAttribute("name") ?? "");
        dn.parentNode?.removeChild(dn);
        continue;
      }
      if (local !== null) dn.setAttribute("localSheetId", String(newIndex.get(Number(local))));
    }
    if (childrenByLocal(definedNames, "definedName").length === 0) definedNames.parentNode?.removeChild(definedNames);
  }
  for (const v of byLocal(book.wb, "workbookView")) {
    v.setAttribute("activeTab", "0");
    v.removeAttribute("firstSheet");
  }
  let converted = 0;
  let removedRules = 0;
  kept.forEach((el, i) => {
    const path = sheetPartPath(book, el);
    if (!path || !book.files[path]) return;
    const sheet = readXml(book.files, path, book.label)!;
    for (const sv of byLocal(sheet, "sheetView")) {
      if (i === 0) sv.setAttribute("tabSelected", "1");
      else sv.removeAttribute("tabSelected");
    }
    const r = dropRefsToRemoved(sheet, removedLower, removedNames, removedTables);
    converted += r.converted;
    removedRules += r.removedRules;
    book.files[path] = xmlBytes(sheet);
  });
  if (removedRules > 0) notices.add("選ばなかったシートを参照する入力規則・条件付き書式は、参照先がなくなるため外しました。");
  return { converted };
}

export async function splitSheets(bytes: Uint8Array, label: string, indexes: number[]): Promise<XlsxSheetsResult> {
  if (indexes.length === 0) throw new OoxmlError("分割するシートを選んでください。");
  const all = sheetEls(openBook(bytes, label));
  const notices = new Set<string>();
  const out: XlsxSheetsOutput[] = [];
  let convertedTotal = 0;
  for (const keep of indexes) {
    if (keep < 0 || keep >= all.length) continue;
    const book = openBook(bytes, label);
    const keepEl = sheetEls(book)[keep];
    const keepName = keepEl.getAttribute("name") ?? "";
    // 1つだけのシートは、表示にする（ブックには表示されたシートが1つ以上必要なため）
    if (keepEl.getAttribute("state") && keepEl.getAttribute("state") !== "visible") {
      keepEl.removeAttribute("state");
      notices.add("非表示のシートを分割したときは、そのシートを表示にしました（1つだけのシートは表示にする必要があるため）。");
    }
    convertedTotal += keepOnlySheets(book, [keep], notices).converted;
    dropDerivedParts(book);
    setFullCalcOnLoad(book);
    out.push({ name: keepName, bytes: writeBook(book) });
  }
  if (convertedTotal > 0) {
    notices.add(`ほかのシートを参照していた数式${convertedTotal}個は、参照先のシートがなくなるため、保存されていた計算結果の値に置き換えました（同じシートの中だけを参照する数式は、そのまま残しています）。`);
  }
  return { files: out, notices: Array.from(notices) };
}

// ---------------------------------------------------------------------------
// 結合
// ---------------------------------------------------------------------------

interface StylesCtx {
  doc: Document;
  path: string;
}

function stylesOf(book: Book): StylesCtx | null {
  const r = listRels(book.wbRels).find((x) => relTypeIs(x.type, "styles"));
  if (!r) return null;
  const path = resolveTarget(book.wbPath, r.target);
  const doc = readXml(book.files, path, "書式");
  return doc ? { doc, path } : null;
}

function normalize(e: Element): string {
  return new XMLSerializer().serializeToString(e).replace(/\s+xmlns(:\w+)?="[^"]*"/g, "").replace(/>\s+</g, "><");
}

const STYLE_ORDER = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"];

function ensureList(doc: Document, local: string): Element {
  const root = doc.documentElement;
  const found = firstChild(root, local);
  if (found) return found;
  const e = el(doc, local);
  const idx = STYLE_ORDER.indexOf(local);
  const before = Array.from(root.children).find((c) => STYLE_ORDER.indexOf(c.localName) > idx);
  root.insertBefore(e, before ?? null);
  return e;
}

function setCount(list: Element) {
  list.setAttribute("count", String(list.children.length));
}

// テーマの色
interface ThemeColors {
  colors: string[];
}

function readTheme(book: Book): { colors: string[]; minor: string; major: string } | null {
  const r = listRels(book.wbRels).find((x) => relTypeIs(x.type, "theme"));
  if (!r) return null;
  const doc = readXml(book.files, resolveTarget(book.wbPath, r.target), "テーマ");
  if (!doc) return null;
  const scheme = byLocal(doc, "clrScheme")[0];
  // Excel の theme の番号の並び：lt1 dk1 lt2 dk2 accent1..6 hlink folHlink（dk1/lt1 の順に注意）
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  const colors = order.map((name) => {
    const c = scheme ? Array.from(scheme.children).find((x) => x.localName === name) : null;
    const v = c?.firstElementChild;
    if (!v) return "000000";
    return (v.getAttribute("lastClr") ?? v.getAttribute("val") ?? "000000").toUpperCase();
  });
  const font = (kind: string) => byLocal(doc, kind)[0]?.getElementsByTagNameNS("*", "latin")[0]?.getAttribute("typeface") ?? "";
  return { colors, minor: font("minorFont"), major: font("majorFont") };
}

function applyTint(hex: string, tint: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let rr = l;
  let gg = l;
  let bb = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue(p, q, h + 1 / 3);
    gg = hue(p, q, h);
    bb = hue(p, q, h - 1 / 3);
  }
  const to = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `${to(rr)}${to(gg)}${to(bb)}`;
}

/** テーマの色（theme="4" tint="0.4" など）を、実際の色（rgb）に置き換える */
function resolveThemeColors(root: Element, theme: ThemeColors) {
  for (const c of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    if (!c.hasAttribute("theme")) continue;
    if (!["color", "fgColor", "bgColor", "tabColor"].includes(c.localName)) continue;
    const idx = Number(c.getAttribute("theme"));
    const base = theme.colors[idx];
    if (!base) continue;
    const tint = Number(c.getAttribute("tint") ?? "0");
    c.setAttribute("rgb", `FF${tint ? applyTint(base, tint) : base}`);
    c.removeAttribute("theme");
    c.removeAttribute("tint");
  }
}

interface StyleMaps {
  xf: Map<number, number>;
  dxf: Map<number, number>;
}

/** B の書式を A に足し、番号の対応を返す */
function mergeStyleSheets(a: StylesCtx, b: StylesCtx, themeDiffers: boolean, bTheme: ThemeColors | null): StyleMaps {
  const A = a.doc;
  const bRoot = b.doc.documentElement;
  const prepared = (e: Element) => {
    const copy = A.importNode(e, true) as Element;
    if (themeDiffers && bTheme) resolveThemeColors(copy, bTheme);
    if (themeDiffers) for (const s of byLocal(copy, "scheme")) s.parentNode?.removeChild(s); // テーマのフォントではなく、書かれたフォント名を使う
    return copy;
  };

  // 表示形式（numFmt）
  const numMap = new Map<number, number>();
  const aNumFmts = ensureList(A, "numFmts");
  const codeToId = new Map<string, number>();
  let maxId = 163;
  for (const n of childrenByLocal(aNumFmts, "numFmt")) {
    const id = Number(n.getAttribute("numFmtId"));
    codeToId.set(n.getAttribute("formatCode") ?? "", id);
    if (id > maxId) maxId = id;
  }
  for (const n of byLocal(bRoot, "numFmt")) {
    if (n.parentElement?.localName !== "numFmts") continue;
    const id = Number(n.getAttribute("numFmtId"));
    const code = n.getAttribute("formatCode") ?? "";
    if (codeToId.has(code)) {
      numMap.set(id, codeToId.get(code)!);
      continue;
    }
    const nid = ++maxId;
    const copy = A.importNode(n, true) as Element;
    copy.setAttribute("numFmtId", String(nid));
    aNumFmts.appendChild(copy);
    codeToId.set(code, nid);
    numMap.set(id, nid);
  }
  if (aNumFmts.children.length === 0) aNumFmts.parentNode?.removeChild(aNumFmts);
  else setCount(aNumFmts);

  // フォント・塗りつぶし・罫線（同じものは使い回す）
  const appendList = (local: string, item: string): Map<number, number> => {
    const map = new Map<number, number>();
    const bList = firstChild(bRoot, local);
    if (!bList) return map;
    const aList = ensureList(A, local);
    const index = new Map<string, number>();
    childrenByLocal(aList, item).forEach((e, i) => {
      const k = normalize(e);
      if (!index.has(k)) index.set(k, i);
    });
    childrenByLocal(bList, item).forEach((e, i) => {
      const copy = prepared(e);
      const k = normalize(copy);
      if (index.has(k)) map.set(i, index.get(k)!);
      else {
        aList.appendChild(copy);
        const ni = childrenByLocal(aList, item).length - 1;
        index.set(k, ni);
        map.set(i, ni);
      }
    });
    setCount(aList);
    return map;
  };
  const fontMap = appendList("fonts", "font");
  const fillMap = appendList("fills", "fill");
  const borderMap = appendList("borders", "border");

  const remapXf = (xf: Element, xfIdMap?: Map<number, number>) => {
    const re = (attr: string, m: Map<number, number>) => {
      const v = xf.getAttribute(attr);
      if (v === null) return;
      const n = m.get(Number(v));
      if (n !== undefined) xf.setAttribute(attr, String(n));
    };
    const nf = xf.getAttribute("numFmtId");
    if (nf !== null && Number(nf) >= 164) re("numFmtId", numMap);
    re("fontId", fontMap);
    re("fillId", fillMap);
    re("borderId", borderMap);
    if (xfIdMap) re("xfId", xfIdMap);
  };

  const appendXfs = (local: string, xfIdMap?: Map<number, number>): Map<number, number> => {
    const map = new Map<number, number>();
    const bList = firstChild(bRoot, local);
    if (!bList) return map;
    const aList = ensureList(A, local);
    const index = new Map<string, number>();
    childrenByLocal(aList, "xf").forEach((e, i) => {
      const k = normalize(e);
      if (!index.has(k)) index.set(k, i);
    });
    childrenByLocal(bList, "xf").forEach((e, i) => {
      const copy = A.importNode(e, true) as Element;
      remapXf(copy, xfIdMap);
      const k = normalize(copy);
      if (index.has(k)) map.set(i, index.get(k)!);
      else {
        aList.appendChild(copy);
        const ni = childrenByLocal(aList, "xf").length - 1;
        index.set(k, ni);
        map.set(i, ni);
      }
    });
    setCount(aList);
    return map;
  };
  const styleXfMap = appendXfs("cellStyleXfs");
  const xfMap = appendXfs("cellXfs", styleXfMap);

  // セルのスタイル（「標準」など）：名前がないものだけ足す
  const bCellStyles = firstChild(bRoot, "cellStyles");
  if (bCellStyles) {
    const aCellStyles = ensureList(A, "cellStyles");
    const names = new Set(childrenByLocal(aCellStyles, "cellStyle").map((c) => c.getAttribute("name")));
    const builtins = new Set(childrenByLocal(aCellStyles, "cellStyle").map((c) => c.getAttribute("builtinId")).filter((x) => x !== null));
    for (const cs of childrenByLocal(bCellStyles, "cellStyle")) {
      if (names.has(cs.getAttribute("name"))) continue;
      const bid = cs.getAttribute("builtinId");
      if (bid !== null && builtins.has(bid) && !cs.getAttribute("iLevel")) continue;
      const copy = A.importNode(cs, true) as Element;
      const x = styleXfMap.get(Number(cs.getAttribute("xfId")));
      if (x !== undefined) copy.setAttribute("xfId", String(x));
      aCellStyles.appendChild(copy);
    }
    setCount(aCellStyles);
  }

  // 条件付き書式の書式（dxf）
  const dxfMap = new Map<number, number>();
  const bDxfs = firstChild(bRoot, "dxfs");
  if (bDxfs && bDxfs.children.length > 0) {
    const aDxfs = ensureList(A, "dxfs");
    childrenByLocal(bDxfs, "dxf").forEach((d, i) => {
      aDxfs.appendChild(prepared(d));
      dxfMap.set(i, childrenByLocal(aDxfs, "dxf").length - 1);
    });
    setCount(aDxfs);
  }
  return { xf: xfMap, dxf: dxfMap };
}

interface SstCtx {
  doc: Document;
  path: string;
  index: Map<string, number>;
}

function ensureSst(a: Book): SstCtx {
  const r = listRels(a.wbRels).find((x) => relTypeIs(x.type, "sharedStrings"));
  let path: string;
  let doc: Document | null = null;
  if (r) {
    path = resolveTarget(a.wbPath, r.target);
    doc = readXml(a.files, path, "共有の文字列");
  } else {
    path = uniquePartName(a.files, "xl/sharedStrings.xml", "m");
    addRel(a.wbRels, `${REL_BASE}/sharedStrings`, relativeTarget(a.wbPath, path));
    a.ct.setOverride(path, CT_SST);
  }
  if (!doc) doc = new DOMParser().parseFromString(`<sst xmlns="${MAIN_NS}"/>`, "application/xml");
  const index = new Map<string, number>();
  childrenByLocal(doc.documentElement, "si").forEach((si, i) => {
    const k = normalize(si);
    if (!index.has(k)) index.set(k, i);
  });
  return { doc, path, index };
}

function readSst(book: Book): Element[] {
  const r = listRels(book.wbRels).find((x) => relTypeIs(x.type, "sharedStrings"));
  if (!r) return [];
  const doc = readXml(book.files, resolveTarget(book.wbPath, r.target), "共有の文字列");
  return doc ? childrenByLocal(doc.documentElement, "si") : [];
}

/** シートと一緒に写す関係の種類（これ以外は外す） */
const SHEET_REL_KEEP = ["drawing", "vmlDrawing", "comments", "table", "printerSettings", "hyperlink", "image", "oleObject", "package", "ctrlProp"];

export interface MergeInput {
  name: string;
  bytes: Uint8Array;
  /** 結合するシート（元の並びの番号）。省略したときは、すべてのシート */
  sheets?: number[];
}

export async function mergeWorkbooks(inputs: MergeInput[]): Promise<XlsxSheetsResult> {
  if (inputs.length < 1) throw new OoxmlError("結合するExcelのファイルを選んでください。");
  if (inputs.length > MAX_XLSX_MERGE_FILES) throw new OoxmlError(`一度に結合できるのは${MAX_XLSX_MERGE_FILES}ファイルまでです。`);
  const selectedCount = inputs.reduce((n, inp) => n + (inp.sheets ? inp.sheets.length : sheetEls(openBook(inp.bytes, inp.name)).length), 0);
  if (selectedCount < 2) throw new OoxmlError("結合するシートを2つ以上選んでください。");
  // シートを1つも選んでいないファイルは、結合に使わない
  inputs = inputs.filter((inp) => !inp.sheets || inp.sheets.length > 0);
  const a = openBook(inputs[0].bytes, inputs[0].name);
  const notices = new Set<string>();
  // 1つ目のブックで選ばなかったシートを外す（それを参照する数式は値にする）
  let selectionConverted = inputs[0].sheets ? keepOnlySheets(a, inputs[0].sheets, notices).converted : 0;
  const aStyles = stylesOf(a);
  if (!aStyles) throw new OoxmlError(`${inputs[0].name}の書式の情報が見つかりませんでした。`);
  const aTheme = readTheme(a);
  const aDate1904 = /^(1|true)$/.test(firstChild(a.wb.documentElement, "workbookPr")?.getAttribute("date1904") ?? "");
  const sst = ensureSst(a);
  const aSheetsList = byLocal(a.wb, "sheets")[0];
  const usedNames = new Set(sheetEls(a).map((s) => (s.getAttribute("name") ?? "").toLowerCase()));
  let nextSheetId = Math.max(0, ...sheetEls(a).map((s) => Number(s.getAttribute("sheetId")) || 0)) + 1;
  const tableNames = new Set<string>();
  let nextTableId = 1;
  for (const name of Object.keys(a.files)) {
    if (!/^xl\/tables\/.*\.xml$/.test(name)) continue;
    const t = readXml(a.files, name, "テーブル");
    if (!t) continue;
    tableNames.add((t.documentElement.getAttribute("name") ?? "").toLowerCase());
    tableNames.add((t.documentElement.getAttribute("displayName") ?? "").toLowerCase());
    nextTableId = Math.max(nextTableId, Number(t.documentElement.getAttribute("id")) + 1);
  }
  let aDefinedNames = byLocal(a.wb, "definedNames")[0] ?? null;
  const aGlobalNames = new Set(aDefinedNames ? childrenByLocal(aDefinedNames, "definedName").filter((d) => d.getAttribute("localSheetId") === null).map((d) => (d.getAttribute("name") ?? "").toLowerCase()) : []);
  let sheetCount = sheetEls(a).length;
  let renamedAny = false;
  let externalConverted = 0;

  for (let k = 1; k < inputs.length; k++) {
    const b = openBook(inputs[k].bytes, inputs[k].name);
    const bDate1904 = /^(1|true)$/.test(firstChild(b.wb.documentElement, "workbookPr")?.getAttribute("date1904") ?? "");
    if (bDate1904 !== aDate1904) throw new OoxmlError(`${inputs[k].name}は日付の基準（1904年から数える設定）が1つ目のファイルと違うため、日付がずれないよう結合しません。`);
    const bStyles = stylesOf(b);
    const bTheme = readTheme(b);
    const themeDiffers = !!(bTheme && aTheme && JSON.stringify(bTheme) !== JSON.stringify(aTheme));
    if (themeDiffers) notices.add("テーマ（配色・フォント）が違うファイルの書式は、見た目を保つため、実際の色・フォント名を指定した形にしました。");
    const maps: StyleMaps = bStyles ? mergeStyleSheets(aStyles, bStyles, themeDiffers, bTheme) : { xf: new Map(), dxf: new Map() };
    const bSst = readSst(b);
    const sstMap = new Map<number, number>();
    const mapSst = (i: number): number => {
      if (sstMap.has(i)) return sstMap.get(i)!;
      const si = bSst[i];
      if (!si) return i;
      const copy = sst.doc.importNode(si, true) as Element;
      const key = normalize(copy);
      let ni = sst.index.get(key);
      if (ni === undefined) {
        sst.doc.documentElement.appendChild(copy);
        ni = childrenByLocal(sst.doc.documentElement, "si").length - 1;
        sst.index.set(key, ni);
      }
      sstMap.set(i, ni);
      return ni;
    };

    // シート名の付け直し
    // 選んだシートだけを使う。選ばなかったシートを参照する数式は値にする（別のブックの同じ名前のシートを指してしまわないように）
    const bAll = sheetEls(b);
    const selected = (inputs[k].sheets ?? bAll.map((_, i) => i)).filter((i) => i >= 0 && i < bAll.length).sort((x, y) => x - y);
    const bSheets = selected.map((i) => bAll[i]);
    const localMap = new Map<number, number>(selected.map((orig, pos) => [orig, pos]));
    const removedLowerB = new Set(bAll.filter((_, i) => !localMap.has(i)).map((el) => (el.getAttribute("name") ?? "").toLowerCase()));
    const removedTablesB = tablesOnSheets(b, bAll.filter((_, i) => !localMap.has(i)));
    const bDefinedAll = byLocal(b.wb, "definedNames")[0];
    const removedNamesB = bDefinedAll
      ? childrenByLocal(bDefinedAll, "definedName")
          .filter((dn) => {
            const local = dn.getAttribute("localSheetId");
            return (local === null || localMap.has(Number(local))) && sheetRefsIn(dn.textContent ?? "").some((r) => r !== "[external]" && removedLowerB.has(r.toLowerCase()));
          })
          .map((dn) => dn.getAttribute("name") ?? "")
      : [];
    const renames = new Map<string, string>();
    const newNames: string[] = [];
    for (const s of bSheets) {
      const old = s.getAttribute("name") ?? "Sheet";
      const nn = uniqueSheetName(old, usedNames);
      usedNames.add(nn.toLowerCase());
      newNames.push(nn);
      if (nn !== old) {
        renames.set(old, nn);
        renamedAny = true;
      }
    }
    // テーブル名の付け直し（ブックの中で重ならないように）
    const tableRenames = new Map<string, string>();

    const bLocalBase = sheetCount;
    const copied = new Map<string, string>();
    const fixFormulaText = (t: string) => {
      let s = renameSheetRefs(t, renames);
      for (const [o, n] of tableRenames) s = s.replace(new RegExp(`(^|[^A-Za-z0-9_.])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\[)`, "gi"), `$1${n}`);
      return s;
    };

    const copyPartRec = (src: string, transform?: (d: Document, srcPath: string) => void): string | null => {
      if (copied.has(src)) return copied.get(src)!;
      const data = b.files[src];
      if (!data) return null;
      const dst = uniquePartName(a.files, src, `m${k}`);
      copied.set(src, dst);
      a.ct.copyFrom(b.ct, src, dst);
      a.files[dst] = data;
      if (b.files[relsPathOf(src)]) {
        const rels = readRels(b.files, src);
        for (const r of listRels(rels)) {
          if (r.external) continue;
          const t = resolveTarget(src, r.target);
          const isChart = relTypeIs(r.type, "chart");
          const nt = copyPartRec(t, isChart ? (d) => {
            for (const f of byLocal(d, "f")) if (f.textContent) f.textContent = fixFormulaText(f.textContent);
          } : undefined);
          if (nt) r.el.setAttribute("Target", relativeTarget(dst, nt));
        }
        a.files[relsPathOf(dst)] = xmlBytes(rels);
      }
      if (transform && /\.xml$/i.test(src)) {
        const d = readXml(b.files, src, "部品");
        if (d) {
          transform(d, src);
          a.files[dst] = xmlBytes(d);
        }
      }
      return dst;
    };

    // 先にテーブル名を決める（数式の中の構造化参照を直すため）
    for (const s of bSheets) {
      const p = sheetPartPath(b, s);
      if (!p) continue;
      for (const r of listRels(readRels(b.files, p))) {
        if (!relTypeIs(r.type, "table") || r.external) continue;
        const t = readXml(b.files, resolveTarget(p, r.target), "テーブル");
        if (!t) continue;
        const name = t.documentElement.getAttribute("displayName") ?? t.documentElement.getAttribute("name") ?? "";
        if (!tableNames.has(name.toLowerCase())) {
          tableNames.add(name.toLowerCase());
          continue;
        }
        let n = 2;
        while (tableNames.has(`${name}_${n}`.toLowerCase())) n++;
        tableRenames.set(name, `${name}_${n}`);
        tableNames.add(`${name}_${n}`.toLowerCase());
      }
    }

    for (const [i, s] of bSheets.entries()) {
      const p = sheetPartPath(b, s);
      if (!p || !b.files[p]) continue;
      const rels = listRels(b.wbRels);
      const rel = rels.find((r) => r.id === s.getAttributeNS(REL_NS, "id"))!;
      const isWorksheet = relTypeIs(rel.type, "worksheet");
      const sheetDoc = readXml(b.files, p, inputs[k].name)!;
      if (isWorksheet) {
        const dropped = dropRefsToRemoved(sheetDoc, removedLowerB, removedNamesB, removedTablesB);
        selectionConverted += dropped.converted;
        if (dropped.removedRules > 0) notices.add("選ばなかったシートを参照する入力規則・条件付き書式は、参照先がなくなるため外しました。");
        // セルの書式・共有の文字列・数式
        for (const c of byLocal(sheetDoc, "c")) {
          const st = c.getAttribute("s");
          if (st !== null && maps.xf.has(Number(st))) c.setAttribute("s", String(maps.xf.get(Number(st))));
          if (c.getAttribute("t") === "s") {
            const v = firstChild(c, "v");
            if (v && v.textContent !== null && /^\d+$/.test(v.textContent)) v.textContent = String(mapSst(Number(v.textContent)));
          }
        }
        for (const r of byLocal(sheetDoc, "row")) {
          const st = r.getAttribute("s");
          if (st !== null && maps.xf.has(Number(st))) r.setAttribute("s", String(maps.xf.get(Number(st))));
        }
        for (const col of byLocal(sheetDoc, "col")) {
          const st = col.getAttribute("style");
          if (st !== null && maps.xf.has(Number(st))) col.setAttribute("style", String(maps.xf.get(Number(st))));
        }
        for (const rule of byLocal(sheetDoc, "cfRule")) {
          const d = rule.getAttribute("dxfId");
          if (d !== null && maps.dxf.has(Number(d))) rule.setAttribute("dxfId", String(maps.dxf.get(Number(d))));
        }
        // 外部のブックを参照する数式は、値に置き換える（参照先の一覧を取り込まないため）
        externalConverted += formulasToValues(sheetDoc, (f) => sheetRefsIn(f).includes("[external]"));
        for (const f of byLocal(sheetDoc, "f")) if (f.textContent) f.textContent = fixFormulaText(f.textContent);
        for (const f of [...byLocal(sheetDoc, "formula1"), ...byLocal(sheetDoc, "formula2"), ...byLocal(sheetDoc, "formula")]) if (f.textContent) f.textContent = fixFormulaText(f.textContent);
        for (const h of byLocal(sheetDoc, "hyperlink")) {
          const loc = h.getAttribute("location");
          if (loc) h.setAttribute("location", fixFormulaText(loc));
        }
      }
      for (const sv of byLocal(sheetDoc, "sheetView")) sv.removeAttribute("tabSelected");

      // シートの関係（図形・コメント・テーブルなど）
      const newSheetPath = uniquePartName(a.files, p, `m${k}`);
      const srcRels = listRels(readRels(b.files, p));
      const newRels = emptyRelsDoc();
      const ridMap = new Map<string, string>();
      for (const r of srcRels) {
        const keep = SHEET_REL_KEEP.some((t) => relTypeIs(r.type, t)) || relTypeIs(r.type, "drawing");
        if (!keep) {
          if (relTypeIs(r.type, "pivotTable")) notices.add("ピボットテーブルは、結合したファイルでは集計の機能を持たない表（値）になります。");
          else if (/threadedComment/i.test(r.type)) notices.add("スレッド形式のコメントは、通常のコメント（メモ）として残ります。");
          else notices.add("スライサー・タイムラインなど、ブック全体の設定を使う一部の機能は、結合したファイルには含まれません。");
          continue;
        }
        let nid: string;
        if (r.external) nid = addRel(newRels, r.type, r.target, true, r.id);
        else {
          const src = resolveTarget(p, r.target);
          const isTable = relTypeIs(r.type, "table");
          const dst = copyPartRec(src, isTable ? (d) => {
            const root = d.documentElement;
            const name = root.getAttribute("displayName") ?? root.getAttribute("name") ?? "";
            const nn = tableRenames.get(name);
            if (nn) {
              root.setAttribute("displayName", nn);
              root.setAttribute("name", nn);
            }
            root.setAttribute("id", String(nextTableId++));
            for (const f of [...byLocal(d, "calculatedColumnFormula"), ...byLocal(d, "totalsRowFormula")]) if (f.textContent) f.textContent = fixFormulaText(f.textContent);
          } : undefined);
          if (!dst) continue;
          nid = addRel(newRels, r.type, relativeTarget(newSheetPath, dst), false, r.id);
        }
        ridMap.set(r.id, nid);
      }
      // 外した関係を指している要素を外す
      for (const e of Array.from(sheetDoc.getElementsByTagName("*"))) {
        for (const attr of Array.from(e.attributes)) {
          if (attr.namespaceURI !== REL_NS) continue;
          const nid = ridMap.get(attr.value);
          if (nid) {
            e.setAttributeNS(REL_NS, attr.name, nid);
            continue;
          }
          // 外の拡張（extLst の ext）の中なら、ext ごと外す
          let target: Element | null = e;
          let p2: Element | null = e;
          while (p2) {
            if (p2.localName === "ext" && p2.parentElement?.localName === "extLst") {
              target = p2;
              break;
            }
            p2 = p2.parentElement;
          }
          target?.parentNode?.removeChild(target);
          break;
        }
      }
      for (const tp of byLocal(sheetDoc, "tableParts")) tp.setAttribute("count", String(childrenByLocal(tp, "tablePart").length));
      for (const lst of byLocal(sheetDoc, "extLst")) if (lst.children.length === 0) lst.parentNode?.removeChild(lst);
      a.files[newSheetPath] = xmlBytes(sheetDoc);
      if (listRels(newRels).length > 0) a.files[relsPathOf(newSheetPath)] = xmlBytes(newRels);
      a.ct.copyFrom(b.ct, p, newSheetPath);

      // ブックへシートを足す
      const rid = addRel(a.wbRels, rel.type, relativeTarget(a.wbPath, newSheetPath));
      const sheetEl = el(a.wb, "sheet");
      sheetEl.setAttribute("name", newNames[i]);
      sheetEl.setAttribute("sheetId", String(nextSheetId++));
      const state = s.getAttribute("state");
      if (state && state !== "visible") sheetEl.setAttribute("state", state);
      sheetEl.setAttributeNS(REL_NS, "r:id", rid);
      if (!a.wb.documentElement.lookupPrefix(REL_NS)) a.wb.documentElement.setAttributeNS(XMLNS_NS, "xmlns:r", REL_NS);
      aSheetsList.appendChild(sheetEl);
    }

    // 名前の定義
    const bDefined = byLocal(b.wb, "definedNames")[0];
    if (bDefined) {
      const ensureDefined = () => {
        if (aDefinedNames) return aDefinedNames;
        aDefinedNames = el(a.wb, "definedNames");
        const after = ["calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
        const root = a.wb.documentElement;
        const before = Array.from(root.children).find((c) => after.includes(c.localName));
        root.insertBefore(aDefinedNames, before ?? null);
        return aDefinedNames;
      };
      for (const dn of childrenByLocal(bDefined, "definedName")) {
        const text = dn.textContent ?? "";
        if (sheetRefsIn(text).includes("[external]")) continue;
        const name = dn.getAttribute("name") ?? "";
        const local = dn.getAttribute("localSheetId");
        // 選ばなかったシートだけの名前・選ばなかったシートを参照する名前は、取り込まない
        if (local !== null && !localMap.has(Number(local))) continue;
        if (sheetRefsIn(text).some((r) => r !== "[external]" && removedLowerB.has(r.toLowerCase()))) continue;
        const add = (localId: number | null) => {
          const copy = a.wb.importNode(dn, true) as Element;
          copy.textContent = fixFormulaText(text);
          if (localId === null) copy.removeAttribute("localSheetId");
          else copy.setAttribute("localSheetId", String(localId));
          ensureDefined().appendChild(copy);
        };
        if (local !== null) add(bLocalBase + localMap.get(Number(local))!);
        else if (!aGlobalNames.has(name.toLowerCase())) {
          aGlobalNames.add(name.toLowerCase());
          add(null);
        } else {
          // 同じ名前が1つ目のブックにあるときは、このブックのシートだけで使う名前にする（それぞれの数式が元の意味のまま動く）
          for (let i = 0; i < bSheets.length; i++) add(bLocalBase + i);
          notices.add("同じ名前の「名前の定義」があるときは、元のブックのシートの中だけで使える名前として残しました。");
        }
      }
    }
    sheetCount += bSheets.length;
  }

  // 名前の定義の並び：Excel は名前の順に並んでいることを求めるわけではないが、localSheetId の範囲を確かめる
  if (aDefinedNames) {
    for (const dn of childrenByLocal(aDefinedNames, "definedName")) {
      const l = dn.getAttribute("localSheetId");
      if (l !== null && Number(l) >= sheetCount) dn.parentNode?.removeChild(dn);
    }
  }
  // 共有の文字列
  const sstRoot = sst.doc.documentElement;
  sstRoot.removeAttribute("count");
  sstRoot.setAttribute("uniqueCount", String(childrenByLocal(sstRoot, "si").length));
  a.files[sst.path] = xmlBytes(sst.doc);
  a.files[aStyles.path] = xmlBytes(aStyles.doc);
  dropDerivedParts(a);
  setFullCalcOnLoad(a);
  if (renamedAny) notices.add("同じ名前のシートは「名前 (2)」のように名前を変えました。そのシートを参照する数式・グラフも、新しい名前に合わせて直しています。");
  if (selectionConverted > 0) notices.add(`選ばなかったシートを参照していた数式${selectionConverted}個は、参照先のシートが結合したファイルにないため、保存されていた計算結果の値に置き換えました。`);
  if (externalConverted > 0) notices.add(`ほかのブック（外部ファイル）を参照していた数式${externalConverted}個は、保存されていた計算結果の値に置き換えました。`);
  if (sheetCount > 255) notices.add("シートの数が多いため、開くのに時間がかかることがあります。");
  const bytes = writeBook(a);
  return { files: [{ name: "merged", bytes }], notices: Array.from(notices) };
}
