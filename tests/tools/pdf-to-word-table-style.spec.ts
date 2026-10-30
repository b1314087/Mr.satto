import { test, expect } from "../fixtures/premium-test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readDocxPart } from "../helpers/docx-inspect";

/**
 * PDF→Word: 罫線のある表の、列の幅・数字の右寄せ・見出しの背景色・結合したセル、
 * 文字の蛍光ペン（背景色）、途中で終わるページの改ページを確かめる。
 */

const COLS = [60, 150, 250, 350, 450]; // 罫線のx座標（4列）
const ROW_H = 20;

async function makePdf(): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([520, 600]);
  const size = 10;
  page.drawText("Invoice list", { x: 60, y: 560, size: 16, font });
  // 蛍光ペン（黄色）: 文の途中の「MARKED」だけに黄色の背景
  const lead = "Please read ";
  const marked = "MARKED";
  const leadW = font.widthOfTextAtSize(lead, 10);
  const markedW = font.widthOfTextAtSize(marked, 10);
  page.drawRectangle({ x: 60 + leadW - 1, y: 530, width: markedW + 2, height: 14, color: rgb(1, 1, 0) });
  page.drawText(lead, { x: 60, y: 534, size: 10, font });
  page.drawText(marked, { x: 60 + leadW, y: 534, size: 10, font });
  page.drawText(" words carefully today.", { x: 60 + leadW + markedW, y: 534, size: 10, font });

  const rows = [
    ["Name", "Unit", "Qty", "Amount"],
    ["Design", "100,000", "2", "200,000"],
    ["Develop", "150,000", "3", "450,000"],
  ];
  const top = 480;
  // 見出し行の背景
  page.drawRectangle({ x: COLS[0], y: top - ROW_H, width: COLS[4] - COLS[0], height: ROW_H, color: rgb(0.85, 0.89, 0.95) });
  rows.forEach((row, r) => {
    const y = top - r * ROW_H - 14;
    row.forEach((text, c) => {
      const w = font.widthOfTextAtSize(text, size);
      // 数字の列（2〜4列目）は右揃え。罫線との余白は約3pt
      const x = c === 0 ? COLS[0] + 3 : COLS[c + 1] - 3 - w;
      page.drawText(text, { x, y, size, font });
    });
  });
  // 合計の行: 左の3列を1つのセルにまとめ（縦の罫線を引かない）、右寄せの「Total」を入れる
  const totalY = top - rows.length * ROW_H - 14;
  const totalW = font.widthOfTextAtSize("Total", size);
  page.drawText("Total", { x: COLS[3] - 3 - totalW, y: totalY, size, font });
  const amountW = font.widthOfTextAtSize("650,000", size);
  page.drawText("650,000", { x: COLS[4] - 3 - amountW, y: totalY, size, font });

  const bottom = top - (rows.length + 1) * ROW_H;
  const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.6, color: rgb(0, 0, 0) });
  for (let r = 0; r <= rows.length + 1; r++) line(COLS[0], top - r * ROW_H, COLS[4], top - r * ROW_H);
  for (const x of [COLS[0], COLS[4]]) line(x, top, x, bottom);
  // 内側の縦の罫線: 見出し〜明細の行（0〜3行目）は全部引き、合計の行（4行目）では、最後の列の手前だけ引く
  for (const x of [COLS[1], COLS[2]]) line(x, top, x, top - rows.length * ROW_H);
  line(COLS[3], top, COLS[3], bottom);

  // ページの途中で終わる1ページ目（この下は大きく空いている）→ 2ページ目
  const page2 = doc.addPage([520, 600]);
  page2.drawText("Second page body", { x: 60, y: 540, size: 11, font });

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p2w-")), "table.pdf");
  fs.writeFileSync(file, await doc.save());
  return file;
}

test("罫線のある表: 列の幅・右寄せ・見出しの背景色・結合セル・蛍光ペン・改ページがWordに反映される", async ({ page }) => {
  const pdfPath = await makePdf();
  await page.goto("/tools/pdf-to-word");
  const button = page.getByRole("button", { name: "Wordに変換する" });
  for (let attempt = 0; attempt < 5; attempt++) {
    await uploadFixture(page, pdfPath);
    if (await button.waitFor({ state: "visible", timeout: 12_000 }).then(() => true).catch(() => false)) break;
    if (attempt === 2) await page.reload();
  }
  await button.click();
  await expect(page.getByText("完了", { exact: false }).first()).toBeVisible({ timeout: 90_000 });
  const download = await clickAndDownload(page, "Word文書をダウンロード");
  const { path: docxPath } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
  const xml = await readDocxPart(docxPath, "word/document.xml");

  const table = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/)?.[0] ?? "";
  expect(table, "表が見つかりません").not.toBe("");

  // 列の幅: 罫線の間隔（90・100・100・100pt）どおり。最後の列が極端に狭くならない
  const grid = Array.from(table.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)).map((m) => Number(m[1]) / 20);
  expect(grid.length).toBe(4);
  const expected = [90, 100, 100, 100];
  grid.forEach((w, i) => expect(w, `列${i + 1}の幅`).toBeGreaterThan(expected[i] - 12));
  grid.forEach((w, i) => expect(w, `列${i + 1}の幅`).toBeLessThan(expected[i] + 12));

  // 見出しの背景色（D9E2F2付近）
  const fills = Array.from(table.matchAll(/<w:shd [^>]*w:fill="([0-9A-Fa-f]{6})"/g)).map((m) => m[1].toUpperCase());
  expect(fills.some((f) => parseInt(f.slice(0, 2), 16) > 200 && parseInt(f.slice(2, 4), 16) > 200 && parseInt(f.slice(4, 6), 16) > 220), `見出しの背景色が無い: ${fills.join(",")}`).toBe(true);

  // 数字の右寄せ
  expect(table).toMatch(/<w:jc w:val="right"\/>/);

  // 合計の行: 左の3列が1つのセルになっている（gridSpan=3）
  expect(table).toMatch(/<w:gridSpan w:val="3"\/>/);
  const rows = table.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? [];
  const totalRow = rows.find((r) => r.includes("Total")) ?? "";
  expect(totalRow).toContain("650,000");
  // 結合したセルの右寄せ
  const spanCell = totalRow.match(/<w:tc>[\s\S]*?<\/w:tc>/)?.[0] ?? "";
  expect(spanCell).toMatch(/<w:jc w:val="right"\/>/);

  // 蛍光ペン: 黄色の背景（FFFF00）が、文字の背景色として入っている
  const body = xml.replace(table, "");
  expect(body).toMatch(/<w:shd [^>]*w:fill="FFFF00"/);

  // 途中で終わった1ページ目のあとは、改ページが入る
  expect(xml).toMatch(/<w:br w:type="page"\/>/);
});
