import {
  addRel,
  byLocal,
  childrenByLocal,
  ContentTypes,
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
 * 複数の Word（.docx）を、1つの Word にまとめる（Word結合。2026-11-17）。
 *
 * 文字を取り出して作り直すのではなく、ファイルの中の XML（本文・表・画像・ヘッダー/フッター・セクション）を、
 * そのまま1つ目のファイルの後ろへつなげる。
 * - 各ファイルの終わりで新しいページ（セクション区切り）にし、用紙・向き・余白・ヘッダー/フッターをファイルごとに保つ。
 * - スタイル：同じ名前で中身が違うスタイルは、2つ目以降のファイルの方の名前を変えて、見た目が変わらないようにする。
 *   標準のフォント・文字の大きさ（既定の書式）が違うときは、2つ目以降のファイルの既定の書式をスタイルに写す。
 * - テーマのフォント（「本文のフォント」など）が違うときは、2つ目以降のファイルの方を、実際のフォント名に置き換える。
 * - 箇条書き・段落番号の定義、画像、図形、グラフ、ハイパーリンク、脚注・文末脚注も、番号を付け直して取り込む。
 * - 2つ目以降のファイルのコメントは取り込まない（コメントの印は外す）。文書全体の設定（奇数/偶数ページ別のヘッダーなど）は1つ目のファイルのものになる。
 * 処理はすべてブラウザの中で行う。
 */

export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";

const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const T_HEADER = `${REL_BASE}/header`;
const T_FOOTER = `${REL_BASE}/footer`;
const T_NUMBERING = `${REL_BASE}/numbering`;
const T_FOOTNOTES = `${REL_BASE}/footnotes`;
const T_ENDNOTES = `${REL_BASE}/endnotes`;
const CT_HEADER = "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml";
const CT_FOOTER = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
const CT_NUMBERING = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
const CT_FOOTNOTES = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
const CT_ENDNOTES = "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml";

/** 本文とは別にまとめて扱う（部品ごとには写さない）関係の種類 */
const SKIP_REL_TYPES = [
  "styles",
  "numbering",
  "settings",
  "webSettings",
  "fontTable",
  "theme",
  "footnotes",
  "endnotes",
  "comments",
  "commentsExtended",
  "commentsIds",
  "commentsExtensible",
  "people",
  "customXml",
  "glossaryDocument",
  "stylesWithEffects",
  "customXmlProps",
];

// 子要素の順番（Word は順番が違うと「読めない内容がある」と出すため、決まった順に入れる）
const RPR_ORDER = "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath".split(" ");
const PPR_ORDER = "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange".split(" ");
const STYLE_ORDER = "name aliases basedOn next link autoRedefine hidden uiPriority semiHidden unhideWhenUsed qFormat locked personal personalCompose personalReply rsid pPr rPr tblPr trPr tcPr tblStylePr".split(" ");
const SECT_ORDER = "headerReference footerReference footnotePr endnotePr type pgSz pgMar paperSrc pgBorders lnNumType pgNumType cols formProt vAlign noEndnote titlePg textDirection bidi rtlGutter docGrid printerSettings sectPrChange".split(" ");

export interface DocxMergeInput {
  name: string;
  bytes: Uint8Array;
}

export interface DocxMergeOptions {
  /** ページ番号：ファイルごとに1から振り直す（false のときは続けて振る） */
  restartPageNumbers: boolean;
}

export interface DocxMergeResult {
  bytes: Uint8Array;
  notices: string[];
}

export const MAX_DOCX_MERGE_FILES = 30;
export const MAX_DOCX_MERGE_MB = 100;

// ---------------------------------------------------------------------------
// 小さな部品
// ---------------------------------------------------------------------------

function wAttr(el: Element, name: string): string | null {
  return el.getAttributeNS(W_NS, name) ?? el.getAttribute(`w:${name}`);
}

function setWAttr(el: Element, name: string, value: string) {
  el.setAttributeNS(W_NS, `w:${name}`, value);
}

function wEl(doc: Document, local: string): Element {
  return doc.createElementNS(W_NS, `w:${local}`);
}

/** 決まった順番を守って、子要素を入れる */
function insertOrdered(parent: Element, child: Element, order: string[]) {
  const idx = order.indexOf(child.localName);
  if (idx < 0) {
    parent.appendChild(child);
    return;
  }
  const after = Array.from(parent.children).find((c) => {
    const i = order.indexOf(c.localName);
    return i > idx;
  });
  parent.insertBefore(child, after ?? null);
}

function ensureChild(parent: Element, local: string, order: string[]): Element {
  const found = firstChild(parent, local);
  if (found) return found;
  const el = wEl(parent.ownerDocument, local);
  insertOrdered(parent, el, order);
  return el;
}

function normalizeXml(el: Element | null): string {
  if (!el) return "";
  return new XMLSerializer()
    .serializeToString(el)
    .replace(/\s+xmlns(:\w+)?="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .trim();
}

function maxNumAttr(els: Element[], name: string): number {
  let m = 0;
  for (const el of els) {
    const v = Number(wAttr(el, name));
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

/** B の部品の中の w:* の値（スタイルの名前など）を置き換える */
function remapVal(root: Element | Document, local: string, map: Map<string, string>) {
  for (const el of byLocal(root, local)) {
    if (el.namespaceURI !== W_NS) continue;
    const v = wAttr(el, "val");
    if (v !== null && map.has(v)) setWAttr(el, "val", map.get(v)!);
  }
}

// ---------------------------------------------------------------------------
// テーマのフォント
// ---------------------------------------------------------------------------

interface ThemeFonts {
  majorLatin: string;
  majorEa: string;
  majorCs: string;
  minorLatin: string;
  minorEa: string;
  minorCs: string;
}

function readThemeFonts(files: Files, docPath: string): ThemeFonts | null {
  const rels = listRels(readRels(files, docPath));
  const themeRel = rels.find((r) => relTypeIs(r.type, "theme"));
  if (!themeRel) return null;
  const theme = readXml(files, resolveTarget(docPath, themeRel.target), "テーマ");
  if (!theme) return null;
  const pick = (kind: "majorFont" | "minorFont") => {
    const f = byLocal(theme, kind)[0];
    if (!f) return { latin: "", ea: "", cs: "" };
    const typeface = (local: string) => (Array.from(f.children).find((c) => c.localName === local)?.getAttribute("typeface") ?? "");
    let ea = typeface("ea");
    if (!ea) ea = Array.from(f.children).find((c) => c.localName === "font" && c.getAttribute("script") === "Jpan")?.getAttribute("typeface") ?? "";
    return { latin: typeface("latin"), ea, cs: typeface("cs") };
  };
  const major = pick("majorFont");
  const minor = pick("minorFont");
  return { majorLatin: major.latin, majorEa: major.ea, majorCs: major.cs, minorLatin: minor.latin, minorEa: minor.ea, minorCs: minor.cs };
}

/** rFonts の「テーマのフォント」を、実際のフォント名に置き換える */
function resolveThemeFonts(root: Element | Document, t: ThemeFonts) {
  const value = (theme: string) => {
    if (theme.startsWith("major")) return theme.endsWith("EastAsia") ? t.majorEa : theme.endsWith("Bidi") ? t.majorCs : t.majorLatin;
    return theme.endsWith("EastAsia") ? t.minorEa : theme.endsWith("Bidi") ? t.minorCs : t.minorLatin;
  };
  const pairs: [string, string][] = [
    ["asciiTheme", "ascii"],
    ["hAnsiTheme", "hAnsi"],
    ["eastAsiaTheme", "eastAsia"],
    ["cstheme", "cs"],
  ];
  for (const el of byLocal(root, "rFonts")) {
    if (el.namespaceURI !== W_NS) continue;
    for (const [themeAttr, plain] of pairs) {
      const theme = wAttr(el, themeAttr);
      if (!theme) continue;
      const font = value(theme);
      if (!font) continue;
      setWAttr(el, plain, font);
      el.removeAttributeNS(W_NS, themeAttr);
    }
  }
}

// ---------------------------------------------------------------------------
// 結合
// ---------------------------------------------------------------------------

interface Ctx {
  files: Files;
  ct: ContentTypes;
  docPath: string;
  doc: Document;
  body: Element;
  rels: Document;
  styles: Document | null;
  stylesPath: string | null;
  numbering: Document | null;
  numberingPath: string | null;
  footnotes: Document | null;
  footnotesPath: string | null;
  endnotes: Document | null;
  endnotesPath: string | null;
  fontTable: Document | null;
  theme: ThemeFonts | null;
  notices: Set<string>;
  /** 図形の番号（wp:docPr の id）の次の値 */
  nextDrawingId: number;
  nextBookmarkId: number;
  bookmarkNames: Set<string>;
  /** これまでの区切りに、ヘッダー・フッターがあったか */
  hadHeader: boolean;
  hadFooter: boolean;
}

function mainDocumentPath(files: Files, label: string): string {
  const rootRels = listRels(readRels(files, ""));
  const office = rootRels.find((r) => relTypeIs(r.type, "officeDocument"));
  const path = office ? resolveTarget("", office.target) : "word/document.xml";
  if (!files[path]) throw new OoxmlError(`${label}は、Word（.docx）の文書として読み取れませんでした。`);
  const ct = new ContentTypes(files).typeOf(path) ?? "";
  if (/macroEnabled/i.test(ct)) throw new OoxmlError(`${label}はマクロ付きの文書（.docm）のため、結合できません。`);
  if (/template/i.test(ct)) {
    // テンプレート（.dotx）も中身は同じなので、そのまま扱う
  }
  return path;
}

function partOf(files: Files, docPath: string, relsDoc: Document, type: string): string | null {
  const r = listRels(relsDoc).find((x) => relTypeIs(x.type, type) && !x.external);
  return r ? resolveTarget(docPath, r.target) : null;
}

function openCtx(input: DocxMergeInput): Ctx {
  const files = unzipPackage(input.bytes, input.name);
  if (files["EncryptedPackage"]) throw new OoxmlError(`${input.name}はパスワードが付いているため、結合できません。`);
  const docPath = mainDocumentPath(files, input.name);
  const doc = readXml(files, docPath, input.name)!;
  const body = byLocal(doc, "body")[0];
  if (!body) throw new OoxmlError(`${input.name}の本文が見つかりませんでした。`);
  const rels = readRels(files, docPath);
  const stylesPath = partOf(files, docPath, rels, "styles");
  const numberingPath = partOf(files, docPath, rels, "numbering");
  const footnotesPath = partOf(files, docPath, rels, "footnotes");
  const endnotesPath = partOf(files, docPath, rels, "endnotes");
  const fontPath = partOf(files, docPath, rels, "fontTable");
  return {
    files,
    ct: new ContentTypes(files),
    docPath,
    doc,
    body,
    rels,
    styles: stylesPath ? readXml(files, stylesPath, "スタイル") : null,
    stylesPath,
    numbering: numberingPath ? readXml(files, numberingPath, "箇条書きの定義") : null,
    numberingPath,
    footnotes: footnotesPath ? readXml(files, footnotesPath, "脚注") : null,
    footnotesPath,
    endnotes: endnotesPath ? readXml(files, endnotesPath, "文末脚注") : null,
    endnotesPath,
    fontTable: fontPath ? readXml(files, fontPath, "フォントの一覧") : null,
    theme: readThemeFonts(files, docPath),
    notices: new Set(),
    nextDrawingId: 1,
    nextBookmarkId: 0,
    bookmarkNames: new Set(),
    hadHeader: false,
    hadFooter: false,
  };
}

/** 本文の最後のセクションの設定（body の直下の sectPr） */
function bodySectPr(body: Element): Element | null {
  const last = body.lastElementChild;
  return last && last.localName === "sectPr" ? last : null;
}

/** ルートの名前空間の宣言・mc:Ignorable を、取り込む側へ足す（Word が知らない書き方で止まらないように） */
function mergeNamespaces(dst: Element, src: Element) {
  for (const attr of Array.from(src.attributes)) {
    if (attr.namespaceURI === XMLNS_NS && attr.prefix === "xmlns") {
      if (!dst.hasAttributeNS(XMLNS_NS, attr.localName)) dst.setAttributeNS(XMLNS_NS, `xmlns:${attr.localName}`, attr.value);
    }
  }
  const srcIgn = (src.getAttributeNS(MC_NS, "Ignorable") ?? "").split(/\s+/).filter(Boolean);
  if (srcIgn.length) {
    const dstIgn = (dst.getAttributeNS(MC_NS, "Ignorable") ?? "").split(/\s+/).filter(Boolean);
    const merged = Array.from(new Set([...dstIgn, ...srcIgn])).filter((p) => dst.lookupNamespaceURI(p));
    if (!dst.hasAttributeNS(XMLNS_NS, "mc")) dst.setAttributeNS(XMLNS_NS, "xmlns:mc", MC_NS);
    dst.setAttributeNS(MC_NS, "mc:Ignorable", merged.join(" "));
  }
}

/**
 * 部品（ヘッダー・画像・グラフなど）を、その先の部品ごと A へ写す。戻り値は A の中の新しい部品の名前。
 * transform：XML の部品（ヘッダー・フッター）を写す前に書き換える処理
 */
function copyPart(a: Ctx, b: Ctx, srcPath: string, k: number, copied: Map<string, string>, transform?: (d: Document, path: string) => void): string | null {
  if (copied.has(srcPath)) return copied.get(srcPath)!;
  const data = b.files[srcPath];
  if (!data) return null;
  const dstPath = uniquePartName(a.files, srcPath, `m${k}`);
  copied.set(srcPath, dstPath);
  a.ct.copyFrom(b.ct, srcPath, dstPath);
  // 先に入れておく（同じ部品を指す関係が循環しても止まらないように）
  a.files[dstPath] = data;
  const srcRels = b.files[relsPathOf(srcPath)] ? readRels(b.files, srcPath) : null;
  if (srcRels) {
    for (const r of listRels(srcRels)) {
      if (r.external) continue;
      const target = resolveTarget(srcPath, r.target);
      const newTarget = copyPart(a, b, target, k, copied);
      if (newTarget) r.el.setAttribute("Target", relativeTarget(dstPath, newTarget));
    }
    a.files[relsPathOf(dstPath)] = xmlBytes(srcRels);
  }
  if (transform && /\.xml$/i.test(srcPath)) {
    const d = readXml(b.files, srcPath, "部品");
    if (d) {
      transform(d, dstPath);
      a.files[dstPath] = xmlBytes(d);
    }
  }
  return dstPath;
}

/**
 * B の XML の中の r:id・r:embed などを、A の関係に付け替える（必要な部品は A へ写す）。
 * srcPart：B での部品の名前（関係の起点）、dstRels・dstPart：A での関係の一覧と部品の名前
 */
function importRels(a: Ctx, b: Ctx, root: Element | Document, srcPart: string, dstRels: Document, dstPart: string, k: number, copied: Map<string, string>, transform: (d: Document, path: string) => void) {
  const srcRels = listRels(readRels(b.files, srcPart));
  const map = new Map<string, string>();
  const all = root instanceof Document ? [root.documentElement, ...Array.from(root.documentElement.getElementsByTagName("*"))] : [root, ...Array.from(root.getElementsByTagName("*"))];
  const ensure = (oldId: string): string | null => {
    if (map.has(oldId)) return map.get(oldId)!;
    const r = srcRels.find((x) => x.id === oldId);
    if (!r) return null;
    if (SKIP_REL_TYPES.some((t) => relTypeIs(r.type, t))) return null;
    let newId: string;
    if (r.external) newId = addRel(dstRels, r.type, r.target, true);
    else {
      const src = resolveTarget(srcPart, r.target);
      const isHf = relTypeIs(r.type, "header") || relTypeIs(r.type, "footer");
      const dst = copyPart(a, b, src, k, copied, isHf ? transform : undefined);
      if (!dst) return null;
      newId = addRel(dstRels, r.type, relativeTarget(dstPart, dst));
    }
    map.set(oldId, newId);
    return newId;
  };
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.namespaceURI !== REL_NS) continue;
      const nid = ensure(attr.value);
      if (nid) el.setAttributeNS(REL_NS, attr.name, nid);
    }
  }
}

/** スタイルの対応表を作り、必要なスタイルを A へ足す。戻り値：B のスタイル名 → A でのスタイル名 */
function mergeStyles(a: Ctx, b: Ctx, k: number, numMap: Map<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  if (!b.styles) return map;
  if (!a.styles) {
    // A にスタイルの部品がなければ、B のものをそのまま使う
    const path = "word/styles.xml";
    a.styles = b.styles.cloneNode(true) as Document;
    a.stylesPath = path;
    addRel(a.rels, `${REL_BASE}/styles`, relativeTarget(a.docPath, path));
    a.ct.setOverride(path, "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml");
    for (const s of byLocal(b.styles, "style")) {
      const id = wAttr(s, "styleId");
      if (id) map.set(id, id);
    }
    return map;
  }
  const aRoot = a.styles.documentElement;
  const aStyles = new Map<string, Element>();
  for (const s of childrenByLocal(aRoot, "style")) {
    const id = wAttr(s, "styleId");
    if (id) aStyles.set(id, s);
  }
  const aNames = new Set(childrenByLocal(aRoot, "style").map((s) => {
    const n = firstChild(s, "name");
    return n ? wAttr(n, "val") ?? "" : "";
  }));
  const aDefaults = firstChild(aRoot, "docDefaults");
  const bDefaults = firstChild(b.styles.documentElement, "docDefaults");
  const defaultsSame = normalizeXml(aDefaults) === normalizeXml(bDefaults);
  const bStyles = childrenByLocal(b.styles.documentElement, "style");

  // 名前を変えるもの・そのまま使うもの・足すものを決める
  const toAdd: Element[] = [];
  const renamed = new Set<string>();
  for (const s of bStyles) {
    const id = wAttr(s, "styleId");
    if (!id) continue;
    const existing = aStyles.get(id);
    if (defaultsSame && existing && normalizeXml(existing) === normalizeXml(s)) {
      map.set(id, id);
      continue;
    }
    if (!existing && defaultsSame) {
      map.set(id, id);
      toAdd.push(s);
      continue;
    }
    let nid = `${id}M${k}`;
    for (let n = 2; aStyles.has(nid) || Array.from(map.values()).includes(nid); n++) nid = `${id}M${k}_${n}`;
    map.set(id, nid);
    renamed.add(id);
    toAdd.push(s);
  }
  if (renamed.size > 0) a.notices.add("スタイルの名前が同じで中身が違うものは、見た目を保つため、2つ目以降のファイルのスタイルに番号を付けて分けました（スタイルの一覧に「（2）」などが付いたものが増えます）。");

  // B の既定の書式（docDefaults）
  const bRprDef = bDefaults ? byLocal(bDefaults, "rPrDefault")[0]?.firstElementChild ?? null : null;
  const bPprDef = bDefaults ? byLocal(bDefaults, "pPrDefault")[0]?.firstElementChild ?? null : null;

  for (const s of toAdd) {
    const id = wAttr(s, "styleId")!;
    const copy = a.styles.importNode(s, true) as Element;
    const nid = map.get(id)!;
    setWAttr(copy, "styleId", nid);
    for (const local of ["basedOn", "next", "link"]) {
      const ref = firstChild(copy, local);
      if (!ref) continue;
      const v = wAttr(ref, "val");
      if (v && map.has(v)) setWAttr(ref, "val", map.get(v)!);
    }
    if (renamed.has(id)) {
      copy.removeAttributeNS(W_NS, "default");
      const nameEl = firstChild(copy, "name");
      if (nameEl) {
        let name = `${wAttr(nameEl, "val") ?? id} (${k + 1})`;
        for (let n = 2; aNames.has(name); n++) name = `${wAttr(nameEl, "val") ?? id} (${k + 1}-${n})`;
        setWAttr(nameEl, "val", name);
        aNames.add(name);
      }
      // 元になるスタイルがない段落・表のスタイルには、B の既定の書式を写す（A の既定の書式で見た目が変わらないように）
      const type = wAttr(copy, "type");
      if (!defaultsSame && !firstChild(copy, "basedOn") && (type === "paragraph" || type === "table")) {
        if (bRprDef) {
          const rPr = ensureChild(copy, "rPr", STYLE_ORDER);
          for (const c of Array.from(bRprDef.children)) if (!firstChild(rPr, c.localName)) insertOrdered(rPr, a.styles.importNode(c, true) as Element, RPR_ORDER);
        }
        if (bPprDef && type === "paragraph") {
          const pPr = ensureChild(copy, "pPr", STYLE_ORDER);
          for (const c of Array.from(bPprDef.children)) if (!firstChild(pPr, c.localName)) insertOrdered(pPr, a.styles.importNode(c, true) as Element, PPR_ORDER);
        }
      }
    }
    remapVal(copy, "numId", numMap);
    if (b.theme && a.theme && JSON.stringify(a.theme) !== JSON.stringify(b.theme)) resolveThemeFonts(copy, b.theme);
    aRoot.appendChild(copy);
  }
  return map;
}

/** 箇条書き・段落番号の定義を A へ足す。戻り値：B の numId → A の numId */
function mergeNumbering(a: Ctx, b: Ctx): Map<string, string> {
  const map = new Map<string, string>();
  if (!b.numbering) return map;
  if (!a.numbering) {
    const path = "word/numbering.xml";
    a.numbering = a.doc.implementation.createDocument(W_NS, "w:numbering", null);
    a.numberingPath = path;
    addRel(a.rels, T_NUMBERING, relativeTarget(a.docPath, path));
    a.ct.setOverride(path, CT_NUMBERING);
  }
  const aRoot = a.numbering.documentElement;
  const bRoot = b.numbering.documentElement;
  mergeNamespaces(aRoot, bRoot);
  const absOffset = maxNumAttr(childrenByLocal(aRoot, "abstractNum"), "abstractNumId") + 1;
  const numOffset = maxNumAttr(childrenByLocal(aRoot, "num"), "numId") + 1;
  const absMap = new Map<string, string>();
  const firstNum = childrenByLocal(aRoot, "num")[0] ?? firstChild(aRoot, "numIdMacAtCleanup");
  for (const an of childrenByLocal(bRoot, "abstractNum")) {
    const copy = a.numbering.importNode(an, true) as Element;
    const old = wAttr(an, "abstractNumId") ?? "0";
    const nid = String(Number(old) + absOffset);
    absMap.set(old, nid);
    setWAttr(copy, "abstractNumId", nid);
    // 同じ識別番号（nsid）だと、Word が別のファイルの番号と続けてしまうため、付け直す
    const nsid = firstChild(copy, "nsid");
    if (nsid) setWAttr(nsid, "val", Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase().padStart(8, "0"));
    for (const pb of byLocal(copy, "lvlPicBulletId")) pb.parentNode?.removeChild(pb);
    aRoot.insertBefore(copy, firstNum ?? null);
  }
  const cleanup = firstChild(aRoot, "numIdMacAtCleanup");
  for (const num of childrenByLocal(bRoot, "num")) {
    const copy = a.numbering.importNode(num, true) as Element;
    const old = wAttr(num, "numId") ?? "0";
    const nid = String(Number(old) + numOffset);
    map.set(old, nid);
    setWAttr(copy, "numId", nid);
    const ref = firstChild(copy, "abstractNumId");
    if (ref) {
      const v = wAttr(ref, "val") ?? "";
      if (absMap.has(v)) setWAttr(ref, "val", absMap.get(v)!);
    }
    aRoot.insertBefore(copy, cleanup ?? null);
  }
  if (childrenByLocal(bRoot, "numPicBullet").length > 0) a.notices.add("2つ目以降のファイルの「画像の行頭文字」は、標準の行頭文字になります。");
  map.set("0", "0");
  return map;
}

/** 脚注・文末脚注を A へ足す。戻り値：B の id → A の id */
function mergeNotes(a: Ctx, b: Ctx, kind: "footnote" | "endnote", k: number, copied: Map<string, string>, transformB: (root: Element | Document) => void, transformPart: (d: Document, path: string) => void): Map<string, string> {
  const map = new Map<string, string>();
  const bDoc = kind === "footnote" ? b.footnotes : b.endnotes;
  const bPath = kind === "footnote" ? b.footnotesPath : b.endnotesPath;
  if (!bDoc || !bPath) return map;
  const notes = childrenByLocal(bDoc.documentElement, kind).filter((n) => !wAttr(n, "type") || wAttr(n, "type") === "normal");
  if (notes.length === 0) return map;
  let aDoc = kind === "footnote" ? a.footnotes : a.endnotes;
  let aPath = kind === "footnote" ? a.footnotesPath : a.endnotesPath;
  if (!aDoc || !aPath) {
    // A に脚注の部品がなければ、B の区切り線（separator など）だけを持った部品を作る
    aPath = kind === "footnote" ? "word/footnotes.xml" : "word/endnotes.xml";
    aDoc = bDoc.cloneNode(true) as Document;
    for (const n of childrenByLocal(aDoc.documentElement, kind)) if (!wAttr(n, "type") || wAttr(n, "type") === "normal") n.parentNode?.removeChild(n);
    addRel(a.rels, kind === "footnote" ? T_FOOTNOTES : T_ENDNOTES, relativeTarget(a.docPath, aPath));
    a.ct.setOverride(aPath, kind === "footnote" ? CT_FOOTNOTES : CT_ENDNOTES);
    if (kind === "footnote") {
      a.footnotes = aDoc;
      a.footnotesPath = aPath;
    } else {
      a.endnotes = aDoc;
      a.endnotesPath = aPath;
    }
  }
  mergeNamespaces(aDoc.documentElement, bDoc.documentElement);
  const aRels = readRels(a.files, aPath);
  let next = maxNumAttr(childrenByLocal(aDoc.documentElement, kind), "id") + 1;
  for (const n of notes) {
    const copy = aDoc.importNode(n, true) as Element;
    const old = wAttr(n, "id") ?? "";
    const nid = String(next++);
    map.set(old, nid);
    setWAttr(copy, "id", nid);
    transformB(copy);
    importRels(a, b, copy, bPath, aRels, aPath, k, copied, transformPart);
    aDoc.documentElement.appendChild(copy);
  }
  if (listRels(aRels).length > 0) a.files[relsPathOf(aPath)] = xmlBytes(aRels);
  return map;
}

function addFontsFrom(a: Ctx, b: Ctx) {
  if (!a.fontTable || !b.fontTable) return;
  const names = new Set(childrenByLocal(a.fontTable.documentElement, "font").map((f) => wAttr(f, "name")));
  for (const f of childrenByLocal(b.fontTable.documentElement, "font")) {
    if (names.has(wAttr(f, "name"))) continue;
    const copy = a.fontTable.importNode(f, true) as Element;
    for (const emb of Array.from(copy.children)) if (/^embed/.test(emb.localName)) copy.removeChild(emb);
    a.fontTable.documentElement.appendChild(copy);
  }
}

/** 空のヘッダー・フッターを作る（前のファイルのヘッダー・フッターが、次のファイルに引き継がれないように） */
function emptyHeaderFooter(a: Ctx, kind: "header" | "footer"): string {
  const path = uniquePartName(a.files, `word/${kind}_empty.xml`, "m");
  const tag = kind === "header" ? "hdr" : "ftr";
  a.files[path] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${tag} xmlns:w="${W_NS}"><w:p/></w:${tag}>`);
  a.ct.setOverride(path, kind === "header" ? CT_HEADER : CT_FOOTER);
  return addRel(a.rels, kind === "header" ? T_HEADER : T_FOOTER, relativeTarget(a.docPath, path));
}

function sectHasRefs(sect: Element, local: "headerReference" | "footerReference"): boolean {
  return childrenByLocal(sect, local).length > 0;
}

export async function mergeDocx(inputs: DocxMergeInput[], options: DocxMergeOptions): Promise<DocxMergeResult> {
  if (inputs.length < 2) throw new OoxmlError("結合するには、Wordのファイルを2つ以上選んでください。");
  if (inputs.length > MAX_DOCX_MERGE_FILES) throw new OoxmlError(`一度に結合できるのは${MAX_DOCX_MERGE_FILES}ファイルまでです。`);
  const a = openCtx(inputs[0]);
  const aRoot = a.doc.documentElement;
  a.nextDrawingId = maxNumAttrAny(a) + 1;
  a.nextBookmarkId = maxNumAttr(byLocal(a.doc, "bookmarkStart"), "id") + 1;
  for (const bm of byLocal(a.doc, "bookmarkStart")) a.bookmarkNames.add(wAttr(bm, "name") ?? "");
  const firstSect = bodySectPr(a.body);
  for (const s of [...byLocal(a.body, "sectPr")]) {
    if (sectHasRefs(s, "headerReference")) a.hadHeader = true;
    if (sectHasRefs(s, "footerReference")) a.hadFooter = true;
  }
  if (!firstSect) {
    // セクションの設定がない文書は、Word の標準の用紙（A4・余白「標準」）として扱う
    const s = wEl(a.doc, "sectPr");
    a.body.appendChild(s);
  }

  for (let k = 1; k < inputs.length; k++) {
    const b = openCtx(inputs[k]);
    mergeNamespaces(aRoot, b.doc.documentElement);
    const copied = new Map<string, string>();

    const numMap = mergeNumbering(a, b);
    const styleMap = mergeStyles(a, b, k, numMap);
    const themeDiffers = !!(b.theme && a.theme && JSON.stringify(a.theme) !== JSON.stringify(b.theme));
    if (themeDiffers) a.notices.add("テーマのフォント（「本文のフォント」など）が違うファイルは、見た目を保つため、実際のフォント名を指定した形にしました。");

    // B の既定の段落スタイル・表のスタイル（スタイルの指定がない段落・表に使われるもの）
    const bDefaultStyle = (type: string) => {
      if (!b.styles) return null;
      const s = childrenByLocal(b.styles.documentElement, "style").find((x) => wAttr(x, "type") === type && (wAttr(x, "default") === "1" || wAttr(x, "default") === "true"));
      return s ? wAttr(s, "styleId") : null;
    };
    const aDefaultStyle = (type: string) => {
      if (!a.styles) return null;
      const s = childrenByLocal(a.styles.documentElement, "style").find((x) => wAttr(x, "type") === type && (wAttr(x, "default") === "1" || wAttr(x, "default") === "true"));
      return s ? wAttr(s, "styleId") : null;
    };
    const bDefP = bDefaultStyle("paragraph");
    const bDefT = bDefaultStyle("table");
    const needPStyle = bDefP && styleMap.get(bDefP) !== aDefaultStyle("paragraph") ? styleMap.get(bDefP)! : null;
    const needTStyle = bDefT && styleMap.get(bDefT) !== aDefaultStyle("table") ? styleMap.get(bDefT)! : null;

    let removedComments = false;
    // B の XML（本文・ヘッダー・フッター・脚注）に共通の書き換え
    const transformB = (root: Element | Document) => {
      remapVal(root, "pStyle", styleMap);
      remapVal(root, "rStyle", styleMap);
      remapVal(root, "tblStyle", styleMap);
      remapVal(root, "numId", numMap);
      if (needPStyle) {
        for (const p of byLocal(root, "p")) {
          if (p.namespaceURI !== W_NS) continue;
          let pPr = firstChild(p, "pPr");
          if (pPr && firstChild(pPr, "pStyle")) continue;
          if (!pPr) {
            pPr = wEl(p.ownerDocument, "pPr");
            p.insertBefore(pPr, p.firstChild);
          }
          const ps = wEl(p.ownerDocument, "pStyle");
          setWAttr(ps, "val", needPStyle);
          pPr.insertBefore(ps, pPr.firstChild);
        }
      }
      if (needTStyle) {
        for (const tblPr of byLocal(root, "tblPr")) {
          if (tblPr.namespaceURI !== W_NS || tblPr.parentElement?.localName !== "tbl" || firstChild(tblPr, "tblStyle")) continue;
          const ts = wEl(tblPr.ownerDocument, "tblStyle");
          setWAttr(ts, "val", needTStyle);
          tblPr.insertBefore(ts, tblPr.firstChild);
        }
      }
      if (themeDiffers) resolveThemeFonts(root, b.theme!);
      // コメントの印を外す
      for (const local of ["commentRangeStart", "commentRangeEnd"]) {
        for (const el of byLocal(root, local)) {
          el.parentNode?.removeChild(el);
          removedComments = true;
        }
      }
      for (const ref of byLocal(root, "commentReference")) {
        const run = ref.parentElement;
        if (run && run.localName === "r") run.parentNode?.removeChild(run);
        else ref.parentNode?.removeChild(ref);
        removedComments = true;
      }
      // 図形の番号（重なると Word が「読めない内容がある」と出す）
      for (const el of byLocal(root, "docPr")) el.setAttribute("id", String(a.nextDrawingId++));
      // 段落の識別番号（任意の値）は外す（重なりを避ける）
      for (const el of [root instanceof Document ? root.documentElement : root, ...Array.from((root instanceof Document ? root.documentElement : root).getElementsByTagName("*"))]) {
        if (el.hasAttributeNS(W14_NS, "paraId")) el.removeAttributeNS(W14_NS, "paraId");
        if (el.hasAttributeNS(W14_NS, "textId")) el.removeAttributeNS(W14_NS, "textId");
      }
    };
    const transformPart = (d: Document) => {
      transformB(d);
      // ヘッダー・フッターの中のしおり
      fixBookmarks(a, d);
    };

    const fnMap = mergeNotes(a, b, "footnote", k, copied, transformB, transformPart);
    const enMap = mergeNotes(a, b, "endnote", k, copied, transformB, transformPart);
    addFontsFrom(a, b);

    // 本文を写す
    const bBody = b.body;
    const bLastSect = bodySectPr(bBody);
    const fragment = Array.from(bBody.children).filter((c) => c !== bLastSect);
    const imported = fragment.map((c) => a.doc.importNode(c, true) as Element);
    const lastSectImported = bLastSect ? (a.doc.importNode(bLastSect, true) as Element) : wEl(a.doc, "sectPr");
    const holder = wEl(a.doc, "body");
    for (const el of imported) holder.appendChild(el);
    holder.appendChild(lastSectImported);
    transformB(holder);
    fixBookmarks(a, holder);
    for (const ref of byLocal(holder, "footnoteReference")) {
      const v = wAttr(ref, "id");
      if (v && fnMap.has(v)) setWAttr(ref, "id", fnMap.get(v)!);
    }
    for (const ref of byLocal(holder, "endnoteReference")) {
      const v = wAttr(ref, "id");
      if (v && enMap.has(v)) setWAttr(ref, "id", enMap.get(v)!);
    }
    importRels(a, b, holder, b.docPath, a.rels, a.docPath, k, copied, transformPart);
    if (removedComments) a.notices.add("2つ目以降のファイルのコメントは、結合したファイルには含まれません（本文はそのまま残ります）。");

    // B の最初のセクション（ヘッダー・フッターを前のセクションから引き継がないように、なければ空のものを付ける）
    const bFirstSect = byLocal(holder, "sectPr")[0];
    const bHasHeader = byLocal(holder, "sectPr").some((s) => sectHasRefs(s, "headerReference"));
    const bHasFooter = byLocal(holder, "sectPr").some((s) => sectHasRefs(s, "footerReference"));
    if (bFirstSect) {
      if (a.hadHeader && !sectHasRefs(bFirstSect, "headerReference")) addHfRef(a, bFirstSect, "header");
      if (a.hadFooter && !sectHasRefs(bFirstSect, "footerReference")) addHfRef(a, bFirstSect, "footer");
      // 新しいページから始める
      const type = firstChild(bFirstSect, "type");
      if (type && wAttr(type, "val") === "continuous") setWAttr(type, "val", "nextPage");
      if (options.restartPageNumbers) {
        const pg = ensureChild(bFirstSect, "pgNumType", SECT_ORDER);
        setWAttr(pg, "start", "1");
      }
    }
    if (bHasHeader) a.hadHeader = true;
    if (bHasFooter) a.hadFooter = true;

    // A の最後のセクションを、段落の中の区切りに移す
    const aSect = bodySectPr(a.body)!;
    const lastBlock = aSect.previousElementSibling;
    if (lastBlock && lastBlock.localName === "p" && !byLocal(lastBlock, "sectPr").length) {
      let pPr = firstChild(lastBlock, "pPr");
      if (!pPr) {
        pPr = wEl(a.doc, "pPr");
        lastBlock.insertBefore(pPr, lastBlock.firstChild);
      }
      insertOrdered(pPr, aSect, PPR_ORDER);
    } else {
      const p = wEl(a.doc, "p");
      const pPr = wEl(a.doc, "pPr");
      p.appendChild(pPr);
      pPr.appendChild(aSect);
      a.body.appendChild(p);
    }
    for (const el of Array.from(holder.children)) a.body.appendChild(el);
  }

  // 書き戻す
  a.files[a.docPath] = xmlBytes(a.doc);
  a.files[relsPathOf(a.docPath)] = xmlBytes(a.rels);
  if (a.styles && a.stylesPath) a.files[a.stylesPath] = xmlBytes(a.styles);
  if (a.numbering && a.numberingPath) a.files[a.numberingPath] = xmlBytes(a.numbering);
  if (a.footnotes && a.footnotesPath) a.files[a.footnotesPath] = xmlBytes(a.footnotes);
  if (a.endnotes && a.endnotesPath) a.files[a.endnotesPath] = xmlBytes(a.endnotes);
  if (a.fontTable) {
    const fontPath = partOf(a.files, a.docPath, a.rels, "fontTable");
    if (fontPath) a.files[fontPath] = xmlBytes(a.fontTable);
  }
  a.files["[Content_Types].xml"] = xmlBytes(a.ct.doc);
  verifyXmlParts(a.files, "結合したファイル");
  a.notices.add("文書全体の設定（奇数/偶数ページで別のヘッダー・テーマの色など）は、1つ目のファイルのものになります。");
  return { bytes: zipPackage(a.files), notices: Array.from(a.notices) };
}

function addHfRef(a: Ctx, sect: Element, kind: "header" | "footer") {
  const rid = emptyHeaderFooter(a, kind);
  const ref = wEl(a.doc, kind === "header" ? "headerReference" : "footerReference");
  setWAttr(ref, "type", "default");
  ref.setAttributeNS(REL_NS, "r:id", rid);
  sect.insertBefore(ref, sect.firstChild);
  if (firstChild(sect, "titlePg")) {
    const first = wEl(a.doc, kind === "header" ? "headerReference" : "footerReference");
    setWAttr(first, "type", "first");
    first.setAttributeNS(REL_NS, "r:id", rid);
    sect.insertBefore(first, ref.nextSibling);
  }
}

function fixBookmarks(a: Ctx, root: Element | Document) {
  const idMap = new Map<string, string>();
  for (const bm of byLocal(root, "bookmarkStart")) {
    const name = wAttr(bm, "name") ?? "";
    const old = wAttr(bm, "id") ?? "";
    if (name === "_GoBack") {
      // 「前回の編集位置」のしおりは要らないので外す
      idMap.set(old, "");
      bm.parentNode?.removeChild(bm);
      continue;
    }
    const nid = String(a.nextBookmarkId++);
    idMap.set(old, nid);
    setWAttr(bm, "id", nid);
    let n = name;
    for (let i = 2; a.bookmarkNames.has(n); i++) n = `${name}_${i}`.slice(0, 40);
    if (n !== name) setWAttr(bm, "name", n);
    a.bookmarkNames.add(n);
  }
  for (const be of byLocal(root, "bookmarkEnd")) {
    const old = wAttr(be, "id") ?? "";
    if (!idMap.has(old)) continue;
    const nid = idMap.get(old)!;
    if (nid === "") be.parentNode?.removeChild(be);
    else setWAttr(be, "id", nid);
  }
}

/** 文書の中の図形の番号（wp:docPr の id）の最大値。ヘッダー・フッターも含める */
function maxNumAttrAny(a: Ctx): number {
  let m = 0;
  const scan = (d: Document) => {
    for (const el of byLocal(d, "docPr")) {
      const v = Number(el.getAttribute("id"));
      if (Number.isFinite(v) && v > m) m = v;
    }
  };
  scan(a.doc);
  for (const r of listRels(a.rels)) {
    if (r.external || !(relTypeIs(r.type, "header") || relTypeIs(r.type, "footer"))) continue;
    const d = readXml(a.files, resolveTarget(a.docPath, r.target), "ヘッダー");
    if (d) scan(d);
  }
  return m;
}
