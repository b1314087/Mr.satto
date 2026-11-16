import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { readDoc, DocError, type CharProps, type DocBlock, type DocModel, type DocParagraph, type DocTable, type Inline, type ParaProps, type SectProps, type Border } from "./doc-reader";
import type { ConversionCheck } from "./excel-to-word";

/**
 * Word旧形式（.doc）→ 新形式（.docx）の変換。
 *
 * .doc を読み（doc-reader.ts）、Word の新しい形式（Office Open XML）を、スタイル・段落・文字の書式・表・画像・ヘッダー・フッター・
 * 脚注・箇条書き・セクションごとに、1つずつ書き直す（文章だけを取り出して貼り付ける簡易変換ではない）。
 * 書き出したファイルは、もう一度開いて、段落・表・画像の数と文字が元と同じかを確かめる（変換後の確認）。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

export const MAX_DOC_FILE_MB = 30;

export interface DocToDocxOutput {
  blob: Blob;
  summary: { paragraphs: number; tables: number; images: number; sections: number; footnotes: number; headers: number; characters: number };
  checks: ConversionCheck[];
  warnings: string[];
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 箇条書きの番号の種類（.doc の nfc）→ docx の numFmt */
const NUM_FMT: Record<number, string> = {
  0: "decimal", 1: "upperRoman", 2: "lowerRoman", 3: "upperLetter", 4: "lowerLetter", 5: "ordinal", 6: "cardinalText", 7: "ordinalText", 8: "hex",
  9: "chicago", 10: "ideographDigital", 11: "japaneseCounting", 12: "aiueo", 13: "iroha", 14: "decimalFullWidth", 15: "decimalHalfWidth",
  16: "japaneseLegal", 17: "japaneseDigitalTenThousand", 18: "decimalEnclosedCircle", 19: "decimalFullWidth2", 20: "aiueoFullWidth",
  21: "irohaFullWidth", 22: "decimalZero", 23: "bullet", 24: "ganada", 25: "chosung", 26: "decimalEnclosedFullstop", 27: "decimalEnclosedParen",
  28: "decimalEnclosedCircleChinese", 29: "ideographEnclosedCircle", 30: "ideographTraditional", 31: "ideographZodiac", 32: "ideographZodiacTraditional",
  33: "taiwaneseCounting", 34: "ideographLegalTraditional", 35: "taiwaneseCountingThousand", 36: "taiwaneseDigital", 37: "chineseCounting",
  38: "chineseLegalSimplified", 39: "chineseCountingThousand", 255: "none",
};

/** 1つの部品（本文・ヘッダー・フッター・脚注）の、画像のつながり（rels） */
class Part {
  rels: { id: string; type: string; target: string }[] = [];
  addImage(target: string): string {
    const existing = this.rels.find((r) => r.target === target);
    if (existing) return existing.id;
    const id = `rIdImg${this.rels.length + 1}`;
    this.rels.push({ id, type: REL_IMAGE, target });
    return id;
  }
}

class Writer {
  private styleIds = new Map<number, string>();
  private drawingId = 1;
  stats = { paragraphs: 0, tables: 0, images: 0, characters: 0 };

  constructor(private readonly m: DocModel) {
    for (const s of m.styles) {
      let id: string;
      if (s.sti === 0) id = "Normal";
      else if (s.sti >= 1 && s.sti <= 9) id = `Heading${s.sti}`;
      else if (s.sti === 65) id = "DefaultParagraphFont";
      else id = `Style${s.istd}`;
      this.styleIds.set(s.istd, id);
    }
  }

  font(i: number | undefined): string | undefined {
    return i === undefined ? undefined : this.m.fonts[i];
  }

