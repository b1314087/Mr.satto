import { getBodyElement, getTopLevelParagraphs } from "@/lib/word/docx-text-ops";

/**
 * Word文書（.docx）の段組みの変更（工程3）。word/document.xml のセクション設定（w:sectPr）の段組み（w:cols）だけを書き換える。
 *
 * - 文書全体：すべてのセクション（段落の中の w:sectPr と、本文の最後の w:sectPr）の段組みを変える。
 * - 選択した範囲：Wordで「選択した文字列」に段組みを設定したときと同じく、範囲の前後に「セクション区切り（現在の位置から）」
 *   を入れて、範囲だけを1つのセクションにし、そのセクションの段組みを変える。
 *   範囲の前のセクションは、元のセクションの設定（段組みを含む）をそのまま引き継ぐ。範囲の後ろは、元のセクションの続きになる。
 *   OOXMLでは、段落の中の w:sectPr は「その段落で終わるセクション」の設定で、w:type は「そのセクションの始まり方」を表す。
 * - 段区切り：指定した段落の先頭に、Wordの「段区切り」（w:br w:type="column"）を入れる（その段落から次の段に送る）。
 * - 段の幅はすべて同じにする（Wordの「段の幅をすべて同じにする」）。段の間隔（w:space）は mm で指定する。
 * 段組み以外の設定（用紙・余白・ヘッダー・フッターの参照など）・本文・表・画像は変更しない。
 * Wordでの見た目は、Wordが段組みを計算して決める（このツールはOOXMLの設定を書くだけで、表示はWordなどのアプリに依存する）。
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export type ColumnCount = 1 | 2 | 3;

export interface ColumnSettings {
  count: ColumnCount;
  /** 段と段の間隔（mm） */
  spaceMm: number;
  scope: "all" | "range";
  /** 選択した範囲（本文直下の段落の番号。1始まり・両端を含む）。scope が "range" のときだけ使う */
  rangeStart?: number;
  rangeEnd?: number;
  /** 段区切りを入れる段落の番号（1始まり。その段落の先頭で次の段に送る） */
  columnBreaks?: number[];
}

export const COLUMN_SPACE_MIN_MM = 0;
export const COLUMN_SPACE_MAX_MM = 50;
/** Wordの既定の段の間隔（0.5インチ＝720twip≒12.7mm） */
export const DEFAULT_COLUMN_SPACE_MM = 12.7;

export function mmToTwips(mm: number): number {
  return Math.round((mm / 25.4) * 1440);
}

/** w:sectPr の中の要素の並び順（OOXMLのスキーマ。w:cols・w:type を正しい位置に入れるために使う） */
const SECT_PR_ORDER = [
  "headerReference",
  "footerReference",
  "footnotePr",
  "endnotePr",
  "type",
  "pgSz",
  "pgMar",
  "paperSrc",
  "pgBorders",
  "lnNumType",
  "pgNumType",
  "cols",
  "formProt",
  "vAlign",
  "noEndnote",
  "titlePg",
  "textDirection",
  "bidi",
  "rtlGutter",
  "docGrid",
  "printerSettings",
  "sectPrChange",
];

function child(el: Element, local: string): Element | null {
  return Array.from(el.children).find((c) => c.localName === local) ?? null;
}

/** sectPr の中の、スキーマで決まった位置に要素を入れる（すでにあればそれを返す） */
function ensureSectChild(doc: Document, sectPr: Element, local: string): Element {
  const existing = child(sectPr, local);
  if (existing) return existing;
  const el = doc.createElementNS(W_NS, `w:${local}`);
  const order = SECT_PR_ORDER.indexOf(local);
  const before = Array.from(sectPr.children).find((c) => SECT_PR_ORDER.indexOf(c.localName) > order);
  sectPr.insertBefore(el, before ?? null);
  return el;
}

function setW(el: Element, name: string, value: string) {
  el.setAttributeNS(W_NS, `w:${name}`, value);
}

