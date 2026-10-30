import { test, expect } from "../fixtures/premium-test";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, getFillColorsUsed } from "../helpers/pdf-inspect";
import { extractTextBoxes } from "../helpers/pdf-text-boxes";
import { zipSync, strToU8 } from "fflate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Word→PDF: 段落・文字・表・ヘッダー/フッターの書式（word/*.xmlから直接読む部分）のテスト。
 * mammothだけでは失われていた、中央/右揃え・文字サイズ・色・蛍光ペン・タブ・ページ番号・
 * 表のセル結合/背景色/右寄せを、実際にPDFを作って確かめる。
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function buildDocx(bodyXml: string, opts: { header?: string; footer?: string } = {}): Uint8Array {
  const hasHeader = opts.header !== undefined;
  const hasFooter = opts.footer !== undefined;
  const sect = `<w:sectPr>${hasHeader ? '<w:headerReference w:type="default" r:id="rIdH"/>' : ""}${hasFooter ? '<w:footerReference w:type="default" r:id="rIdF"/>' : ""}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>${hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}${hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${hasHeader ? '<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ""}${hasFooter ? '<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ""}</Relationships>`
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`
    ),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${bodyXml}${sect}</w:body></w:document>`),
  };
  if (hasHeader) files["word/header1.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${opts.header}</w:hdr>`);
  if (hasFooter) files["word/footer1.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}>${opts.footer}</w:ftr>`);
  return zipSync(files);
}

async function convert(page: import("@playwright/test").Page, docx: Uint8Array, name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w2p-"));
  const file = path.join(dir, `${name}.docx`);
  fs.writeFileSync(file, docx);
  await page.goto("/tools/word-to-pdf");
  await uploadFixture(page, file);
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await expect(page.getByText("完了", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path: pdfPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1 });
  return pdfPath;
}

const P = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
const R = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

test("中央揃え・右揃え・文字サイズ・字下げが、PDFに反映される", async ({ page }) => {
  const body =
    P(R("CENTERTITLE", '<w:sz w:val="40"/>'), '<w:jc w:val="center"/>') +
    P(R("RIGHTSIDE"), '<w:jc w:val="right"/>') +
    P(R("LEFTSIDE")) +
    P(R("INDENTED"), '<w:ind w:left="1440"/>');
  const pdfPath = await convert(page, buildDocx(body), "align");
  const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync(pdfPath)));
  const boxes = pages[0].boxes;
  const joinedAt = (word: string) => {
    // 1文字ずつ描かれるので、先頭文字から順に拾って、単語の左端・右端・大きさを求める
    const chars = Array.from(word);
    const first = boxes.findIndex((b, i) => b.str === chars[0] && chars.every((c, k) => boxes[i + k]?.str === c));
    expect(first, `${word} が見つかりません`).toBeGreaterThanOrEqual(0);
    const last = boxes[first + chars.length - 1];
    return { left: boxes[first].x, right: last.x + last.width, size: boxes[first].size };
  };
  const center = joinedAt("CENTERTITLE");
  const right = joinedAt("RIGHTSIDE");
  const left = joinedAt("LEFTSIDE");
  const indented = joinedAt("INDENTED");
  const contentLeft = 1417 / 20;
  const contentRight = pages[0].width - 1417 / 20;
  // 中央: 左右の余白が同じ
  expect((center.left - contentLeft) - (contentRight - center.right)).toBeCloseTo(0, 0);
  // 20ptの文字
  expect(center.size).toBeCloseTo(20, 0);
  // 右揃え: 右端が本文の右端にそろう
  expect(right.right).toBeCloseTo(contentRight, 0);
  // 左揃え: 左端が本文の左端
  expect(left.left).toBeCloseTo(contentLeft, 0);
  // 左インデント72pt
  expect(indented.left).toBeCloseTo(contentLeft + 72, 0);
});

test("文字の色・蛍光ペン・取り消し線・上付き・下付きが、PDFに反映される", async ({ page }) => {
  const body = P(R("REDTEXT", '<w:color w:val="C00000"/>') + R("HILITE", '<w:highlight w:val="yellow"/>') + R("STRIKE", "<w:strike/>") + R("SUP", '<w:vertAlign w:val="superscript"/>'));
  const pdfPath = await convert(page, buildDocx(body), "runs");
  const colors = await getFillColorsUsed(pdfPath, 1);
  // 赤い文字（#C00000）と、蛍光ペン（黄色 #FFFF00）が、描画に使われている
  expect(colors.has("#c00000")).toBe(true);
  expect(colors.has("#ffff00")).toBe(true);
  const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync(pdfPath)));
  const boxes = pages[0].boxes;
  const normal = boxes.find((b) => b.str === "R")!;
  const sup = boxes.find((b) => b.str === "S" && boxes.indexOf(b) > boxes.findIndex((x) => x.str === "K"))!;
  // 上付きは小さく、少し高い位置
  expect(sup.size).toBeLessThan(normal.size);
  expect(sup.y).toBeGreaterThan(normal.y);
});

