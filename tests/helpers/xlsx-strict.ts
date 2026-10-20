/**
 * XLSXが「Excelで警告なしに開ける構造か」を、アプリの実装とは別に確かめるテスト用の検証ヘルパー。
 *
 * LibreOfficeやread-excel-fileは、壊れかけたXLSX（セルの重複・順序違い・存在しないスタイルの参照など）も
 * 黙って読めてしまうが、Microsoft Excelは「ファイルの内容に問題があります」「修復されたレコード」の警告を出す。
 * ここでは、Excelが警告を出す原因になる代表的な構造の誤りを、ZIPの中身（XML）を直接読んで洗い出す。
 *
 * 確認する内容:
 *  - 全パートがXMLとして正しい（タグの対応・属性の引用符・不正な文字・不正な & の参照）
 *  - [Content_Types].xml が全パートを網羅し、関係（.rels）の参照先がすべて存在する
 *  - workbook: シート名（31文字以内・使えない文字なし・重複なし）、sheetId・r:id の重複なし、定義された名前の参照先
 *  - worksheet: 子要素の並び順（CT_Worksheetの規定どおり）、行・セルが重複なく昇順、セル参照の行が行番号と一致、
 *    スタイル番号・共有文字列の番号が範囲内、結合セルが重なっておらず件数が合う、列の定義が重ならない
 *  - styles: 件数属性が実数と一致、fontId/fillId/borderId/numFmtId の参照先が存在、色が ARGB（8桁16進）
 *
 * 新しい依存は追加しない（fflate と正規表現だけで読む）。
 */
import { unzipSync, strFromU8 } from "fflate";

export interface StrictXlsxReport {
  problems: string[];
  /** 検査したパートの数（検査が空振りでないことの確認用） */
  partCount: number;
  sheetCount: number;
}

const WORKSHEET_ORDER = [
  "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection",
  "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells",
  "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup",
  "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing",
  "legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst",
];
const WORKBOOK_ORDER = [
  "fileVersion", "fileSharing", "workbookPr", "workbookProtection", "bookViews", "sheets", "functionGroups",
  "externalReferences", "definedNames", "calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr",
  "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst",
];
const STYLES_ORDER = ["numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"];

const colNum = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** XMLとして正しいか（タグの対応・属性・不正な文字・& の参照）を簡易に調べる */
export function checkXmlWellFormed(xml: string, label: string): string[] {
  const problems: string[] = [];
  // XMLに書けない制御文字
  const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.exec(xml);
  if (bad) problems.push(`${label}: XMLに使えない制御文字 U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} が含まれる`);
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|(<)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  let rootClosed = false;
  while ((m = tagRe.exec(xml))) {
    const between = xml.slice(last, m.index);
    // タグの外のテキスト: & は決まった参照だけ
    for (const amp of between.matchAll(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/g)) {
      problems.push(`${label}: 不正な & の参照（位置 ${last + (amp.index ?? 0)}）`);
      break;
    }
    if (m[5] === "<") {
      problems.push(`${label}: 閉じられていない < （位置 ${m.index}）`);
      break;
    }
    if (m[2]) {
      const [, closing, name, attrs, selfClose] = m;
      if (closing) {
        const top = stack.pop();
        if (top !== name) {
          problems.push(`${label}: タグの対応が合わない </${name}>（開いているのは <${top}>）`);
          break;
        }
        if (stack.length === 0) rootClosed = true;
      } else {
        if (rootClosed) {
          problems.push(`${label}: ルート要素の後ろに別の要素がある`);
          break;
        }
        // 属性値の & と <
        for (const a of attrs.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          const v = a[1] ?? a[2] ?? "";
          if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/.test(v) || v.includes("<")) problems.push(`${label}: 属性値に不正な文字（${v.slice(0, 30)}）`);
        }
        const attrNames = [...attrs.matchAll(/([\w:.-]+)\s*=/g)].map((a) => a[1]);
        if (new Set(attrNames).size !== attrNames.length) problems.push(`${label}: <${name}> に同じ属性が重複している`);
        if (!selfClose) stack.push(name);
        else if (stack.length === 0) rootClosed = true;
      }
    }
    last = tagRe.lastIndex;
  }
  if (stack.length) problems.push(`${label}: 閉じられていないタグ <${stack[stack.length - 1]}>`);
  return problems;
}