  rPr(c: CharProps, opts: { skipStyle?: boolean } = {}): string {
    const out: string[] = [];
    if (c.charStyle !== undefined && !opts.skipStyle) {
      const id = this.styleIds.get(c.charStyle);
      if (id && id !== "DefaultParagraphFont") out.push(`<w:rStyle w:val="${id}"/>`);
    }
    const ascii = this.font(c.fontAscii);
    const ea = this.font(c.fontEastAsia);
    const other = this.font(c.fontOther);
    if (ascii || ea || other) {
      out.push(
        `<w:rFonts${ascii ? ` w:ascii="${esc(ascii)}"` : ""}${other || ascii ? ` w:hAnsi="${esc((other ?? ascii)!)}"` : ""}${ea ? ` w:eastAsia="${esc(ea)}"` : ""}${other || ascii ? ` w:cs="${esc((other ?? ascii)!)}"` : ""}/>`
      );
    }
    if (c.bold !== undefined) out.push(c.bold ? "<w:b/><w:bCs/>" : '<w:b w:val="0"/><w:bCs w:val="0"/>');
    if (c.italic !== undefined) out.push(c.italic ? "<w:i/><w:iCs/>" : '<w:i w:val="0"/><w:iCs w:val="0"/>');
    if (c.caps !== undefined) out.push(c.caps ? "<w:caps/>" : '<w:caps w:val="0"/>');
    if (c.smallCaps !== undefined) out.push(c.smallCaps ? "<w:smallCaps/>" : '<w:smallCaps w:val="0"/>');
    if (c.strike !== undefined) out.push(c.strike ? "<w:strike/>" : '<w:strike w:val="0"/>');
    if (c.dstrike !== undefined) out.push(c.dstrike ? "<w:dstrike/>" : '<w:dstrike w:val="0"/>');
    if (c.vanish !== undefined) out.push(c.vanish ? "<w:vanish/>" : '<w:vanish w:val="0"/>');
    if (c.color) out.push(`<w:color w:val="${c.color}"/>`);
    if (c.sizeHalfPt) out.push(`<w:sz w:val="${c.sizeHalfPt}"/><w:szCs w:val="${c.sizeHalfPt}"/>`);
    if (c.highlight && c.highlight !== "none") out.push(`<w:highlight w:val="${c.highlight}"/>`);
    if (c.shading) out.push(`<w:shd w:val="clear" w:color="auto" w:fill="${c.shading}"/>`);
    if (c.underline) out.push(`<w:u w:val="${c.underline}"/>`);
    if (c.vertAlign) out.push(`<w:vertAlign w:val="${c.vertAlign}"/>`);
    return out.length ? `<w:rPr>${out.join("")}</w:rPr>` : "";
  }

  pPrInner(p: ParaProps, withStyle: boolean): string {
    const out: string[] = [];
    if (withStyle && p.istd !== undefined) {
      const id = this.styleIds.get(p.istd);
      if (id && id !== "Normal") out.push(`<w:pStyle w:val="${id}"/>`);
    }
    if (p.keepNext !== undefined) out.push(p.keepNext ? "<w:keepNext/>" : '<w:keepNext w:val="0"/>');
    if (p.keepLines !== undefined) out.push(p.keepLines ? "<w:keepLines/>" : '<w:keepLines w:val="0"/>');
    if (p.pageBreakBefore !== undefined) out.push(p.pageBreakBefore ? "<w:pageBreakBefore/>" : '<w:pageBreakBefore w:val="0"/>');
    if (p.ilfo !== undefined) {
      if (p.ilfo > 0 && p.ilfo <= this.m.lfoToList.length && this.m.lfoToList[p.ilfo - 1] >= 0) out.push(`<w:numPr><w:ilvl w:val="${p.ilvl ?? 0}"/><w:numId w:val="${p.ilfo}"/></w:numPr>`);
      else out.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr>');
    }
    if (p.spBefore !== undefined || p.spAfter !== undefined || p.line) {
      const line = p.line ? ` w:line="${Math.abs(p.line.val)}" w:lineRule="${p.line.mult ? "auto" : p.line.val < 0 ? "exact" : "atLeast"}"` : "";
      out.push(`<w:spacing${p.spBefore !== undefined ? ` w:before="${p.spBefore}"` : ""}${p.spAfter !== undefined ? ` w:after="${p.spAfter}"` : ""}${line}/>`);
    }
    if (p.indLeft !== undefined || p.indRight !== undefined || p.indFirst !== undefined) {
      const first = p.indFirst ?? 0;
      out.push(
        `<w:ind${p.indLeft !== undefined ? ` w:left="${p.indLeft}"` : ""}${p.indRight !== undefined ? ` w:right="${p.indRight}"` : ""}${p.indFirst !== undefined ? (first < 0 ? ` w:hanging="${-first}"` : ` w:firstLine="${first}"`) : ""}/>`
      );
    }
    if (p.jc) out.push(`<w:jc w:val="${p.jc}"/>`);
    if (p.outlineLvl !== undefined && p.outlineLvl < 9) out.push(`<w:outlineLvl w:val="${p.outlineLvl}"/>`);
    return out.join("");
  }

