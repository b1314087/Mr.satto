import { strToU8, zipSync } from "fflate";

/**
 * 書式つきのExcelファイル（.xlsx）を組み立てる（Word→Excel変換用）。
 * 既存の write-excel-file は、セルの一部だけの書式（リッチテキスト）・画像を書けないため、OOXMLを直接書く（新しいライブラリは追加しない）。
 */
export interface XFont {
  name?: string | null;
  sizePt?: number | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** RRGGBB（#なし） */
  color?: string | null;
  vertAlign?: "superscript" | "subscript" | null;
}

export type XBorderStyle = "hair" | "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
export interface XBorderSide {
  style: XBorderStyle;
  color?: string | null;
}

export interface XStyle {
  font?: XFont;
  /** 背景色 RRGGBB */
  fill?: string | null;
  border?: { top?: XBorderSide | null; bottom?: XBorderSide | null; left?: XBorderSide | null; right?: XBorderSide | null };
  hAlign?: "left" | "center" | "right" | "justify" | null;
  vAlign?: "top" | "center" | "bottom" | null;
  wrap?: boolean;
  /** 表示形式（例: "#,##0"・"yyyy/m/d"・"@"） */
  numFmt?: string | null;
  indent?: number;
}

export interface XCell {
  v: string | number | boolean | Date | null;
  /** 一部の文字だけ書式が違うときの、文字の区切り（v は全体の文字列） */
  rich?: { text: string; font: XFont }[] | null;
  style?: XStyle | null;
}

export interface XImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg" | "image/gif";
  /** 0始まりのセル位置（画像の左上） */
  row: number;
  col: number;
  widthPx: number;
  heightPx: number;
}

export interface XSheet {
  name: string;
  rows: (XCell | null)[][];
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  /** 列の幅（Excelの文字数の単位）。null は既定 */
  colWidths: (number | null)[];
  /** 行の高さ（pt）。custom = 固定の高さ（文字に合わせて広がらない） */
  rowHeights: Map<number, { pt: number; custom: boolean }>;
  images: XImage[];
}

const EMU_PER_PX = 9525;

