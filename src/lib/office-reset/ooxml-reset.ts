import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from "fflate";

/**
 * Excel（.xlsx）・Word（.docx）・PowerPoint（.pptx）の「書式」と「ページ・印刷の設定」を、
 * 新しく作ったときと同じ標準の状態に戻す（2026-11-17）。
 *
 * - 中身（文字・数値・数式・表・画像・グラフ・コメントなど）はそのまま残す。
 * - ファイルの中の XML を、ブラウザの DOMParser で読み、必要な部分だけを書き換える（サーバーへは送らない）。
 * - 書き換えたあと、書き換えた XML をすべて読み直して、壊れていないことを確かめる。
 *
 * 「標準」の値は、日本語版の Office で新しく作ったときの値に合わせる
 * （Excel：游ゴシック 11pt・余白「標準」、Word：A4縦・余白「標準」(上35mm・下左右30mm)・10.5pt、PowerPoint：16:9）。
 */

export type OfficeKind = "xlsx" | "docx" | "pptx";

export interface OfficeResetOptions {
  /** 書式（フォント・文字の大きさ・色・太字・塗りつぶし・罫線・配置など）を標準に戻す */
  format: boolean;
  /** ページ・印刷の設定（用紙・余白・向き・印刷範囲・拡大率・列の幅/行の高さ・スライドのサイズなど）を標準に戻す */
  page: boolean;
}

export interface OfficeResetResult {
  bytes: Uint8Array;
  /** 標準に戻したもの（画面に出す説明） */
  done: string[];
  /** 残したもの（そのままにしたもの） */
  kept: string[];
  /** 注意（標準に戻したことで見た目が大きく変わりうるもの） */
  notes: string[];
}

export class OfficeResetError extends Error {}

export const MAX_OFFICE_RESET_MB = 50;

const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
};

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

interface Pkg {
  files: Record<string, Uint8Array>;
  changed: Set<string>;
}

function openPackage(bytes: Uint8Array, kind: OfficeKind): Pkg {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new OfficeResetError(
      kind === "xlsx"
        ? "Excelファイル（.xlsx）として読み取れませんでした。古い形式（.xls）の場合は、先に「Excel旧形式→新形式」で.xlsxに変換してください。"
        : kind === "docx"
          ? "Word文書（.docx）として読み取れませんでした。古い形式（.doc）の場合は、先に「Word旧形式→新形式」で.docxに変換してください。"
          : "PowerPointファイル（.pptx）として読み取れませんでした。古い形式（.ppt）には対応していません。"
    );
  }
  const main = kind === "xlsx" ? "xl/workbook.xml" : kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!files[main]) {
    throw new OfficeResetError(
      kind === "xlsx" ? "Excelファイル（.xlsx）ではないようです。" : kind === "docx" ? "Word文書（.docx）ではないようです。" : "PowerPointファイル（.pptx）ではないようです。"
    );
  }
  if (files["EncryptedPackage"] || files["EncryptionInfo"]) {
    throw new OfficeResetError("パスワードで保護されたファイルは処理できません。パスワードを外してから、もう一度お試しください。");
  }
  return { files, changed: new Set() };
}

