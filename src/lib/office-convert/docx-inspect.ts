import { strFromU8, unzipSync } from "fflate";

/**
 * できあがったWord文書（.docx）を開き直して、ページの大きさ・余白・表の幅・画像の大きさを確かめる。
 * 変換のときに計算した値ではなく、実際に書き出したファイルの中身（document.xml）を読む（書き出しの途中のずれも見つけるため）。
 * ブラウザでもテスト（Node）でも動くよう、XMLは文字列のまま読む。
 */
export interface DocxSectionInfo {
  pageWidthTw: number;
  pageHeightTw: number;
  orientation: "portrait" | "landscape";
  marginLeftTw: number;
  marginRightTw: number;
  marginTopTw: number;
  marginBottomTw: number;
  printableWidthTw: number;
  printableHeightTw: number;
}

export interface DocxTableInfo {
  section: number;
  /** 列の幅（gridCol）の合計 */
  gridWidthTw: number;
  /** 表の幅の指定（tblW。twipの指定のときだけ） */
  tableWidthTw: number | null;
  /** 行ごとのセルの幅（tcW）の合計の最大 */
  maxRowWidthTw: number;
  indentTw: number;
  /** 印刷できる範囲の横幅を超えた分（0 = 収まっている） */
  overflowTw: number;
  rows: number;
  fixedLayout: boolean;
  headerRows: number;
}

export interface DocxImageInfo {
  section: number;
  widthEmu: number;
  heightEmu: number;
  overflowWidthEmu: number;
  overflowHeightEmu: number;
}

export interface DocxInspection {
  sections: DocxSectionInfo[];
  tables: DocxTableInfo[];
  images: DocxImageInfo[];
  nonEmptyCells: number;
  mergedCells: number;
  consecutivePageBreaks: number;
}

const EMU_PER_TWIP = 635;

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};
const num = (v: string | null, fallback = 0) => (v === null || v === "" ? fallback : Number(v));

function parseSection(xml: string): DocxSectionInfo {
  const pgSz = /<w:pgSz\b[^>]*>/.exec(xml)?.[0] ?? "";
  const pgMar = /<w:pgMar\b[^>]*>/.exec(xml)?.[0] ?? "";
  const w = num(attr(pgSz, "w:w"), 11906);
  const h = num(attr(pgSz, "w:h"), 16838);
  const left = num(attr(pgMar, "w:left"), 1440);
  const right = num(attr(pgMar, "w:right"), 1440);
  const top = num(attr(pgMar, "w:top"), 1440);
  const bottom = num(attr(pgMar, "w:bottom"), 1440);
  return {
    pageWidthTw: w,
    pageHeightTw: h,
    orientation: attr(pgSz, "w:orient") === "landscape" || w > h ? "landscape" : "portrait",
    marginLeftTw: left,
    marginRightTw: right,
    marginTopTw: top,
    marginBottomTw: bottom,
    printableWidthTw: w - left - right,
    printableHeightTw: h - top - Math.abs(bottom),
  };
}

/** 本文の一番外側の表（入れ子の表は含めない）の範囲を、出現順に返す */
function topLevelTables(body: string): { start: number; end: number; xml: string }[] {
  const out: { start: number; end: number; xml: string }[] = [];
  const re = /<w:tbl>|<w:tbl\s[^>]*>|<\/w:tbl>/g;
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0 && start >= 0) {
        const end = m.index + m[0].length;
        out.push({ start, end, xml: body.slice(start, end) });
        start = -1;
      }
    } else {
      if (depth === 0) start = m.index;
      depth++;
    }
  }
  return out;
}