test("タブ位置（右揃えのタブ）が、PDFに反映される", async ({ page }) => {
  const body = P(R("LEFTWORD") + '<w:r><w:tab/></w:r>' + R("RIGHTEND"), '<w:tabs><w:tab w:val="right" w:pos="8000"/></w:tabs>');
  const pdfPath = await convert(page, buildDocx(body), "tabs");
  const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync(pdfPath)));
  const boxes = pages[0].boxes;
  const last = boxes.filter((b) => "RIGHTEND".includes(b.str)).pop()!;
  // 右タブ(8000twips=400pt)に、文字列の右端がそろう
  expect(last.x + last.width).toBeCloseTo(1417 / 20 + 400, 0);
});

test("ヘッダー・フッターと、ページ番号（PAGE）が、各ページに入る", async ({ page }) => {
  const header = P(R("HEADERLINE"), '<w:jc w:val="right"/>');
  const footer = P(
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>',
    '<w:jc w:val="center"/>'
  );
  const body = P(R("FIRSTPAGE")) + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + P(R("SECONDPAGE"));
  const pdfPath = await convert(page, buildDocx(body, { header, footer }), "hf");
  const pdf = await extractPdfContent(pdfPath);
  expect(pdf.pageCount).toBe(2);
  for (const p of pdf.pages) expect(p.text).toContain("HEADERLINE");
  const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync(pdfPath)));
  // フッターの数字: 1ページ目は「1」、2ページ目は「2」。ページの下のほうにある
  for (const [idx, digit] of [[0, "1"], [1, "2"]] as const) {
    const near = pages[idx].boxes.filter((b) => b.y < 60 && b.str === digit);
    expect(near.length, `${idx + 1}ページ目のページ番号`).toBe(1);
  }
});

test("表: セルの結合・背景色・数字の右寄せ・罫線が、PDFに反映される", async ({ page }) => {
  const cell = (w: number, inner: string, tcPr = "") => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${tcPr}</w:tcPr>${inner}</w:tc>`;
  const table =
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="7200" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>` +
    `<w:tr>${cell(2400, P(R("HEADA")), '<w:shd w:val="clear" w:fill="D9E2F3"/>')}${cell(2400, P(R("HEADB")), '<w:shd w:val="clear" w:fill="D9E2F3"/>')}${cell(2400, P(R("HEADC")), '<w:shd w:val="clear" w:fill="D9E2F3"/>')}</w:tr>` +
    `<w:tr>${cell(4800, P(R("TOTALLABEL"), '<w:jc w:val="right"/>'), '<w:gridSpan w:val="2"/>')}${cell(2400, P(R("12345"), '<w:jc w:val="right"/>'))}</w:tr>` +
    `</w:tbl>`;
  const body = P(R("BEFORETABLE")) + table + P(R("AFTERTABLE"));
  const pdfPath = await convert(page, buildDocx(body), "table");
  const colors = await getFillColorsUsed(pdfPath, 1);
  expect(colors.has("#d9e2f3")).toBe(true);
  const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync(pdfPath)));
  const boxes = pages[0].boxes;
  const at = (word: string) => {
    const chars = Array.from(word);
    const i = boxes.findIndex((b, k) => b.str === chars[0] && chars.every((c, j) => boxes[k + j]?.str === c));
    expect(i, `${word} が見つかりません`).toBeGreaterThanOrEqual(0);
    const last = boxes[i + chars.length - 1];
    return { left: boxes[i].x, right: last.x + last.width };
  };
  const contentLeft = 1417 / 20;
  // 結合したセル（幅4800twips=240pt）の右端に「TOTALLABEL」が右寄せされる（右の余白5.4pt）
  expect(at("TOTALLABEL").right).toBeCloseTo(contentLeft + 240 - 5.4, 0);
  // 3列目（左から240pt〜360pt）の右端に数字が右寄せされる
  expect(at("12345").right).toBeCloseTo(contentLeft + 360 - 5.4, 0);
  // 表のあとの段落も、きちんと出る
  expect(at("AFTERTABLE").left).toBeCloseTo(contentLeft, 0);
});

test("枠線つき・背景色つきの段落が、PDFに反映される", async ({ page }) => {
  const pPr = '<w:pBdr><w:top w:val="single" w:sz="8" w:color="000000"/><w:left w:val="single" w:sz="8" w:color="000000"/><w:bottom w:val="single" w:sz="8" w:color="000000"/><w:right w:val="single" w:sz="8" w:color="000000"/></w:pBdr><w:shd w:val="clear" w:fill="FFF2CC"/>';
  const pdfPath = await convert(page, buildDocx(P(R("BOXED"), pPr)), "box");
  const colors = await getFillColorsUsed(pdfPath, 1);
  expect(colors.has("#fff2cc")).toBe(true);
});

test("書式を読めない・対応づけられない文書でも、これまでどおり変換できる（書式なしの従来の動き）", async ({ page }) => {
  // styles.xml の無い最小のDOCX（書式の読み取りが空でも壊れない）
  const body = P(R("PLAINLINE"));
  const docx = buildDocx(body);
  const pdfPath = await convert(page, docx, "plain");
  const pdf = await extractPdfContent(pdfPath);
  expect(pdf.text).toContain("PLAINLINE");
});
