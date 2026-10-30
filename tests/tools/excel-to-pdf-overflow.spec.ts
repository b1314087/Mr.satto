import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { zipSync, strToU8 } from "fflate";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Excel→PDF: 最後の列にある長い文字列は、右隣の空き列にはみ出して最後まで印刷される。
 * 以前は、値のある最後の列で文字が切れていた。
 * テスト用のxlsxは、このテストの中で最小の構成で作る（外部のファイルや実際のAPIは使わない）。
 */

const LONG = "OVERFLOW-TEXT-".repeat(4).trim(); // 約55文字: 2列ぶんの幅(約150pt)を大きく超える

function makeXlsx(): string {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="2" width="10" customWidth="1"/></cols><sheetData>` +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Note</t></is></c></row>` +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>First</t></is></c><c r="B2" t="inlineStr"><is><t>${LONG}</t></is></c></row>` +
        `</sheetData></worksheet>`
    ),
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xl-ovf-")), "overflow.xlsx");
  fs.writeFileSync(file, zipSync(files));
  return file;
}

/** PDFの1ページ目を72dpiのグレースケールにして、指定範囲(pt)の暗い画素の数を数える */
function darkPixels(pdf: string, x0: number, y0: number, x1: number, y1: number): number {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xl-px-")), "p");
  execFileSync("pdftoppm", ["-gray", "-r", "72", "-f", "1", "-l", "1", pdf, out]);
  const file = fs.readdirSync(path.dirname(out)).find((f) => f.endsWith(".pgm"))!;
  const buf = fs.readFileSync(path.join(path.dirname(out), file));
  const header = buf.toString("latin1", 0, 30).match(/^P5\s+(\d+)\s+(\d+)\s+255\s/)!;
  const w = Number(header[1]);
  const data = buf.subarray(header[0].length);
  let n = 0;
  for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) if (data[y * w + x] < 110) n++;
  return n;
}

test("最後の列の長い文字列が、右隣の空き列にはみ出して最後まで印刷される", async ({ page }) => {
  const xlsx = makeXlsx();
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, xlsx);
  const button = page.getByRole("button", { name: "PDFに変換する" });
  if (!(await button.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false))) {
    await page.reload();
    await uploadFixture(page, xlsx);
  }
  await button.click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xlpdf-"));
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);

  const txt = execFileSync("pdftotext", ["-layout", pdf, "-"]).toString().replace(/\s+/g, "");
  expect(txt).toContain(LONG.replace(/\s+/g, ""));
  // 2列ぶんの幅(約40+150pt)より右側にも、文字が描かれている(切れていない)
  expect(darkPixels(pdf, 250, 20, 560, 120), "はみ出した文字が右端で切れています").toBeGreaterThan(60);
});