export function inspectDocx(bytes: Uint8Array): DocxInspection {
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : "";
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? "";

  // セクションの区切り（w:sectPr）の位置。表・画像は、その後ろにある最初の区切りのセクションに属する
  const sectPositions: { pos: number; info: DocxSectionInfo }[] = [];
  const sectRe = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sectRe.exec(body))) sectPositions.push({ pos: sm.index, info: parseSection(sm[0]) });
  const sectionAt = (pos: number) => {
    const i = sectPositions.findIndex((s) => s.pos >= pos);
    return i >= 0 ? i : Math.max(0, sectPositions.length - 1);
  };
  const sections = sectPositions.map((s) => s.info);

  const tables: DocxTableInfo[] = [];
  let nonEmptyCells = 0;
  let mergedCells = 0;
  for (const t of topLevelTables(body)) {
    const section = sectionAt(t.start);
    const sec = sections[section];
    const grid = [...t.xml.matchAll(/<w:gridCol\b[^>]*>/g)].map((g) => num(attr(g[0], "w:w")));
    const gridWidthTw = grid.reduce((s, w) => s + w, 0);
    const tblW = /<w:tblW\b[^>]*>/.exec(t.xml)?.[0] ?? "";
    const tableWidthTw = attr(tblW, "w:type") === "dxa" ? num(attr(tblW, "w:w")) : null;
    const tblInd = /<w:tblInd\b[^>]*>/.exec(t.xml)?.[0] ?? "";
    const indentTw = num(attr(tblInd, "w:w"));
    const rows = [...t.xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) => r[0]);
    let maxRowWidthTw = 0;
    let headerRows = 0;
    for (const row of rows) {
      if (/<w:tblHeader\b/.test(row)) headerRows++;
      let rowW = 0;
      for (const tc of row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)) {
        const tcW = /<w:tcW\b[^>]*>/.exec(tc[0])?.[0] ?? "";
        if (attr(tcW, "w:type") === "dxa") rowW += num(attr(tcW, "w:w"));
        const text = [...tc[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join("");
        if (text.trim() !== "") nonEmptyCells++;
        const span = num(attr(/<w:gridSpan\b[^>]*>/.exec(tc[0])?.[0] ?? "", "w:val"), 1);
        const vMergeTag = /<w:vMerge\b[^>]*>/.exec(tc[0])?.[0];
        const restart = vMergeTag ? attr(vMergeTag, "w:val") === "restart" : false;
        const cont = vMergeTag ? !restart : false;
        if (!cont && (span > 1 || restart)) mergedCells++;
      }
      maxRowWidthTw = Math.max(maxRowWidthTw, rowW);
    }
    const width = Math.max(gridWidthTw, tableWidthTw ?? 0, maxRowWidthTw);
    tables.push({
      section,
      gridWidthTw,
      tableWidthTw,
      maxRowWidthTw,
      indentTw,
      overflowTw: sec ? Math.max(0, indentTw + width - sec.printableWidthTw, -indentTw) : 0,
      rows: rows.length,
      fixedLayout: /<w:tblLayout\b[^>]*w:type="fixed"/.test(t.xml),
      headerRows,
    });
  }

  const images: DocxImageInfo[] = [];
  for (const d of body.matchAll(/<wp:extent\b[^>]*>/g)) {
    const section = sectionAt(d.index ?? 0);
    const sec = sections[section];
    const cx = num(attr(d[0], "cx"));
    const cy = num(attr(d[0], "cy"));
    images.push({
      section,
      widthEmu: cx,
      heightEmu: cy,
      overflowWidthEmu: sec ? Math.max(0, cx - sec.printableWidthTw * EMU_PER_TWIP) : 0,
      overflowHeightEmu: sec ? Math.max(0, cy - sec.printableHeightTw * EMU_PER_TWIP) : 0,
    });
  }

  // 改ページだけの段落が続いている（空白のページになる）ところ
  const paras = [...body.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b/g)].map((p) => p[0]);
  let consecutivePageBreaks = 0;
  for (let i = 1; i < paras.length; i++) {
    const isBreak = (p: string) => /<w:br w:type="page"\/>/.test(p) && !/<w:t[\s>]/.test(p);
    if (isBreak(paras[i]) && isBreak(paras[i - 1])) consecutivePageBreaks++;
  }

  return { sections, tables, images, nonEmptyCells, mergedCells, consecutivePageBreaks };
}