/** セクションの段組みを設定する（段の幅はすべて同じ。境界線（w:sep）の有無は元のまま） */
function setColumns(doc: Document, sectPr: Element, count: ColumnCount, spaceTwips: number) {
  const cols = ensureSectChild(doc, sectPr, "cols");
  for (const c of Array.from(cols.children)) cols.removeChild(c); // 段ごとの幅の指定（w:col）は外す
  cols.removeAttributeNS(W_NS, "equalWidth");
  cols.removeAttribute("w:equalWidth");
  setW(cols, "num", String(count));
  setW(cols, "space", String(spaceTwips));
}

function getType(sectPr: Element): string | null {
  const t = child(sectPr, "type");
  return t ? (t.getAttributeNS(W_NS, "val") ?? t.getAttribute("w:val")) : null;
}

function setType(doc: Document, sectPr: Element, val: string | null) {
  if (val === null) {
    const t = child(sectPr, "type");
    if (t) sectPr.removeChild(t);
    return;
  }
  setW(ensureSectChild(doc, sectPr, "type"), "val", val);
}

function paragraphSectPr(p: Element): Element | null {
  const pPr = child(p, "pPr");
  return pPr ? child(pPr, "sectPr") : null;
}

/** 段落の段落設定（w:pPr）の最後に sectPr を入れる（w:pPr が無ければ作る） */
function attachSectPr(doc: Document, p: Element, sectPr: Element) {
  let pPr = child(p, "pPr");
  if (!pPr) {
    pPr = doc.createElementNS(W_NS, "w:pPr");
    p.insertBefore(pPr, p.firstChild);
  }
  // w:pPr の中では、w:rPr・w:sectPr・w:pPrChange の順（sectPr は rPr の後ろ、pPrChange の前）
  const change = child(pPr, "pPrChange");
  pPr.insertBefore(sectPr, change);
}

/** 段落の先頭（段落設定の後ろ）に、段区切りの run を入れる */
function insertColumnBreak(doc: Document, p: Element) {
  const r = doc.createElementNS(W_NS, "w:r");
  const br = doc.createElementNS(W_NS, "w:br");
  setW(br, "type", "column");
  r.appendChild(br);
  const pPr = child(p, "pPr");
  p.insertBefore(r, pPr ? pPr.nextSibling : p.firstChild);
}

export interface ColumnsApplyResult {
  /** 段組みを変えたセクションの数 */
  sectionsChanged: number;
  /** 入れた段区切りの数 */
  columnBreaksInserted: number;
}

/**
 * 解析済みの document.xml（DOM）に段組みを設定する（doc を直接書き換える）。
 * paragraphs は、範囲・段区切りの番号が指す段落（本文直下の段落。1番目が paragraphs[0]）。
 * 段落の整理（空白行の削除など）と組み合わせるときは、整理の前に取り出した段落の並びを渡す
 * （整理で消えた段落は、範囲の端なら近くの残っている段落にずらし、段区切りなら入れない）。
 */