function parseXml(pkg: Pkg, name: string): Document | null {
  const data = pkg.files[name];
  if (!data) return null;
  const doc = new DOMParser().parseFromString(strFromU8(data), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

function saveXml(pkg: Pkg, name: string, doc: Document) {
  let xml = new XMLSerializer().serializeToString(doc);
  if (!xml.startsWith("<?xml")) xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
  pkg.files[name] = strToU8(xml);
  pkg.changed.add(name);
}

function finish(pkg: Pkg): Uint8Array {
  // 書き換えた XML が、すべて読み直せることを確かめる
  for (const name of pkg.changed) {
    const doc = new DOMParser().parseFromString(strFromU8(pkg.files[name]), "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new OfficeResetError("書き換えた結果を確かめたところ、正しく作れていませんでした。お手数ですが、別のファイルでお試しください。");
    }
  }
  const out: Zippable = {};
  for (const [name, data] of Object.entries(pkg.files)) {
    // [Content_Types].xml を先頭に（Office の決まり）。画像などは圧縮しない
    out[name] = /\.(png|jpe?g|gif|emf|wmf|mp4|m4a|wav)$/i.test(name) ? [data, { level: 0 }] : [data, { level: 6 }];
  }
  const ordered: Zippable = {};
  if (out["[Content_Types].xml"]) ordered["[Content_Types].xml"] = out["[Content_Types].xml"];
  for (const [k, v] of Object.entries(out)) if (k !== "[Content_Types].xml") ordered[k] = v;
  return zipSync(ordered);
}

function children(el: Element, ns: string, local: string): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === local);
}
function child(el: Element, ns: string, local: string): Element | null {
  return children(el, ns, local)[0] ?? null;
}
function all(doc: Document | Element, ns: string, local: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS(ns, local));
}
function removeAll(els: Element[]): number {
  for (const e of els) e.parentNode?.removeChild(e);
  return els.length;
}
function partsMatching(pkg: Pkg, re: RegExp): string[] {
  return Object.keys(pkg.files)
    .filter((n) => re.test(n))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** 処理の本体：種類ごとに振り分ける */
export function resetOfficeFile(bytes: Uint8Array, kind: OfficeKind, options: OfficeResetOptions): OfficeResetResult {
  if (!options.format && !options.page) throw new OfficeResetError("標準に戻す項目を、1つ以上選んでください。");
  const pkg = openPackage(bytes, kind);
  const r = kind === "xlsx" ? resetXlsx(pkg, options) : kind === "docx" ? resetDocx(pkg, options) : resetPptx(pkg, options);
  return { bytes: finish(pkg), ...r };
}

type Report = Omit<OfficeResetResult, "bytes">;

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

/** 日本語版 Excel の標準のフォント（テーマの本文のフォント＝游ゴシック 11pt） */
const XLSX_DEFAULT_FONT = '<font><sz val="11"/><color theme="1"/><name val="游ゴシック"/><family val="3"/><charset val="128"/><scheme val="minor"/></font>';

function resetXlsx(pkg: Pkg, o: OfficeResetOptions): Report {
  const done: string[] = [];
  const kept: string[] = ["セルの値・数式", "セルの結合", "シートの名前・順番・非表示", "グラフ・画像・図形", "コメント・メモ", "条件付き書式・入力規則"];
  const notes: string[] = [];
  const sheets = partsMatching(pkg, /^xl\/worksheets\/sheet\d+\.xml$/);

  // 書式：styles.xml を標準のものに作り直す（数値の表示形式＝日付・金額・％などは残す）
  let xfMap: number[] | null = null;
  if (o.format) {
    const styles = parseXml(pkg, "xl/styles.xml");
    if (styles) {
      const root = styles.documentElement;
      const numFmtsEl = child(root, NS.main, "numFmts");
      const cellXfs = child(root, NS.main, "cellXfs");
      const oldXfs = cellXfs ? children(cellXfs, NS.main, "xf") : [];
      // 古い書式の番号 → 新しい書式の番号（表示形式ごとに1つ）
      const fmtToNew = new Map<number, number>([[0, 0]]);
      const newFmtIds: number[] = [0];
      xfMap = oldXfs.map((xf) => {
        const id = Number(xf.getAttribute("numFmtId") ?? "0") || 0;
        if (!fmtToNew.has(id)) {
          fmtToNew.set(id, newFmtIds.length);
          newFmtIds.push(id);
        }
        return fmtToNew.get(id)!;
      });
      const dxfs = child(root, NS.main, "dxfs");
      const tableStyles = child(root, NS.main, "tableStyles");
      const ser = new XMLSerializer();
      const xml = [
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
        `<styleSheet xmlns="${NS.main}">`,
        numFmtsEl ? ser.serializeToString(numFmtsEl).replace(/ xmlns="[^"]*"/, "") : "",
        `<fonts count="1">${XLSX_DEFAULT_FONT}</fonts>`,
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`,
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`,
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="center"/></xf></cellStyleXfs>`,
        `<cellXfs count="${newFmtIds.length}">${newFmtIds
          .map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id ? ' applyNumberFormat="1"' : ""}><alignment vertical="center"/></xf>`)
          .join("")}</cellXfs>`,
        `<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>`,
        // 条件付き書式・テーブルの書式は残す（中身のルールに結びついているため）
        dxfs ? ser.serializeToString(dxfs).replace(/ xmlns="[^"]*"/, "") : `<dxfs count="0"/>`,
        tableStyles ? ser.serializeToString(tableStyles).replace(/ xmlns="[^"]*"/, "") : `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>`,
        `</styleSheet>`,
      ].join("");
      pkg.files["xl/styles.xml"] = strToU8(xml);
      pkg.changed.add("xl/styles.xml");
      done.push(`セルの書式（フォント・文字の大きさ・色・太字・塗りつぶし・罫線・配置）を標準（游ゴシック 11pt・罫線なし）に戻しました（書式${oldXfs.length}種類 → ${newFmtIds.length}種類）`);
      if (newFmtIds.length > 1) kept.push("数値の表示形式（日付・金額・％など）");
    }
    // 共有の文字列の中の、文字ごとの書式（一部だけ赤字・太字など）を外す
    const sst = parseXml(pkg, "xl/sharedStrings.xml");
    if (sst) {
      let rich = 0;
      for (const si of all(sst, NS.main, "si")) {
        const runs = children(si, NS.main, "r");
        if (runs.length === 0) continue;
        rich++;
        const text = runs.map((r) => child(r, NS.main, "t")?.textContent ?? "").join("");
        while (si.firstChild) si.removeChild(si.firstChild);
        const t = sst.createElementNS(NS.main, "t");
        t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
        t.textContent = text;
        si.appendChild(t);
      }
      // ふりがなの表示（rPh）は残す。文字の書式だけ外す
      if (rich) {
        saveXml(pkg, "xl/sharedStrings.xml", sst);
        done.push(`セルの中の一部だけの書式（一部だけ赤字・太字など）を外しました（${rich}か所）`);
      }
    }
  }

  let cellCount = 0;
  let colsRemoved = 0;
  let rowsReset = 0;
  let pageSheets = 0;
  for (const name of sheets) {
    const doc = parseXml(pkg, name);
    if (!doc) continue;
    const root = doc.documentElement;
    if (o.format && xfMap) {
      for (const c of all(doc, NS.main, "c")) {
        const s = c.getAttribute("s");
        if (s === null) continue;
        const next = xfMap[Number(s)] ?? 0;
        if (next) c.setAttribute("s", String(next));
        else c.removeAttribute("s");
        cellCount++;
        // 文字列をその場に書いたセル（inlineStr）の、文字ごとの書式も外す
        const is = child(c, NS.main, "is");
        if (is && children(is, NS.main, "r").length) {
          const text = children(is, NS.main, "r")
            .map((r) => child(r, NS.main, "t")?.textContent ?? "")
            .join("");
          while (is.firstChild) is.removeChild(is.firstChild);
          const t = doc.createElementNS(NS.main, "t");
          t.textContent = text;
          is.appendChild(t);
        }
      }
      for (const row of all(doc, NS.main, "row")) {
        row.removeAttribute("s");
        row.removeAttribute("customFormat");
      }
      for (const col of all(doc, NS.main, "col")) {
        const s = col.getAttribute("style");
        if (s !== null) {
          const next = xfMap[Number(s)] ?? 0;
          if (next) col.setAttribute("style", String(next));
          else col.removeAttribute("style");
        }
      }
      // シート見出しの色
      const sheetPr = child(root, NS.main, "sheetPr");
      if (sheetPr) removeAll(children(sheetPr, NS.main, "tabColor"));
    }
    if (o.page) {
      pageSheets++;
      // 列の幅・行の高さを標準に（非表示の列・行は、非表示のまま残す）
      const cols = child(root, NS.main, "cols");
      if (cols) {
        for (const col of children(cols, NS.main, "col")) {
          colsRemoved++;
          const hidden = col.getAttribute("hidden") === "1" || col.getAttribute("hidden") === "true";
          // 非表示の列と、列全体の書式（書式は戻さないとき）は残し、幅の指定だけ外す
          if (hidden || col.hasAttribute("style")) {
            for (const a of ["width", "customWidth", "bestFit"]) col.removeAttribute(a);
            continue;
          }
          cols.removeChild(col);
        }
        if (children(cols, NS.main, "col").length === 0) root.removeChild(cols);
      }
      for (const row of all(doc, NS.main, "row")) {
        if (row.hasAttribute("ht") || row.hasAttribute("customHeight")) rowsReset++;
        row.removeAttribute("ht");
        row.removeAttribute("customHeight");
      }
      const fmt = child(root, NS.main, "sheetFormatPr");
      if (fmt) {
        fmt.removeAttribute("defaultColWidth");
        fmt.removeAttribute("baseColWidth");
        fmt.removeAttribute("customHeight");
        fmt.setAttribute("defaultRowHeight", "18.75");
      }
      // 表示：拡大率・改ページプレビュー・ページレイアウト表示・枠線を隠す設定を標準に
      for (const v of all(doc, NS.main, "sheetView")) {
        for (const a of ["zoomScale", "zoomScaleNormal", "zoomScalePageLayoutView", "zoomScaleSheetLayoutView", "view", "showGridLines"]) v.removeAttribute(a);
      }
      // 余白は「標準」（上下0.75・左右0.7・ヘッダー/フッター0.3インチ）
      const margins = child(root, NS.main, "pageMargins");
      if (margins) {
        margins.setAttribute("left", "0.7");
        margins.setAttribute("right", "0.7");
        margins.setAttribute("top", "0.75");
        margins.setAttribute("bottom", "0.75");
        margins.setAttribute("header", "0.3");
        margins.setAttribute("footer", "0.3");
      }
      // 用紙の大きさ・向き・拡大縮小・ページに合わせる・印刷の向き、ヘッダー/フッター、改ページ、枠線・見出しの印刷
      for (const tag of ["pageSetup", "printOptions", "headerFooter", "rowBreaks", "colBreaks"]) removeAll(children(root, NS.main, tag));
      const sheetPr = child(root, NS.main, "sheetPr");
      if (sheetPr) removeAll(children(sheetPr, NS.main, "pageSetUpPr"));
    }
    saveXml(pkg, name, doc);
  }
  if (o.format && cellCount) done.push(`書式を設定していたセル：${cellCount.toLocaleString()}個`);

  if (o.page) {
    // 印刷範囲・印刷タイトル
    const wb = parseXml(pkg, "xl/workbook.xml");
    let printNames = 0;
    if (wb) {
      const names = all(wb, NS.main, "definedName").filter((d) => /^_xlnm\.(Print_Area|Print_Titles)$/.test(d.getAttribute("name") ?? ""));
      printNames = removeAll(names);
      const dn = all(wb, NS.main, "definedNames")[0];
      if (dn && children(dn, NS.main, "definedName").length === 0) dn.parentNode?.removeChild(dn);
      if (printNames) saveXml(pkg, "xl/workbook.xml", wb);
    }
    done.push(
      `ページ・印刷の設定を標準に戻しました（${pageSheets}シート）：用紙の大きさ・向き・拡大縮小・余白（標準）・ヘッダー/フッター・改ページ・表示の拡大率${
        printNames ? `・印刷範囲／印刷タイトル（${printNames}か所）` : ""
      }`
    );
    done.push(`列の幅・行の高さを標準に戻しました（列の設定${colsRemoved}か所・行${rowsReset.toLocaleString()}行）`);
    kept.push("非表示の列・行（非表示のまま）");
    notes.push("列の幅が標準に戻るため、長い文字や大きな数値が「###」と表示されたり、隣のセルにはみ出して見えたりすることがあります。");
  }
  return { done, kept, notes };
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/** 新しい書式の中で残すスタイル（スタイルの名前 → 新しい ID） */
const DOCX_KEEP_STYLES: Record<string, string> = {
  "heading 1": "Heading1",
  "heading 2": "Heading2",
  "heading 3": "Heading3",
  "heading 4": "Heading4",
  "heading 5": "Heading5",
  "heading 6": "Heading6",
  title: "Title",
  subtitle: "Subtitle",
  "list paragraph": "ListParagraph",
  header: "Header",
  footer: "Footer",
  hyperlink: "Hyperlink",
  "table grid": "TableGrid",
  "footnote text": "FootnoteText",
  "footnote reference": "FootnoteReference",
};

/** 日本語版 Word の新しい文書と同じ、標準のスタイル（MS 明朝/游明朝はテーマの本文のフォント、10.5pt、両端揃え） */
function docxDefaultStyles(): string {
  const W = NS.w;
  const heading = (n: number, sz: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<w:styles xmlns:w="${W}">`,
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:kern w:val="2"/><w:sz w:val="21"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>`,
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:style>`,
    [1, 2, 3, 4, 5, 6].map((n) => heading(n, n === 1 ? 32 : n === 2 ? 28 : 24)).join(""),
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="11"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:leftChars="400" w:left="840"/></w:pPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4252"/><w:tab w:val="right" w:pos="8504"/></w:tabs><w:snapToGrid w:val="0"/></w:pPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4252"/><w:tab w:val="right" w:pos="8504"/></w:tabs><w:snapToGrid w:val="0"/></w:pPr></w:style>`,
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:snapToGrid w:val="0"/><w:jc w:val="left"/></w:pPr></w:style>`,
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`,
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>`,
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>`,
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`,
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>`,
    `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`,
    `</w:styles>`,
  ].join("");
}

/** 段落の設定のうち、書式を標準に戻しても残すもの（見出し・箇条書き・セクション区切り・改ページなど、文書の作りにかかわるもの） */
const DOCX_KEEP_PPR = new Set(["pStyle", "numPr", "sectPr", "outlineLvl", "pageBreakBefore", "keepNext", "keepLines", "bidi", "textDirection"]);
/** 文字の設定のうち、残すもの（隠し文字を見せてしまわないよう、隠し文字の設定は残す） */
const DOCX_KEEP_RPR = new Set(["rStyle", "vanish", "webHidden", "specVanish", "rtl", "lang"]);

function resetDocx(pkg: Pkg, o: OfficeResetOptions): Report {
  const done: string[] = [];
  const kept: string[] = ["文章（文字）", "見出し・タイトルの区別", "箇条書き・段落番号", "表（行・列・セルの結合・列の幅）", "画像・図形", "ヘッダー・フッターの中身", "脚注・コメント", "改ページ・セクション区切り"];
  const notes: string[] = [];
  const W = NS.w;
  const parts = ["word/document.xml", ...partsMatching(pkg, /^word\/(header|footer)\d+\.xml$/), "word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"].filter((n) => pkg.files[n]);

  if (o.format) {
    // 古いスタイルの ID → 名前（日本語版 Word は「見出し 1」の ID が "1" などになっているため、名前で引き直す）
    const oldStyles = parseXml(pkg, "word/styles.xml");
    const idToNew = new Map<string, string>();
    // 箇条書き・段落番号をスタイルの中で決めている（「箇条書き」スタイルなど）とき、その番号の設定（numId・レベル）
    const styleNum = new Map<string, { numId: string; ilvl: string }>();
    if (oldStyles) {
      const byId = new Map<string, Element>();
      for (const st of all(oldStyles, W, "style")) {
        const id = wAttr(st, "styleId");
        if (id) byId.set(id, st);
        const nm = child(st, W, "name");
        const name = (nm ? wAttr(nm, "val") : "").toLowerCase();
        if (id && DOCX_KEEP_STYLES[name]) idToNew.set(id, DOCX_KEEP_STYLES[name]);
      }
      for (const [id] of byId) {
        // 元のスタイルをたどって（basedOn）、番号の設定を探す
        let cur: Element | undefined = byId.get(id);
        for (let depth = 0; cur && depth < 10; depth++) {
          const numPr = child(child(cur, W, "pPr") ?? cur, W, "numPr");
          const numId = numPr ? wAttr(child(numPr, W, "numId"), "val") : "";
          if (numId) {
            if (numId !== "0") styleNum.set(id, { numId, ilvl: wAttr(child(numPr!, W, "ilvl"), "val") || "0" });
            break;
          }
          const based = child(cur, W, "basedOn");
          cur = based ? byId.get(wAttr(based, "val")) : undefined;
        }
      }
    }
    pkg.files["word/styles.xml"] = strToU8(docxDefaultStyles());
    pkg.changed.add("word/styles.xml");
    // stylesWithEffects（古い Word が書く、スタイルの写し）は、古い書式が残らないように取り除く
    if (pkg.files["word/stylesWithEffects.xml"]) {
      delete pkg.files["word/stylesWithEffects.xml"];
      dropPartReference(pkg, "word/stylesWithEffects.xml", "/word/stylesWithEffects.xml");
    }

    let runs = 0;
    let paras = 0;
    let tables = 0;
    for (const name of parts) {
      const doc = parseXml(pkg, name);
      if (!doc) continue;
      for (const rPr of all(doc, W, "rPr")) {
        // スタイルの定義の中の rPr は styles.xml にしか無い。ここは本文などの、文字・段落記号の直接の書式
        for (const c of Array.from(rPr.children)) if (c.namespaceURI !== W || !DOCX_KEEP_RPR.has(c.localName)) rPr.removeChild(c);
        const rs = child(rPr, W, "rStyle");
        if (rs) {
          const v = wAttr(rs, "val");
          const next = idToNew.get(v);
          if (next) rs.setAttributeNS(W, "w:val", next);
          else rPr.removeChild(rs);
        }
        if (rPr.children.length === 0) rPr.parentNode?.removeChild(rPr);
        runs++;
      }
      for (const pPr of all(doc, W, "pPr")) {
        for (const c of Array.from(pPr.children)) if (c.namespaceURI !== W || !DOCX_KEEP_PPR.has(c.localName)) pPr.removeChild(c);
        const ps = child(pPr, W, "pStyle");
        if (ps) {
          const v = wAttr(ps, "val");
          const next = idToNew.get(v);
          const num = styleNum.get(v);
          if (next) ps.setAttributeNS(W, "w:val", next);
          else if (num) {
            // 箇条書きのスタイル：標準の「箇条書き（リスト段落）」にして、番号の設定を段落に移す（箇条書きの記号が消えないように）
            ps.setAttributeNS(W, "w:val", "ListParagraph");
            if (!child(pPr, W, "numPr")) {
              const numPr = doc.createElementNS(W, "w:numPr");
              const ilvl = doc.createElementNS(W, "w:ilvl");
              ilvl.setAttributeNS(W, "w:val", num.ilvl);
              const numId = doc.createElementNS(W, "w:numId");
              numId.setAttributeNS(W, "w:val", num.numId);
              numPr.appendChild(ilvl);
              numPr.appendChild(numId);
              // 段落の設定の順番（pStyle・keepNext・keepLines・pageBreakBefore の後ろ）を守って入れる
              let after: Element = ps;
              for (const c of Array.from(pPr.children)) if (["keepNext", "keepLines", "pageBreakBefore"].includes(c.localName)) after = c;
              pPr.insertBefore(numPr, after.nextSibling);
            }
          } else pPr.removeChild(ps);
        }
        if (pPr.children.length === 0) pPr.parentNode?.removeChild(pPr);
        paras++;
      }
      // 表：書式（罫線・塗りつぶし・セルの余白・文字の配置）を外し、Word の標準の「表（格子）」にする。列の幅・結合は残す
      for (const tbl of all(doc, W, "tbl")) {
        tables++;
        let tblPr = child(tbl, W, "tblPr");
        if (!tblPr) {
          tblPr = doc.createElementNS(W, "w:tblPr");
          tbl.insertBefore(tblPr, tbl.firstChild);
        }
        for (const c of Array.from(tblPr.children)) if (!["tblW", "tblLayout", "tblLook", "tblInd", "tblpPr", "tblOverlap", "bidiVisual", "tblCaption", "tblDescription"].includes(c.localName)) tblPr.removeChild(c);
        const style = doc.createElementNS(W, "w:tblStyle");
        style.setAttributeNS(W, "w:val", "TableGrid");
        tblPr.insertBefore(style, tblPr.firstChild);
        for (const tcPr of children(tbl, W, "tr").flatMap((tr) => children(tr, W, "tc")).map((tc) => child(tc, W, "tcPr")).filter((x): x is Element => !!x)) {
          for (const c of Array.from(tcPr.children)) if (["shd", "tcBorders", "tcMar", "vAlign", "noWrap", "tcFitText"].includes(c.localName)) tcPr.removeChild(c);
        }
        for (const tr of children(tbl, W, "tr")) {
          const tblPrEx = child(tr, W, "tblPrEx");
          if (tblPrEx) tr.removeChild(tblPrEx);
        }
      }
      // 段落・文字の網かけ（文字の背景）
      saveXml(pkg, name, doc);
    }
    done.push(`文字の書式（フォント・文字の大きさ・色・太字・斜体・下線・蛍光ペンなど）を標準（10.5pt）に戻しました（${runs.toLocaleString()}か所）`);
    done.push(`段落の書式（配置・字下げ・行の間隔・段落の前後の間隔・枠線・網かけ）を標準に戻しました（${paras.toLocaleString()}段落）`);
    done.push("スタイル（標準・見出し・表など）の設定を、新しい文書と同じ標準のものに戻しました");
    if (tables) done.push(`表の罫線・塗りつぶし・セルの余白を、標準の「表（格子）」に戻しました（${tables}個）`);
    notes.push("フォントは、文書のテーマの本文のフォントになります（テーマの設定は変えていません）。");
  }

  if (o.page) {
    let sections = 0;
    for (const name of parts) {
      const doc = parseXml(pkg, name);
      if (!doc) continue;
      const sects = all(doc, W, "sectPr");
      if (sects.length === 0) continue;
      for (const s of sects) {
        sections++;
        // A4縦・余白「標準」（上35mm・下左右30mm、ヘッダー15mm・フッター17.5mm）
        let pgSz = child(s, W, "pgSz");
        let pgMar = child(s, W, "pgMar");
        if (!pgSz) {
          pgSz = doc.createElementNS(W, "w:pgSz");
          insertSectChild(s, pgSz);
        }
        for (const a of Array.from(pgSz.attributes)) pgSz.removeAttribute(a.name);
        pgSz.setAttributeNS(W, "w:w", "11906");
        pgSz.setAttributeNS(W, "w:h", "16838");
        if (!pgMar) {
          pgMar = doc.createElementNS(W, "w:pgMar");
          insertSectChild(s, pgMar);
        }
        for (const a of Array.from(pgMar.attributes)) pgMar.removeAttribute(a.name);
        for (const [k, v] of Object.entries({ top: "1985", right: "1701", bottom: "1701", left: "1701", header: "851", footer: "992", gutter: "0" })) pgMar.setAttributeNS(W, `w:${k}`, v);
        // 段組み・ページの罫線・行番号・ページの中の上下の配置を標準に。行数・文字数の指定（文字グリッド）も標準に
        for (const tag of ["cols", "pgBorders", "lnNumType", "vAlign", "rtlGutter", "printerSettings"]) removeAll(children(s, W, tag));
        const grid = child(s, W, "docGrid");
        if (grid) {
          for (const a of Array.from(grid.attributes)) grid.removeAttribute(a.name);
          grid.setAttributeNS(W, "w:type", "lines");
          grid.setAttributeNS(W, "w:linePitch", "360");
        }
      }
      saveXml(pkg, name, doc);
    }
    done.push(`ページの設定を標準に戻しました（${sections}セクション）：用紙A4・縦向き・余白「標準」（上35mm・下左右30mm）・1段組み・ページの罫線なし・行数（文字グリッド）`);
    kept.push("縦書き・横書きの向き");
    notes.push("用紙・余白が変わるため、ページの区切りの位置が変わることがあります。");
  }
  return { done, kept, notes };
}

/** w: の属性の値（無ければ空文字） */
function wAttr(el: Element | null, name: string): string {
  if (!el) return "";
  return el.getAttributeNS(NS.w, name) ?? el.getAttribute(`w:${name}`) ?? "";
}

/** sectPr の子は決まった順番がある（pgSz → pgMar が、ヘッダー/フッターの参照・脚注の設定・種類の後） */
function insertSectChild(sect: Element, el: Element) {
  const after = new Set(["headerReference", "footerReference", "footnotePr", "endnotePr", "type"]);
  const order = el.localName === "pgMar" ? new Set([...after, "pgSz"]) : after;
  let ref: Node | null = sect.firstChild;
  while (ref && ref.nodeType === 1 && order.has((ref as Element).localName)) ref = ref.nextSibling;
  while (ref && ref.nodeType !== 1) ref = ref.nextSibling;
  sect.insertBefore(el, ref);
}

/** パーツを取り除いたときに、[Content_Types].xml と関係（.rels）からも参照を外す */
function dropPartReference(pkg: Pkg, partName: string, contentPath: string) {
  const ct = parseXml(pkg, "[Content_Types].xml");
  if (ct) {
    for (const ov of Array.from(ct.getElementsByTagName("Override"))) if (ov.getAttribute("PartName") === contentPath) ov.parentNode?.removeChild(ov);
    saveXml(pkg, "[Content_Types].xml", ct);
  }
  const relsName = "word/_rels/document.xml.rels";
  const rels = parseXml(pkg, relsName);
  if (rels) {
    const base = partName.replace(/^word\//, "");
    for (const r of Array.from(rels.getElementsByTagName("Relationship"))) if (r.getAttribute("Target") === base) r.parentNode?.removeChild(r);
    saveXml(pkg, relsName, rels);
  }
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

/** 文字の設定（a:rPr）の属性のうち、残すもの（言語・校正の印） */
const PPTX_KEEP_RPR_ATTRS = new Set(["lang", "altLang", "dirty", "err", "noProof", "smtClean", "smtId", "bmk"]);
/** 文字の設定の子要素のうち、残すもの（リンク） */
const PPTX_KEEP_RPR_CHILDREN = new Set(["hlinkClick", "hlinkMouseOver", "rtl"]);
/** 16:9（PowerPoint の標準） */
const PPTX_W = 12192000;
const PPTX_H = 6858000;

function resetPptx(pkg: Pkg, o: OfficeResetOptions): Report {
  const done: string[] = [];
  const kept: string[] = ["スライドの文字", "スライドの順番・非表示", "画像・動画", "グラフ・SmartArt", "ノート（発表者用のメモ）", "スライドのレイアウト・マスター・テーマ", "アニメーション・画面切り替え"];
  const notes: string[] = [];
  const A = NS.a;
  const P = NS.p;
  const slides = partsMatching(pkg, /^ppt\/slides\/slide\d+\.xml$/);

  if (o.format) {
    let runs = 0;
    let paras = 0;
    let shapes = 0;
    let bgs = 0;
    let cells = 0;
    for (const name of slides) {
      const doc = parseXml(pkg, name);
      if (!doc) continue;
      for (const tag of ["rPr", "endParaRPr", "defRPr"]) {
        for (const rPr of all(doc, A, tag)) {
          for (const at of Array.from(rPr.attributes)) if (!PPTX_KEEP_RPR_ATTRS.has(at.localName) && !at.name.startsWith("xmlns")) rPr.removeAttribute(at.name);
          for (const c of Array.from(rPr.children)) if (!PPTX_KEEP_RPR_CHILDREN.has(c.localName)) rPr.removeChild(c);
          runs++;
        }
      }
      for (const pPr of all(doc, A, "pPr")) {
        const lvl = pPr.getAttribute("lvl");
        for (const at of Array.from(pPr.attributes)) if (!at.name.startsWith("xmlns")) pPr.removeAttribute(at.name);
        if (lvl) pPr.setAttribute("lvl", lvl);
        while (pPr.firstChild) pPr.removeChild(pPr.firstChild);
        paras++;
      }
      // 段落の書式の一覧（a:lstStyle）・テキストボックスの余白・自動調整を標準に
      for (const ls of all(doc, A, "lstStyle")) while (ls.firstChild) ls.removeChild(ls.firstChild);
      // 図形の塗りつぶし・線・効果：プレースホルダー（タイトル・本文の枠）と、テーマの書式を持つ図形だけ標準に戻す
      for (const sp of all(doc, P, "sp")) {
        const isPh = !!sp.getElementsByTagNameNS(P, "ph")[0];
        const hasStyle = !!child(sp, P, "style");
        if (!isPh && !hasStyle) continue;
        const spPr = child(sp, P, "spPr");
        if (!spPr) continue;
        let n = 0;
        for (const c of Array.from(spPr.children)) {
          if (["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill", "ln", "effectLst", "effectDag", "scene3d", "sp3d"].includes(c.localName)) {
            spPr.removeChild(c);
            n++;
          }
        }
        if (n) shapes++;
      }
      // 表のセルの塗りつぶし・罫線（表のスタイルの書式に戻る）
      for (const tcPr of all(doc, A, "tcPr")) {
        for (const c of Array.from(tcPr.children)) if (/^(ln[LRTB]|lnTlToBr|lnBlToTr|noFill|solidFill|gradFill|blipFill|pattFill|grpFill)$/.test(c.localName)) tcPr.removeChild(c);
        for (const at of ["marL", "marR", "marT", "marB", "anchor"]) tcPr.removeAttribute(at);
        cells++;
      }
      // スライドごとの背景（マスターの背景に戻る）
      const cSld = all(doc, P, "cSld")[0];
      if (cSld) bgs += removeAll(children(cSld, P, "bg"));
      saveXml(pkg, name, doc);
    }
    done.push(`文字の書式（フォント・文字の大きさ・色・太字・斜体・下線など）を、レイアウト・マスターの標準に戻しました（${runs.toLocaleString()}か所）`);
    done.push(`段落の書式（配置・行の間隔・箇条書きの記号・字下げ）を標準に戻しました（${paras.toLocaleString()}段落。箇条書きのレベルは残す）`);
    if (shapes) done.push(`タイトル・本文の枠や図形の塗りつぶし・線・効果を、テーマの標準に戻しました（${shapes}個）`);
    if (cells) done.push(`表のセルの塗りつぶし・罫線を、表のスタイルの標準に戻しました（${cells.toLocaleString()}セル）`);
    if (bgs) done.push(`スライドごとに変えていた背景を、マスターの背景に戻しました（${bgs}枚）`);
    notes.push("自分で描いた図形のうち、テーマの書式を持たないもの（色を直接指定した図形）の色は変えていません。");
  }

  if (o.page) {
    const pres = parseXml(pkg, "ppt/presentation.xml");
    const sz = pres ? all(pres, P, "sldSz")[0] : null;
    const oldW = Number(sz?.getAttribute("cx") ?? PPTX_W);
    const oldH = Number(sz?.getAttribute("cy") ?? PPTX_H);
    if (pres && sz && (oldW !== PPTX_W || oldH !== PPTX_H || sz.hasAttribute("type"))) {
      sz.setAttribute("cx", String(PPTX_W));
      sz.setAttribute("cy", String(PPTX_H));
      sz.removeAttribute("type");
      saveXml(pkg, "ppt/presentation.xml", pres);
      // 縦横の比を保ったまま、新しい大きさに収まるように拡大・縮小して、中央に置く（PowerPoint の「サイズに合わせて調整」と同じ）
      const s = Math.min(PPTX_W / oldW, PPTX_H / oldH);
      const dx = (PPTX_W - oldW * s) / 2;
      const dy = (PPTX_H - oldH * s) / 2;
      const targets = [...slides, ...partsMatching(pkg, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/), ...partsMatching(pkg, /^ppt\/slideMasters\/slideMaster\d+\.xml$/)];
      let moved = 0;
      for (const name of targets) {
        const doc = parseXml(pkg, name);
        if (!doc) continue;
        const tree = all(doc, P, "spTree")[0];
        if (!tree) continue;
        for (const shape of Array.from(tree.children)) {
          // spTree のすぐ下の図形だけを動かす（グループの中は、グループの大きさに合わせて自動で縮む）
          const spPr = child(shape, P, "spPr") ?? child(shape, P, "grpSpPr");
          const xfrm = child(shape, P, "xfrm") ?? (spPr ? child(spPr, A, "xfrm") : null);
          if (!xfrm) continue;
          const off = child(xfrm, A, "off");
          const ext = child(xfrm, A, "ext");
          if (off) {
            off.setAttribute("x", String(Math.round(Number(off.getAttribute("x") ?? 0) * s + dx)));
            off.setAttribute("y", String(Math.round(Number(off.getAttribute("y") ?? 0) * s + dy)));
          }
          if (ext) {
            ext.setAttribute("cx", String(Math.round(Number(ext.getAttribute("cx") ?? 0) * s)));
            ext.setAttribute("cy", String(Math.round(Number(ext.getAttribute("cy") ?? 0) * s)));
          }
          moved++;
        }
        saveXml(pkg, name, doc);
      }
      done.push(
        `スライドのサイズを標準（ワイド画面 16:9）に戻しました（${(oldW / 360000).toFixed(1)}×${(oldH / 360000).toFixed(1)}cm → 33.9×19.1cm）。図形・画像${moved}個を、縦横の比を保ったまま収まるように調整しました`
      );
      if (s < 0.999) notes.push("スライドが小さくなる向きの変更のため、文字が枠からはみ出すことがあります（文字の大きさは変えていません）。");
      else notes.push("スライドの左右（または上下）に余白ができます。");
    } else {
      done.push("スライドのサイズは、すでに標準（ワイド画面 16:9）でした");
    }
  }
  return { done, kept, notes };
}