function childOrder(xml: string, rootName: string, order: string[], label: string): string[] {
  const problems: string[] = [];
  const open = new RegExp(`<${rootName}\\b[^>]*>`).exec(xml);
  if (!open) return [`${label}: <${rootName}> がない`];
  const body = xml.slice(open.index + open[0].length, xml.lastIndexOf(`</${rootName}>`));
  // 直下の子要素だけを取り出す
  const names: string[] = [];
  let depth = 0;
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const [, closing, name, selfClose] = m;
    if (closing) {
      depth--;
    } else {
      if (depth === 0) names.push(name.replace(/^.*:/, ""));
      if (!selfClose) depth++;
    }
  }
  let prev = -1;
  for (const n of names) {
    const idx = order.indexOf(n);
    if (idx === -1) {
      problems.push(`${label}: <${rootName}> の中に未知の要素 <${n}>`);
      continue;
    }
    if (idx < prev) problems.push(`${label}: <${n}> の位置が規定の順序と違う（${order[prev]} より前にあるべきではない）`);
    prev = Math.max(prev, idx);
  }
  return problems;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

export function validateXlsxStrict(bytes: Uint8Array): StrictXlsxReport {
  const problems: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    return { problems: ["ZIPとして読めない"], partCount: 0, sheetCount: 0 };
  }
  const names = Object.keys(files);
  const text = (n: string) => strFromU8(files[n]);

  // 1. XMLとして正しいか
  for (const n of names) if (/\.(xml|rels)$/.test(n)) problems.push(...checkXmlWellFormed(text(n), n));

  // 2. [Content_Types].xml
  if (!files["[Content_Types].xml"]) problems.push("[Content_Types].xml がない");
  else {
    const ct = text("[Content_Types].xml");
    const defaults = new Set([...ct.matchAll(/<Default\b[^>]*\sExtension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
    const overrides = new Set([...ct.matchAll(/<Override\b[^>]*\sPartName="([^"]+)"/g)].map((m) => m[1]));
    for (const o of overrides) if (!files[o.slice(1)]) problems.push(`[Content_Types].xml: 存在しないパートの Override（${o}）`);
    for (const n of names) {
      if (n === "[Content_Types].xml") continue;
      const ext = n.split(".").pop()!.toLowerCase();
      if (!overrides.has(`/${n}`) && !defaults.has(ext)) problems.push(`[Content_Types].xml: ${n} の種類が定義されていない`);
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(n) && !overrides.has(`/${n}`)) problems.push(`[Content_Types].xml: ${n} の Override がない`);
    }
  }

  // 3. 関係（.rels）
  for (const n of names.filter((x) => x.endsWith(".rels"))) {
    const xml = text(n);
    const ids = [...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]);
    const seen = new Set<string>();
    const sourceDir = n.replace(/_rels\/([^/]*)\.rels$/, "$1");
    for (const tag of ids) {
      const id = attr(tag, "Id");
      const target = attr(tag, "Target");
      if (!id || !target) {
        problems.push(`${n}: Id または Target がない`);
        continue;
      }
      if (seen.has(id)) problems.push(`${n}: Id が重複（${id}）`);
      seen.add(id);
      if (attr(tag, "TargetMode") === "External") continue;
      const base = n === "_rels/.rels" ? "x" : sourceDir;
      const resolved = n === "_rels/.rels" ? resolveTarget("x", target) : resolveTarget(sourceDir, target);
      void base;
      if (!files[resolved]) problems.push(`${n}: 参照先が存在しない（${target} → ${resolved}）`);
    }
  }

  // 4. workbook.xml
  const wbXml = files["xl/workbook.xml"] ? text("xl/workbook.xml") : "";
  const sheets: { name: string; rid: string; sheetId: string }[] = [];
  if (!wbXml) problems.push("xl/workbook.xml がない");
  else {
    problems.push(...childOrder(wbXml, "workbook", WORKBOOK_ORDER, "xl/workbook.xml"));
    for (const tag of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
      sheets.push({ name: attr(tag[0], "name") ?? "", rid: attr(tag[0], "r:id") ?? "", sheetId: attr(tag[0], "sheetId") ?? "" });
    }
    const lowerNames = new Set<string>();
    const sheetIds = new Set<string>();
    const rids = new Set<string>();
    for (const s of sheets) {
      const decoded = s.name.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      if (!decoded || [...decoded].length > 31) problems.push(`シート名の長さが不正（${decoded}）`);
      if (/[:\\/?*[\]]/.test(decoded)) problems.push(`シート名に使えない文字（${decoded}）`);
      if (/^'|'$/.test(decoded)) problems.push(`シート名の先頭・末尾に ' がある（${decoded}）`);
      if (lowerNames.has(decoded.toLowerCase())) problems.push(`シート名が重複（${decoded}）`);
      lowerNames.add(decoded.toLowerCase());
      if (sheetIds.has(s.sheetId)) problems.push(`sheetId が重複（${s.sheetId}）`);
      sheetIds.add(s.sheetId);
      if (rids.has(s.rid)) problems.push(`シートの r:id が重複（${s.rid}）`);
      rids.add(s.rid);
    }
    // 定義された名前
    const relsXml = files["xl/_rels/workbook.xml.rels"] ? text("xl/_rels/workbook.xml.rels") : "";
    for (const s of sheets) {
      const rel = [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, "Id") === s.rid);
      if (!rel) problems.push(`シート「${s.name}」の r:id（${s.rid}）に対応する関係がない`);
      else if (!/\/worksheet$/.test(attr(rel, "Type") ?? "")) problems.push(`シート「${s.name}」の関係の種類が worksheet ではない`);
    }
    const dnSeen = new Set<string>();
    for (const m of wbXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
      const nm = attr(m[1], "name");
      const local = attr(m[1], "localSheetId");
      const key = `${nm}|${local ?? ""}`;
      if (dnSeen.has(key)) problems.push(`定義された名前が重複（${key}）`);
      dnSeen.add(key);
      if (local !== undefined && Number(local) >= sheets.length) problems.push(`定義された名前の localSheetId が範囲外（${local}）`);
      const ref = m[2].replace(/&apos;/g, "'");
      const sm = /^'((?:[^']|'')+)'!(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)$/.exec(ref) ?? /^([^'!]+)!(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)$/.exec(ref);
      if (!sm) problems.push(`定義された名前の参照が正しくない（${ref}）`);
      else {
        const target = sm[1].replace(/''/g, "'");
        const idx = sheets.findIndex((s) => s.name.replace(/&amp;/g, "&").replace(/&apos;/g, "'") === target);
        if (idx === -1) problems.push(`定義された名前が存在しないシートを指している（${target}）`);
        else if (local !== undefined && Number(local) !== idx) problems.push(`定義された名前の localSheetId（${local}）と参照先のシート（${idx}）が違う`);
      }
    }
  }

  // 5. styles.xml
  let cellXfCount = 0;
  let sstCount = 0;
  if (files["xl/sharedStrings.xml"]) sstCount = [...text("xl/sharedStrings.xml").matchAll(/<si\b/g)].length;
  if (files["xl/styles.xml"]) {
    const st = text("xl/styles.xml");
    problems.push(...childOrder(st, "styleSheet", STYLES_ORDER, "xl/styles.xml"));
    const countOf = (tag: string, child: string) => {
      const m = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`).exec(st);
      if (!m) return { count: 0, declared: undefined as number | undefined, body: "" };
      const items = [...m[2].matchAll(new RegExp(`<${child}\\b[^>]*?(?:/>|>)`, "g"))].length;
      const declared = attr(`<${tag}${m[1]}>`, "count");
      return { count: items, declared: declared === undefined ? undefined : Number(declared), body: m[2] };
    };
    const fonts = countOf("fonts", "font");
    const fills = countOf("fills", "fill");
    const borders = countOf("borders", "border");
    const xfs = countOf("cellXfs", "xf");
    const numFmts = countOf("numFmts", "numFmt");
    for (const [label, c] of [["fonts", fonts], ["fills", fills], ["borders", borders], ["cellXfs", xfs], ["numFmts", numFmts]] as const) {
      if (c.declared !== undefined && c.declared !== c.count) problems.push(`styles.xml: ${label} の count（${c.declared}）が実数（${c.count}）と違う`);
    }
    cellXfCount = xfs.count;
    const customFmtIds = new Set([...numFmts.body.matchAll(/numFmtId="(\d+)"/g)].map((m) => Number(m[1])));
    for (const m of xfs.body.matchAll(/<xf\b([^>]*)>/g)) {
      const tag = `<xf${m[1]}>`;
      const f = attr(tag, "fontId");
      const fi = attr(tag, "fillId");
      const b = attr(tag, "borderId");
      const nf = attr(tag, "numFmtId");
      if (f !== undefined && Number(f) >= fonts.count) problems.push(`styles.xml: fontId ${f} が範囲外`);
      if (fi !== undefined && Number(fi) >= fills.count) problems.push(`styles.xml: fillId ${fi} が範囲外`);
      if (b !== undefined && Number(b) >= borders.count) problems.push(`styles.xml: borderId ${b} が範囲外`);
      if (nf !== undefined && Number(nf) >= 164 && !customFmtIds.has(Number(nf))) problems.push(`styles.xml: numFmtId ${nf} が定義されていない`);
    }
    for (const m of st.matchAll(/<(?:color|fgColor|bgColor)\b([^>]*)\/?>/g)) {
      const rgb = attr(`<c${m[1]}>`, "rgb");
      if (rgb !== undefined && !/^[0-9A-F]{8}$/.test(rgb)) problems.push(`styles.xml: 色コードが不正（${rgb}）`);
    }
  } else problems.push("xl/styles.xml がない");

  // 6. 各ワークシート
  const sheetParts = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  for (const n of sheetParts) {
    const xml = text(n);
    problems.push(...childOrder(xml, "worksheet", WORKSHEET_ORDER, n));
    // 子要素の重複（単一であるべきもの）
    for (const single of ["sheetPr", "sheetViews", "cols", "sheetData", "mergeCells", "printOptions", "pageMargins", "pageSetup"]) {
      const c = [...xml.matchAll(new RegExp(`<${single}[\\s>/]`, "g"))].length;
      if (c > 1) problems.push(`${n}: <${single}> が ${c} 個ある`);
    }
    // sheetPr の中の順序: tabColor, outlinePr, pageSetUpPr
    const sp = /<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/.exec(xml);
    if (sp) {
      const kids = [...sp[1].matchAll(/<(tabColor|outlinePr|pageSetUpPr)\b/g)].map((m) => m[1]);
      const order = ["tabColor", "outlinePr", "pageSetUpPr"];
      for (let i = 1; i < kids.length; i++) if (order.indexOf(kids[i]) < order.indexOf(kids[i - 1])) problems.push(`${n}: sheetPr の子要素の順序が違う`);
    }
    for (const m of xml.matchAll(/<tabColor\b([^>]*)\/?>/g)) {
      const rgb = attr(`<t${m[1]}>`, "rgb");
      if (rgb !== undefined && !/^[0-9A-F]{8}$/.test(rgb)) problems.push(`${n}: tabColor の色が不正（${rgb}）`);
    }
    // ウィンドウ枠の固定
    for (const m of xml.matchAll(/<pane\b([^>]*)\/?>/g)) {
      const tag = `<pane${m[1]}>`;
      const xs = Number(attr(tag, "xSplit") ?? 0);
      const ys = Number(attr(tag, "ySplit") ?? 0);
      const active = attr(tag, "activePane");
      const expected = xs > 0 && ys > 0 ? "bottomRight" : ys > 0 ? "bottomLeft" : xs > 0 ? "topRight" : undefined;
      if (xs === 0 && ys === 0) problems.push(`${n}: pane の分割が0`);
      else if (active !== undefined && active !== expected) problems.push(`${n}: pane の activePane（${active}）が分割（x=${xs}, y=${ys}）と合わない（${expected} が正しい）`);
    }
    // 行とセル
    const sd = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>|<sheetData\b[^>]*\/>/.exec(xml);
    let maxRow = 0;
    let maxCol = 0;
    if (sd?.[1] !== undefined) {
      let prevRow = 0;
      for (const rm of sd[1].matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = Number(attr(`<row${rm[1]}>`, "r"));
        if (!Number.isInteger(r) || r < 1 || r > 1048576) problems.push(`${n}: 行番号が不正（${attr(`<row${rm[1]}>`, "r")}）`);
        if (r <= prevRow) problems.push(`${n}: 行 ${r} が重複または昇順でない`);
        prevRow = r;
        maxRow = Math.max(maxRow, r);
        let prevCol = 0;
        for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ctag = `<c${cm[1]}>`;
          const ref = attr(ctag, "r") ?? "";
          const rr = /^([A-Z]{1,3})(\d+)$/.exec(ref);
          if (!rr) {
            problems.push(`${n}: セル参照が不正（${ref}）`);
            continue;
          }
          const col = colNum(rr[1]);
          if (col > 16384) problems.push(`${n}: 列が範囲外（${ref}）`);
          if (Number(rr[2]) !== r) problems.push(`${n}: セル ${ref} が行 ${r} の中にある`);
          if (col <= prevCol) problems.push(`${n}: 行 ${r} のセル ${ref} が重複または昇順でない`);
          prevCol = col;
          maxCol = Math.max(maxCol, col);
          const s = attr(ctag, "s");
          if (s !== undefined && Number(s) >= cellXfCount) problems.push(`${n}: ${ref} のスタイル番号 ${s} が範囲外（cellXfs は ${cellXfCount} 個）`);
          const t = attr(ctag, "t");
          const v = /<v>([\s\S]*?)<\/v>/.exec(cm[2] ?? "")?.[1];
          if (t === "s") {
            if (v === undefined || !/^\d+$/.test(v) || Number(v) >= sstCount) problems.push(`${n}: ${ref} の共有文字列の番号が不正（${v}）`);
          } else if (t === undefined || t === "n") {
            if (v !== undefined && !Number.isFinite(Number(v))) problems.push(`${n}: ${ref} の数値が不正（${v}）`);
          } else if (t === "b") {
            if (v !== "0" && v !== "1") problems.push(`${n}: ${ref} の真偽値が不正`);
          } else if (!["str", "inlineStr", "e", "d"].includes(t)) problems.push(`${n}: ${ref} のセルの型が不正（${t}）`);
        }
      }
    }
    // 結合セル
    const mc = /<mergeCells\b([^>]*)>([\s\S]*?)<\/mergeCells>/.exec(xml);
    if (mc) {
      const refs = [...mc[2].matchAll(/<mergeCell\b[^>]*\sref="([^"]+)"/g)].map((m) => m[1]);
      const declared = attr(`<mergeCells${mc[1]}>`, "count");
      if (declared !== undefined && Number(declared) !== refs.length) problems.push(`${n}: mergeCells の count（${declared}）が実数（${refs.length}）と違う`);
      const rects: { r1: number; c1: number; r2: number; c2: number; ref: string }[] = [];
      for (const ref of refs) {
        const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
        if (!m) {
          problems.push(`${n}: 結合セルの範囲が不正（${ref}）`);
          continue;
        }
        const rect = { c1: colNum(m[1]), r1: Number(m[2]), c2: colNum(m[3]), r2: Number(m[4]), ref };
        if (rect.c2 < rect.c1 || rect.r2 < rect.r1) problems.push(`${n}: 結合セルの範囲の向きが逆（${ref}）`);
        if (rect.c1 === rect.c2 && rect.r1 === rect.r2) problems.push(`${n}: 1セルだけの結合（${ref}）`);
        rects.push(rect);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          if (a.c1 <= b.c2 && b.c1 <= a.c2 && a.r1 <= b.r2 && b.r1 <= a.r2) problems.push(`${n}: 結合セルが重なっている（${a.ref} と ${b.ref}）`);
        }
      }
    }
    // 列の定義
    let prevMax = 0;
    for (const cm of xml.matchAll(/<col\b([^>]*)\/?>/g)) {
      const tag = `<col${cm[1]}>`;
      const min = Number(attr(tag, "min"));
      const max = Number(attr(tag, "max"));
      if (!(min >= 1 && max >= min && max <= 16384)) problems.push(`${n}: <col> の範囲が不正（${min}-${max}）`);
      if (min <= prevMax) problems.push(`${n}: <col> が重なっている、または昇順でない（${min}-${max}）`);
      prevMax = Math.max(prevMax, max);
      const w = Number(attr(tag, "width"));
      if (attr(tag, "width") !== undefined && !(w >= 0 && w <= 255)) problems.push(`${n}: 列幅が範囲外（${w}）`);
    }
    // 印刷設定の値
    const ps = /<pageSetup\b([^>]*)\/?>/.exec(xml);
    if (ps) {
      const tag = `<pageSetup${ps[1]}>`;
      const o = attr(tag, "orientation");
      if (o !== undefined && !["portrait", "landscape", "default"].includes(o)) problems.push(`${n}: pageSetup の orientation が不正（${o}）`);
      const paper = attr(tag, "paperSize");
      if (paper !== undefined && !(Number(paper) >= 1 && Number(paper) <= 118)) problems.push(`${n}: pageSetup の paperSize が不正（${paper}）`);
    }
    const pm = /<pageMargins\b([^>]*)\/?>/.exec(xml);
    if (pm) {
      for (const k of ["left", "right", "top", "bottom", "header", "footer"]) {
        const v = attr(`<pageMargins${pm[1]}>`, k);
        if (v === undefined || !(Number(v) >= 0)) problems.push(`${n}: pageMargins の ${k} が不正または未指定（${v}）`);
      }
    }
    void maxRow;
    void maxCol;
  }
  if (sheets.length !== sheetParts.length) problems.push(`シートの数（${sheets.length}）とワークシートのパートの数（${sheetParts.length}）が違う`);

  return { problems, partCount: names.length, sheetCount: sheetParts.length };
}
