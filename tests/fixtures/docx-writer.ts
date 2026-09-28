import { zipSync, strToU8 } from "fflate";

/**
 * Phase 18.2 C節（word-to-pdf）テスト用の、最小限の手組みDOCX(OOXML/WordprocessingML)
 * 生成ヘルパー。
 *
 * word-to-pdfはmammoth（既存依存）でDOCX→HTML変換した後、pdf-libでPDF化する。
 * mammothを実際に通してテストするには本物のDOCX(ZIP化されたXML群)が必要だが、
 * 新しいDOCX生成ライブラリは追加しない（開発指示書J章）ため、Excel側の
 * xlsx-writer.tsと同じ方針で、fflateのみを使い、テストに必要な最小限の
 * 妥当なDOCXをテストコード側で直接組み立てる。
 *
 * 実在の人物・企業データは一切使用しない、テスト専用の架空データのみ。
 */

export interface DocxRunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type DocxParagraphSpec =
  | {
      kind: "paragraph";
      runs: DocxRunSpec[];
      heading?: 1 | 2 | 3;
      pageBreakBefore?: boolean;
      /** この段落をセクションの最後の段落にする(w:pPr内にw:sectPrを埋め込む)。
       *  複数セクション(用紙設定が異なる区切り)を持つDOCXフィクスチャの生成用。 */
      sectionEnd?: DocxSectionSpec;
    }
  /** 段落内に明示的な改ページ(w:br type="page")を含む段落 */
  | { kind: "pagebreak" }
  | { kind: "table"; rows: string[][] }
  | { kind: "image"; pngBase64: string; widthPt: number; heightPt: number };

export interface DocxSectionSpec {
  /** twips単位(1pt=20twips)。省略時はA4縦(w:w=11906,w:h=16838) */
  pageWidthTwips?: number;
  pageHeightTwips?: number;
  orientation?: "portrait" | "landscape";
  marginsTwips?: { top?: number; bottom?: number; left?: number; right?: number };
}

export interface DocxDocumentSpec {
  blocks: DocxParagraphSpec[];
  section?: DocxSectionSpec;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function runXml(run: DocxRunSpec): string {
  const props: string[] = [];
  if (run.bold) props.push("<w:b/>");
  if (run.italic) props.push("<w:i/>");
  if (run.underline) props.push('<w:u w:val="single"/>');
  const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
}

const HEADING_STYLE_ID: Record<number, string> = { 1: "Heading1", 2: "Heading2", 3: "Heading3" };

function paragraphXml(block: Extract<DocxParagraphSpec, { kind: "paragraph" }>): string {
  const pPrParts: string[] = [];
  if (block.heading) pPrParts.push(`<w:pStyle w:val="${HEADING_STYLE_ID[block.heading]}"/>`);
  if (block.pageBreakBefore) pPrParts.push("<w:pageBreakBefore/>");
  if (block.sectionEnd) pPrParts.push(sectPrXml(block.sectionEnd));
  const pPr = pPrParts.length > 0 ? `<w:pPr>${pPrParts.join("")}</w:pPr>` : "";
  const runs = block.runs.map(runXml).join("");
  return `<w:p>${pPr}${runs}</w:p>`;
}

/** w:br(type="page")を単独で含む段落(明示的な改ページ、C-9で言う「手動改ページ」) */
function pageBreakParagraphXml(): string {
  return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
}

function tableXml(rows: string[][]): string {
  const colCount = Math.max(1, ...rows.map((r) => r.length));
  const gridCols = Array.from({ length: colCount }, () => `<w:gridCol w:w="2000"/>`).join("");
  const rowsXml = rows
    .map((row) => {
      const cellsXml = Array.from({ length: colCount }, (_, c) => {
        const text = row[c] ?? "";
        return `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p></w:tc>`;
      }).join("");
      return `<w:tr>${cellsXml}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;
}

function imageXml(relId: string, widthPt: number, heightPt: number): string {
  // EMU(English Metric Units): 1pt = 12700 EMU
  const widthEmu = Math.round(widthPt * 12700);
  const heightEmu = Math.round(heightPt * 12700);
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
    <wp:docPr id="1" name="Picture 1"/>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr><pic:cNvPr id="1" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr>
            <a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          </pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline></w:drawing></w:r></w:p>`;
}

function sectPrXml(section?: DocxSectionSpec): string {
  const landscape = section?.orientation === "landscape";
  const defaultW = 11906;
  const defaultH = 16838;
  let w = section?.pageWidthTwips ?? defaultW;
  let h = section?.pageHeightTwips ?? defaultH;
  if (landscape && w < h) {
    const tmp = w;
    w = h;
    h = tmp;
  }
  const margins = section?.marginsTwips ?? {};
  const orientAttr = section?.orientation ? ` w:orient="${section.orientation}"` : "";
  return `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"${orientAttr}/><w:pgMar w:top="${margins.top ?? 1417}" w:right="${
    margins.right ?? 1417
  }" w:bottom="${margins.bottom ?? 1417}" w:left="${margins.left ?? 1417}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
}

/** 複数セクション(用紙設定が変わる区切り)を持つDOCXを組み立てる場合、
 *  各セクションの最後の段落にw:sectPrを埋め込み、最後のセクションだけ
 *  本文直下(段落の外)にw:sectPrを置く(OOXMLの仕様どおり)。 */
export function buildMinimalDocx(spec: DocxDocumentSpec): Uint8Array {
  let imageCounter = 0;
  const imageFiles: Record<string, Uint8Array> = {};
  const imageRels: string[] = [];

  const bodyParts: string[] = [];
  for (const block of spec.blocks) {
    if (block.kind === "paragraph") {
      bodyParts.push(paragraphXml(block));
    } else if (block.kind === "pagebreak") {
      bodyParts.push(pageBreakParagraphXml());
    } else if (block.kind === "table") {
      bodyParts.push(tableXml(block.rows));
    } else if (block.kind === "image") {
      imageCounter += 1;
      const relId = `rIdImg${imageCounter}`;
      imageFiles[`word/media/image${imageCounter}.png`] = Uint8Array.from(atob(block.pngBase64), (c) => c.charCodeAt(0));
      imageRels.push(
        `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${imageCounter}.png"/>`
      );
      bodyParts.push(imageXml(relId, block.widthPt, block.heightPt));
    }
  }
  bodyParts.push(sectPrXml(spec.section));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${bodyParts.join("")}</w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${imageRels.join("\n")}
</Relationships>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(rootRelsXml),
    "word/document.xml": strToU8(documentXml),
    ...imageFiles,
  };
  if (imageRels.length > 0) {
    files["word/_rels/document.xml.rels"] = strToU8(documentRelsXml);
  }

  return zipSync(files);
}