export function applyColumns(doc: Document, settings: ColumnSettings, paragraphs?: Element[]): ColumnsApplyResult {
  if (![1, 2, 3].includes(settings.count)) throw new Error("段組みの数は1・2・3から選んでください");
  if (!Number.isFinite(settings.spaceMm) || settings.spaceMm < COLUMN_SPACE_MIN_MM || settings.spaceMm > COLUMN_SPACE_MAX_MM) {
    throw new Error(`段の間隔は${COLUMN_SPACE_MIN_MM}〜${COLUMN_SPACE_MAX_MM}mmの範囲で指定してください`);
  }
  const body = getBodyElement(doc);
  const all = paragraphs ?? getTopLevelParagraphs(body);
  const alive = (p: Element) => p.parentNode === body;
  const spaceTwips = mmToTwips(settings.spaceMm);

  // 本文の最後のセクション設定（無いときは作る。本文の最後の子要素でなければならない）
  let bodySectPr = Array.from(body.children).find((c) => c.localName === "sectPr") ?? null;
  if (!bodySectPr) {
    bodySectPr = doc.createElementNS(W_NS, "w:sectPr");
    body.appendChild(bodySectPr);
  }

  const breaks = [...new Set(settings.columnBreaks ?? [])].sort((a, b) => a - b);
  for (const n of breaks) {
    if (!Number.isInteger(n) || n < 1 || n > all.length) throw new Error(`段区切りを入れる段落の番号（${n}）が正しくありません（1〜${all.length}）`);
  }

  let sectionsChanged = 0;
  if (settings.scope === "all") {
    const sectPrs = [...getTopLevelParagraphs(body).map(paragraphSectPr).filter((s): s is Element => s !== null), bodySectPr];
    for (const s of sectPrs) setColumns(doc, s, settings.count, spaceTwips);
    sectionsChanged = sectPrs.length;
  } else {
    const start = settings.rangeStart;
    const end = settings.rangeEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 1 || end! > all.length || start! > end!) {
      throw new Error(`段組みにする範囲が正しくありません（1〜${all.length}段落の間で、開始が終了以下になるように指定してください）`);
    }
    for (const n of breaks) {
      if (n < start! || n > end!) throw new Error(`段区切りは、段組みにする範囲（${start}〜${end}段落）の中の段落に入れてください`);
    }
    // 整理で消えた段落は、範囲の内側の、近くの残っている段落にずらす
    let s = start! - 1;
    let e = end! - 1;
    while (s <= e && !alive(all[s])) s++;
    while (e >= s && !alive(all[e])) e--;
    if (s > e) throw new Error("段組みにする範囲の段落が、整理（空白行の削除など）ですべて削除されます。範囲を選び直してください。");
    const current = getTopLevelParagraphs(body);
    const si = current.indexOf(all[s]);
    const ei = current.indexOf(all[e]);
    // 範囲の途中（最後の段落を除く）に、すでにセクション区切りがあると、範囲を1つのセクションにできない
    for (let i = si; i < ei; i++) {
      if (paragraphSectPr(current[i])) {
        throw new Error("段組みにする範囲の途中に、すでにセクション区切りがあります。区切りの前後で、範囲を分けて指定してください。");
      }
    }
    // 範囲を受け持っている元のセクション＝範囲の最後の段落以降で、最初に現れるセクション設定
    let governing: Element = bodySectPr;
    for (let i = ei; i < current.length; i++) {
      const sp = paragraphSectPr(current[i]);
      if (sp) {
        governing = sp;
        break;
      }
    }
    const origType = getType(governing);
    // 範囲の前：元のセクションの途中から始まるときは、直前の段落でセクションを終える（元の設定をそのまま引き継ぐ）
    const prev = si > 0 ? current[si - 1] : null;
    let splitBefore = false;
    if (prev && !paragraphSectPr(prev)) {
      attachSectPr(doc, prev, governing.cloneNode(true) as Element);
      splitBefore = true;
    }
    // 範囲：最後の段落で終わるセクションにする
    const last = current[ei];
    let rangeSect = paragraphSectPr(last);
    if (!rangeSect) {
      rangeSect = governing.cloneNode(true) as Element;
      attachSectPr(doc, last, rangeSect);
      // 範囲の後ろは元のセクションの続き。改ページせず、同じページの続きから始める
      setType(doc, governing, "continuous");
    }
    setColumns(doc, rangeSect, settings.count, spaceTwips);
    // 範囲が元のセクションの途中から始まるときは、改ページせず、同じページの続きから始める
    setType(doc, rangeSect, splitBefore ? "continuous" : origType);
    sectionsChanged = 1;
  }

  let columnBreaksInserted = 0;
  for (const n of breaks) {
    const p = all[n - 1];
    if (!alive(p)) continue;
    insertColumnBreak(doc, p);
    columnBreaksInserted++;
  }
  return { sectionsChanged, columnBreaksInserted };
}