function esc(text: string): string {
  return text
    // XMLで使えない制御文字は除く（タブ・改行は残す）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function colName(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** pt → Excelの列の幅（標準のフォントの数字の幅＝7px を1とする単位） */
export function ptToColumnWidth(pt: number): number {
  const px = (pt * 96) / 72;
  return Math.max(1, Math.round(((px - 5) / 7) * 100) / 100);
}

/** 日付 → Excelの日付の通し番号（1900年基準。UTCの年月日・時刻で数える） */
export function dateToSerial(d: Date): number {
  return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function fontXml(f: XFont | undefined, tag: "font" | "rPr"): string {
  const parts: string[] = [];
  if (f?.bold) parts.push("<b/>");
  if (f?.italic) parts.push("<i/>");
  if (f?.strike) parts.push("<strike/>");
  if (f?.underline) parts.push('<u/>');
  if (f?.vertAlign) parts.push(`<vertAlign val="${f.vertAlign}"/>`);
  parts.push(`<sz val="${f?.sizePt ? Math.round(f.sizePt * 2) / 2 : 11}"/>`);
  parts.push(f?.color ? `<color rgb="FF${f.color.toUpperCase()}"/>` : '<color theme="1"/>');
  const name = esc(f?.name || "游ゴシック");
  parts.push(tag === "font" ? `<name val="${name}"/>` : `<rFont val="${name}"/>`);
  parts.push('<family val="3"/><charset val="128"/>');
  return `<${tag}>${parts.join("")}</${tag}>`;
}

function borderXml(b: XStyle["border"]): string {
  const side = (tag: string, s: XBorderSide | null | undefined) =>
    s ? `<${tag} style="${s.style}"><color rgb="FF${(s.color ?? "000000").toUpperCase()}"/></${tag}>` : `<${tag}/>`;
  return `<border>${side("left", b?.left)}${side("right", b?.right)}${side("top", b?.top)}${side("bottom", b?.bottom)}<diagonal/></border>`;
}

class StyleBook {
  fonts: string[] = [fontXml(undefined, "font")];
  fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  borders: string[] = ["<border><left/><right/><top/><bottom/><diagonal/></border>"];
  numFmts: string[] = [];
  xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  private xfIndex = new Map<string, number>();

  private idx(list: string[], xml: string): number {
    const i = list.indexOf(xml);
    if (i >= 0) return i;
    list.push(xml);
    return list.length - 1;
  }

  styleId(s: XStyle | null | undefined): number {
    if (!s) return 0;
    const fontId = this.idx(this.fonts, fontXml(s.font, "font"));
    const fillId = s.fill ? this.idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill.toUpperCase()}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const borderId = s.border ? this.idx(this.borders, borderXml(s.border)) : 0;
    let numFmtId = 0;
    if (s.numFmt === "@") numFmtId = 49;
    else if (s.numFmt) numFmtId = 164 + this.idx(this.numFmts, s.numFmt);
    const align =
      s.hAlign || s.vAlign || s.wrap || s.indent
        ? `<alignment${s.hAlign ? ` horizontal="${s.hAlign}"` : ""}${s.vAlign ? ` vertical="${s.vAlign}"` : ""}${s.wrap ? ' wrapText="1"' : ""}${s.indent ? ` indent="${s.indent}"` : ""}/>`
        : "";
    const xf = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""} applyFont="1"${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${align ? ' applyAlignment="1">' + align + "</xf>" : "/>"}`;
    const k = xf;
    const found = this.xfIndex.get(k);
    if (found !== undefined) return found;
    this.xfs.push(xf);
    this.xfIndex.set(k, this.xfs.length - 1);
    return this.xfs.length - 1;
  }

  xml(): string {
    const numFmts = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join("")}</numFmts>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmts}<fonts count="${this.fonts.length}">${this.fonts.join("")}</fonts><fills count="${this.fills.length}">${this.fills.join("")}</fills><borders count="${this.borders.length}">${this.borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${this.xfs.length}">${this.xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  }
}

export function writeXlsx(sheets: XSheet[]): Uint8Array {
  const styles = new StyleBook();
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sst = (xml: string) => {
    const f = stringIndex.get(xml);
    if (f !== undefined) return f;
    strings.push(xml);
    stringIndex.set(xml, strings.length - 1);
    return strings.length - 1;
  };
  const files: Record<string, Uint8Array> = {};
  const contentOverrides: string[] = [];
  const mediaExt = new Set<string>();
  let imageCounter = 0;

  sheets.forEach((sheet, si) => {
    const n = si + 1;
    const rowsXml: string[] = [];
    const maxRow = sheet.rows.length;
    for (let r = 0; r < maxRow; r++) {
      const row = sheet.rows[r] ?? [];
      const h = sheet.rowHeights.get(r);
      const cells: string[] = [];
      row.forEach((cell, c) => {
        if (!cell) return;
        const ref = `${colName(c)}${r + 1}`;
        const s = styles.styleId(cell.style);
        const sAttr = s ? ` s="${s}"` : "";
        const v = cell.v;
        if (v === null || v === "") {
          if (s) cells.push(`<c r="${ref}"${sAttr}/>`);
        } else if (typeof v === "number" && Number.isFinite(v)) {
          cells.push(`<c r="${ref}"${sAttr}><v>${v}</v></c>`);
        } else if (v instanceof Date) {
          cells.push(`<c r="${ref}"${sAttr}><v>${dateToSerial(v)}</v></c>`);
        } else if (typeof v === "boolean") {
          cells.push(`<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`);
        } else {
          const text = String(v);
          const xml =
            cell.rich && cell.rich.length > 1
              ? cell.rich.map((run) => `<r>${fontXml(run.font, "rPr")}<t xml:space="preserve">${esc(run.text)}</t></r>`).join("")
              : `<t xml:space="preserve">${esc(text)}</t>`;
          cells.push(`<c r="${ref}"${sAttr} t="s"><v>${sst(xml)}</v></c>`);
        }
      });
      if (cells.length > 0 || h) {
        rowsXml.push(`<row r="${r + 1}"${h ? ` ht="${Math.round(h.pt * 100) / 100}"${h.custom ? ' customHeight="1"' : ""}` : ""}>${cells.join("")}</row>`);
      }
    }
    const cols = sheet.colWidths
      .map((w, c) => (w ? `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>` : ""))
      .filter(Boolean)
      .join("");
    const merges = sheet.merges.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${colName(m.c1)}${m.r1 + 1}:${colName(m.c2)}${m.r2 + 1}"/>`).join("")}</mergeCells>`
      : "";
    let drawing = "";
    if (sheet.images.length > 0) {
      const anchors: string[] = [];
      const rels: string[] = [];
      sheet.images.forEach((img, i) => {
        imageCounter++;
        const ext = img.mime === "image/png" ? "png" : img.mime === "image/gif" ? "gif" : "jpeg";
        mediaExt.add(ext);
        const media = `image${imageCounter}.${ext}`;
        files[`xl/media/${media}`] = img.bytes;
        rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${media}"/>`);
        anchors.push(
          `<xdr:oneCellAnchor><xdr:from><xdr:col>${img.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${img.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${Math.round(img.widthPx * EMU_PER_PX)}" cy="${Math.round(img.heightPx * EMU_PER_PX)}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="画像 ${i + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(img.widthPx * EMU_PER_PX)}" cy="${Math.round(img.heightPx * EMU_PER_PX)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`
        );
      });
      files[`xl/drawings/drawing${n}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join("")}</xdr:wsDr>`
      );
      files[`xl/drawings/_rels/drawing${n}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`
      );
      files[`xl/worksheets/_rels/sheet${n}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`
      );
      contentOverrides.push(`<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      drawing = '<drawing r:id="rId1"/>';
    }
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ""}/></sheetViews><sheetFormatPr defaultRowHeight="18.75"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rowsXml.join("")}</sheetData>${merges}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait"/>${drawing}</worksheet>`
    );
    contentOverrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });

  files["xl/sharedStrings.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((x) => `<si>${x}</si>`).join("")}</sst>`
  );
  files["xl/styles.xml"] = strToU8(styles.xml());
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
  );
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  const mediaDefaults = [...mediaExt].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("");
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>${contentOverrides.join("")}</Types>`
  );
  return zipSync(files, { level: 6 });
}

/** Excelのシート名の決まり（31文字まで・使えない文字 \ / ? * [ ] : ・先頭と末尾の ' ・重複なし）に合わせる */
export function safeSheetName(raw: string, used: Set<string>, fallback: string): string {
  let name = raw.replace(/[\\/?*[\]:]/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "");
  if (!name || name.toLowerCase() === "history") name = fallback;
  name = Array.from(name).slice(0, 31).join("");
  let candidate = name;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const suffix = `（${i}）`;
    candidate = Array.from(name).slice(0, 31 - suffix.length).join("") + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}