  border(tag: string, b: Border | undefined): string {
    return b ? `<w:${tag} w:val="${b.val}" w:sz="${b.sz}" w:space="0" w:color="${b.color}"/>` : "";
  }

  inline(i: Inline, part: Part): string {
    const rpr = this.rPr(i.props);
    switch (i.kind) {
      case "text": {
        this.stats.characters += i.text.length;
        return `<w:r>${rpr}<w:t xml:space="preserve">${esc(i.text)}</w:t></w:r>`;
      }
      case "tab":
        return `<w:r>${rpr}<w:tab/></w:r>`;
      case "break":
        return `<w:r>${rpr}<w:br${i.type === "line" ? "" : ` w:type="${i.type}"`}/></w:r>`;
      case "symbol":
        return `<w:r>${rpr}<w:sym w:font="${esc(i.font)}" w:char="${i.char.toString(16).toUpperCase().padStart(4, "0")}"/></w:r>`;
      case "field":
        return `<w:fldSimple w:instr=" ${i.instr} "><w:r>${rpr}<w:t>${esc(i.result)}</w:t></w:r></w:fldSimple>`;
      case "footnoteRef":
        return `<w:r>${this.rPr({ ...i.props, vertAlign: "superscript" })}<w:footnoteReference w:id="${i.id + 1}"/></w:r>`;
      case "footnoteMark":
        return `<w:r>${this.rPr({ ...i.props, vertAlign: "superscript" })}<w:footnoteRef/></w:r>`;
      case "image": {
        const img = this.m.images[i.image];
        if (!img) return "";
        this.stats.images++;
        const target = `media/image${i.image + 1}.${img.ext}`;
        const rid = part.addImage(target);
        const id = this.drawingId++;
        return `<w:r>${rpr}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${img.widthEmu}" cy="${img.heightEmu}"/><wp:docPr id="${id}" name="図 ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${i.image + 1}.${img.ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.widthEmu}" cy="${img.heightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      }
    }
  }

  paragraph(p: DocParagraph, part: Part, sectPr = ""): string {
    this.stats.paragraphs++;
    const mark = this.rPr(p.markProps);
    const inner = this.pPrInner(p.props, true);
    const pPr = inner || mark || sectPr ? `<w:pPr>${inner}${mark}${sectPr}</w:pPr>` : "";
    return `<w:p>${pPr}${p.inlines.map((i) => this.inline(i, part)).join("")}</w:p>`;
  }

  table(t: DocTable, part: Part): string {
    this.stats.tables++;
    // 列の区切り（全行の区切りの位置を合わせた格子）
    const origin = Math.min(...t.rows.map((r) => r.props.centers[0] ?? 0));
    const edges = new Set<number>();
    for (const r of t.rows) for (const c of r.props.centers) edges.add(c);
    const sorted = [...edges].sort((a, b) => a - b);
    const grid = sorted.length > 1 ? sorted.slice(1).map((e, i) => Math.max(1, e - sorted[i])) : [];
    const first = t.rows.find((r) => r.props.tableBorders)?.props.tableBorders;
    const tblBorders = first
      ? `<w:tblBorders>${this.border("top", first.top)}${this.border("left", first.left)}${this.border("bottom", first.bottom)}${this.border("right", first.right)}${this.border("insideH", first.insideH)}${this.border("insideV", first.insideV)}</w:tblBorders>`
      : "";
    const jc = t.rows[0]?.props.jc;
    const mar = t.rows.find((r) => r.props.cellMargins)?.props.cellMargins ?? {};
    const cellMar = `<w:tblCellMar>${mar.top !== undefined ? `<w:top w:w="${mar.top}" w:type="dxa"/>` : ""}<w:left w:w="${mar.left ?? 108}" w:type="dxa"/>${mar.bottom !== undefined ? `<w:bottom w:w="${mar.bottom}" w:type="dxa"/>` : ""}<w:right w:w="${mar.right ?? 108}" w:type="dxa"/></w:tblCellMar>`;
    // 表の左の位置（罫線の位置）。.doc の区切りの最初の値と同じ意味
    const indent = origin;
    const rows = t.rows.map((row) => {
      const defs = row.props.cells;
      const centers = row.props.centers;
      const cellsXml: string[] = [];
      let k = 0;
      while (k < row.cells.length) {
        const def = defs[k];
        // 古い形の横の結合：続きのセルを最初のセルにまとめる
        let endIndex = k;
        if (def?.hMergeFirst) while (endIndex + 1 < defs.length && defs[endIndex + 1]?.hMerged) endIndex++;
        const left = centers[k];
        const right = centers[endIndex + 1];
        let span = 1;
        if (left !== undefined && right !== undefined && sorted.length > 1) {
          const a = sorted.indexOf(left);
          const b = sorted.indexOf(right);
          if (a >= 0 && b > a) span = b - a;
        }
        const width = left !== undefined && right !== undefined ? right - left : def?.width ?? 1000;
        const tcPr: string[] = [`<w:tcW w:w="${Math.max(0, width)}" w:type="dxa"/>`];
        if (span > 1) tcPr.push(`<w:gridSpan w:val="${span}"/>`);
        if (def?.vMerge === "restart") tcPr.push('<w:vMerge w:val="restart"/>');
        else if (def?.vMerge === "continue") tcPr.push("<w:vMerge/>");
        if (def && (def.borders.top || def.borders.left || def.borders.bottom || def.borders.right)) {
          tcPr.push(`<w:tcBorders>${this.border("top", def.borders.top)}${this.border("left", def.borders.left)}${this.border("bottom", def.borders.bottom)}${this.border("right", def.borders.right)}</w:tcBorders>`);
        }
        if (def?.shading) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${def.shading}"/>`);
        if (def && def.vAlign !== "top") tcPr.push(`<w:vAlign w:val="${def.vAlign}"/>`);
        const content: DocBlock[] = [];
        for (let m = k; m <= endIndex; m++) content.push(...(row.cells[m] ?? []));
        const body = this.blocks(content.length ? content : [{ type: "p", props: {}, markProps: {}, inlines: [] }], part);
        cellsXml.push(`<w:tc><w:tcPr>${tcPr.join("")}</w:tcPr>${body.endsWith("</w:p>") ? body : body + "<w:p/>"}</w:tc>`);
        k = endIndex + 1;
      }
      const trPr: string[] = [];
      if (row.props.cantSplit) trPr.push("<w:cantSplit/>");
      if (row.props.heightTwips) trPr.push(`<w:trHeight w:val="${row.props.heightTwips}" w:hRule="${row.props.exactHeight ? "exact" : "atLeast"}"/>`);
      if (row.props.header) trPr.push("<w:tblHeader/>");
      return `<w:tr>${trPr.length ? `<w:trPr>${trPr.join("")}</w:trPr>` : ""}${cellsXml.join("")}</w:tr>`;
    });
    const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/>${jc && jc !== "left" ? `<w:jc w:val="${jc}"/>` : ""}${!jc || jc === "left" ? `<w:tblInd w:w="${indent}" w:type="dxa"/>` : ""}${tblBorders}<w:tblLayout w:type="fixed"/>${cellMar}<w:tblLook w:val="0000"/></w:tblPr>`;
    const tblGrid = `<w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
    return `<w:tbl>${tblPr}${tblGrid}${rows.join("")}</w:tbl>`;
  }

  blocks(blocks: DocBlock[], part: Part, sectPrFor?: (s: number) => string): string {
    return blocks
      .map((b) => (b.type === "p" ? this.paragraph(b, part, b.sectionEnd !== undefined && sectPrFor ? sectPrFor(b.sectionEnd) : "") : this.table(b, part)))
      .join("");
  }

  sectPr(s: SectProps, refs: string): string {
    const w = s.landscape && s.pageWidth < s.pageHeight ? s.pageHeight : s.pageWidth;
    const h = s.landscape && s.pageWidth < s.pageHeight ? s.pageWidth : s.pageHeight;
    const grid = s.gridType && s.gridType !== "default"
      ? `<w:docGrid w:type="${s.gridType}"${s.linePitch ? ` w:linePitch="${s.linePitch}"` : ""}${s.charSpace && (s.gridType === "linesAndChars" || s.gridType === "snapToChars") ? ` w:charSpace="${s.charSpace}"` : ""}/>`
      : s.linePitch
        ? `<w:docGrid w:linePitch="${s.linePitch}"/>`
        : "";
    return `<w:sectPr>${refs}${s.breakType !== "nextPage" ? `<w:type w:val="${s.breakType}"/>` : ""}<w:pgSz w:w="${w}" w:h="${h}"${s.landscape ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${s.marginTop}" w:right="${s.marginRight}" w:bottom="${s.marginBottom}" w:left="${s.marginLeft}" w:header="${s.headerDist}" w:footer="${s.footerDist}" w:gutter="0"/>${s.columns > 1 ? `<w:cols w:num="${s.columns}" w:space="${s.columnSpace}"/>` : '<w:cols w:space="425"/>'}${s.titlePage ? "<w:titlePg/>" : ""}${s.vertical ? '<w:textDirection w:val="tbRl"/>' : ""}${grid}</w:sectPr>`;
  }

  stylesXml(): string {
    const df = this.m.defaultFonts;
    const fa = esc(this.m.fonts[df.ascii] ?? "Century");
    const fe = esc(this.m.fonts[df.eastAsia] ?? "ＭＳ 明朝");
    const fo = esc(this.m.fonts[df.other] ?? this.m.fonts[df.ascii] ?? "Century");
    const parts: string[] = [];
    for (const s of this.m.styles) {
      if (s.type !== "paragraph" && s.type !== "character") continue;
      const id = this.styleIds.get(s.istd)!;
      if (id === "DefaultParagraphFont") continue;
      const name = s.sti === 0 ? "Normal" : s.sti >= 1 && s.sti <= 9 ? `heading ${s.sti}` : s.name;
      const based = s.basedOn !== null ? this.styleIds.get(s.basedOn) : undefined;
      const next = s.next !== null && s.next !== s.istd ? this.styleIds.get(s.next) : undefined;
      const ppr = s.type === "paragraph" ? this.pPrInner({ ...s.para, istd: undefined }, false) : "";
      const rpr = this.rPr({ ...s.char, charStyle: undefined }, { skipStyle: true });
      parts.push(
        `<w:style w:type="${s.type}"${s.sti === 0 ? ' w:default="1"' : ""} w:styleId="${id}"><w:name w:val="${esc(name)}"/>${based && based !== "DefaultParagraphFont" ? `<w:basedOn w:val="${based}"/>` : ""}${next && s.type === "paragraph" ? `<w:next w:val="${next}"/>` : ""}<w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${rpr}</w:style>`
      );
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${fa}" w:hAnsi="${fo}" w:eastAsia="${fe}" w:cs="${fo}"/><w:kern w:val="2"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>${parts.join("")}</w:styles>`;
  }

  numberingXml(): string | null {
    if (!this.m.lists.length || !this.m.lfoToList.length) return null;
    const abstracts = this.m.lists.map((l, i) => {
      const lvls = l.levels.map((lv, k) => {
        const ppr = this.pPrInner({ ...lv.para, istd: undefined }, false);
        const rpr = this.rPr({ ...lv.char, charStyle: undefined }, { skipStyle: true });
        return `<w:lvl w:ilvl="${k}"><w:start w:val="${lv.start}"/><w:numFmt w:val="${NUM_FMT[lv.nfc] ?? "decimal"}"/><w:suff w:val="${lv.follow}"/><w:lvlText w:val="${esc(lv.text)}"/><w:lvlJc w:val="${lv.jc}"/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${rpr}</w:lvl>`;
      });
      return `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="${l.levels.length > 1 ? "multilevel" : "singleLevel"}"/>${lvls.join("")}</w:abstractNum>`;
    });
    const nums = this.m.lfoToList
      .map((li, i) => (li >= 0 ? `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${li}"/></w:num>` : ""))
      .join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${NS}>${abstracts.join("")}${nums}</w:numbering>`;
  }
}

function relsXml(rels: { id: string; type: string; target: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`).join("")}</Relationships>`;
}

/** XMLの開きタグと閉じタグの対応を確かめる（書き出したファイルが壊れていないかの確認用。DOMに依存しない） */
export function isWellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else if (!m[3]) stack.push(m[2]);
  }
  return stack.length === 0;
}

function blockText(blocks: DocBlock[]): string {
  return blocks
    .map((b) =>
      b.type === "p"
        ? b.inlines.map((i) => (i.kind === "text" ? i.text : i.kind === "field" ? i.result : "")).join("")
        : b.rows.map((r) => r.cells.map((c) => blockText(c)).join("")).join("")
    )
    .join("");
}

function countBlocks(blocks: DocBlock[]): { paragraphs: number; tables: number } {
  let paragraphs = 0;
  let tables = 0;
  for (const b of blocks) {
    if (b.type === "p") paragraphs++;
    else {
      tables++;
      for (const r of b.rows) for (const c of r.cells) {
        const n = countBlocks(c);
        paragraphs += n.paragraphs;
        tables += n.tables;
      }
    }
  }
  return { paragraphs, tables };
}

export function convertDocToDocx(bytes: Uint8Array): DocToDocxOutput {
  const m = readDoc(bytes);
  const w = new Writer(m);
  const files: Record<string, Uint8Array> = {};
  const docPart = new Part();
  const docRels: { id: string; type: string; target: string }[] = [];
  const overrides: string[] = [];

  // ヘッダー・フッター
  let hfCount = 0;
  const hfRefs: string[] = m.sections.map(() => "");
  const hfCache = new Map<unknown, string>();
  m.headers.forEach((hf, si) => {
    const refs: string[] = [];
    for (const kind of ["header", "footer"] as const) {
      for (const type of ["even", "default", "first"] as const) {
        const blocks = hf[kind][type];
        if (!blocks) continue;
        const cacheKey = JSON.stringify(blocks);
        let rid = hfCache.get(cacheKey);
        if (!rid) {
          hfCount++;
          const part = new Part();
          const name = `${kind}${hfCount}.xml`;
          const body = w.blocks(blocks, part) || "<w:p/>";
          const tag = kind === "header" ? "hdr" : "ftr";
          files[`word/${name}`] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:${tag} ${NS}>${body.endsWith("</w:p>") ? body : body + "<w:p/>"}</w:${tag}>`);
          if (part.rels.length) files[`word/_rels/${name}.rels`] = strToU8(relsXml(part.rels));
          rid = `rIdHf${hfCount}`;
          docRels.push({ id: rid, type: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`, target: name });
          overrides.push(`<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
          hfCache.set(cacheKey, rid);
        }
        if (type === "even" && !m.evenAndOddHeaders) continue;
        if (type === "first" && !m.sections[si].titlePage) continue;
        refs.push(`<w:${kind}Reference w:type="${type}" r:id="${rid}"/>`);
      }
    }
    hfRefs[si] = refs.join("");
  });

  const sectPrFor = (s: number) => w.sectPr(m.sections[s], hfRefs[s]);
  const bodyXml = w.blocks(m.body, docPart, sectPrFor);
  const lastSect = sectPrFor(m.sections.length - 1);
  const bodyStats = { ...w.stats };
  files["word/document.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${bodyXml}${lastSect}</w:body></w:document>`);

  // 脚注
  if (m.footnotes.size) {
    const part = new Part();
    const notes = [...m.footnotes.entries()].map(([id, blocks]) => `<w:footnote w:id="${id + 1}">${w.blocks(blocks, part) || "<w:p/>"}</w:footnote>`);
    files["word/footnotes.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${NS}><w:footnote w:type="separator" w:id="0"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="1"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes.join("")}</w:footnotes>`);
    if (part.rels.length) files["word/_rels/footnotes.xml.rels"] = strToU8(relsXml(part.rels));
    docRels.push({ id: "rIdFootnotes", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes", target: "footnotes.xml" });
    overrides.push('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>');
  }

  // 画像
  const usedMedia = new Set<string>();
  m.images.forEach((img, i) => {
    const name = `media/image${i + 1}.${img.ext}`;
    files[`word/${name}`] = img.bytes;
    usedMedia.add(img.ext);
  });

  files["word/styles.xml"] = strToU8(w.stylesXml());
  docRels.push({ id: "rIdStyles", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml" });
  const numbering = w.numberingXml();
  if (numbering) {
    files["word/numbering.xml"] = strToU8(numbering);
    docRels.push({ id: "rIdNumbering", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering", target: "numbering.xml" });
    overrides.push('<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>');
  }
  files["word/settings.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings ${NS}>${m.evenAndOddHeaders ? "<w:evenAndOddHeaders/>" : ""}<w:defaultTabStop w:val="840"/><w:characterSpacingControl w:val="compressPunctuation"/>${m.footnotes.size ? '<w:footnotePr><w:footnote w:id="0"/><w:footnote w:id="1"/></w:footnotePr>' : ""}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`);
  docRels.push({ id: "rIdSettings", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", target: "settings.xml" });
  files["word/_rels/document.xml.rels"] = strToU8(relsXml([...docRels, ...docPart.rels]));
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  const mediaTypes: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", emf: "image/x-emf", wmf: "image/x-wmf", bmp: "image/bmp" };
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...usedMedia].map((e) => `<Default Extension="${e}" ContentType="${mediaTypes[e]}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${overrides.join("")}</Types>`
  );
  const out = zipSync(files, { level: 6 });

  // 変換後の確認
  const checks: ConversionCheck[] = [];
  const source = countBlocks(m.body);
  const sourceText = blockText(m.body).replace(/\s+/g, "");
  try {
    const back = unzipSync(out);
    const xmlNames = Object.keys(back).filter((n) => n.endsWith(".xml") || n.endsWith(".rels"));
    const broken = xmlNames.filter((n) => !isWellFormedXml(strFromU8(back[n])));
    checks.push({ label: "書き出したファイルを開き直せること", ok: broken.length === 0, detail: broken.length ? `${broken.join("・")} が正しくありません` : undefined });
    const doc = strFromU8(back["word/document.xml"]);
    const text = [...doc.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((x) => x[1]).join("").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, "");
    checks.push({ label: `本文の文字（${sourceText.length.toLocaleString()}文字）`, ok: text === sourceText, detail: text === sourceText ? undefined : `書き出し後 ${text.length.toLocaleString()}文字` });
    const tables = (doc.match(/<w:tbl>/g) ?? []).length;
    checks.push({ label: `表（${source.tables}個）`, ok: tables === source.tables });
    const drawings = (doc.match(/<w:drawing>/g) ?? []).length;
    checks.push({ label: `本文の画像（${bodyStats.images}個）`, ok: drawings === bodyStats.images });
    checks.push({ label: `セクション（${m.sections.length}個）`, ok: (doc.match(/<w:sectPr>/g) ?? []).length === m.sections.length });
  } catch {
    checks.push({ label: "書き出したファイルを開き直せること", ok: false });
  }

  const warnings: string[] = [];
  const u = m.unsupported;
  const lost: string[] = [];
  if (u.floatingObjects) lost.push(`文字列の折り返しを設定した画像・図形・ワードアート${u.floatingObjects}個`);
  if (u.textBoxes) lost.push("テキストボックス");
  if (u.oleObjects) lost.push(`埋め込みオブジェクト（グラフ・数式・Excelの表など）${u.oleObjects}個`);
  if (u.unknownImages) lost.push(`対応していない形式の画像${u.unknownImages}個`);
  if (u.comments) lost.push("コメント");
  if (u.endnotes) lost.push("文末脚注");
  if (lost.length) warnings.push(`次のものは引き継げませんでした：${lost.join("・")}。必要な場合は、元の文書から貼り付け直してください。`);
  if (u.nestedTables) warnings.push(`表の中の表（${u.nestedTables}個）は、外側のセルの中の文章として入れました。`);
  if (u.revisions) warnings.push("変更履歴（削除された文字）は、削除を確定した状態にしました。");
  if (u.fields > 0) warnings.push("目次・相互参照などのフィールドは、表示されていた文字のまま入れました（ページ番号は、自動で変わるページ番号として入れています）。");
  warnings.push("文字の間隔・行の位置は、Wordの版や設定によって元の文書と少し違う場合があります。印刷の前に、ページの区切りをご確認ください。");

  return {
    blob: new Blob([out as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    summary: {
      paragraphs: source.paragraphs,
      tables: source.tables,
      images: m.images.length,
      sections: m.sections.length,
      footnotes: m.footnotes.size,
      headers: hfCount,
      characters: sourceText.length,
    },
    checks,
    warnings,
  };
}

export async function convertDocFile(file: File): Promise<DocToDocxOutput> {
  const ext = file.name.toLowerCase().split(".").pop();
  if (file.size === 0) throw new DocError("空のファイルは変換できません。");
  if (file.size > MAX_DOC_FILE_MB * 1024 * 1024) throw new DocError(`ファイルが大きすぎます（上限${MAX_DOC_FILE_MB}MB）。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) throw new DocError("このファイルは、すでに新しい形式（.docx）です。変換の必要はありません。");
  if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72) throw new DocError("このファイルはリッチテキスト形式（RTF）です。.doc形式のファイルを選択してください。");
  if (ext !== "doc") throw new DocError("Word旧形式のファイル（.doc）を選択してください。");
  return convertDocToDocx(bytes);
}
