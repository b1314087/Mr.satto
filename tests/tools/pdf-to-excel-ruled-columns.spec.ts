import { test, expect } from "../fixtures/premium-test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { computeRuledColumnBreaks, mergeRuledBreaks, type VerticalRule } from "@/lib/pdf/ruling-lines";
import type { PositionedTextItem } from "@/lib/pdf/pdfjs-client";

/**
 * PDF→Excel: 罫線の位置を列の区切りに使う。
 * 罫線で区切られた表で、セルいっぱいに文字が入っていて隙間が小さくても（右揃えの数字のすぐ隣に左揃えの文字が来る等）、
 * 隣り合う列が1つのセルにくっつかず、罫線どおりの列に分かれることを確認する。
 */

const COLS = [50, 100, 260, 310, 400]; // 罫線のx座標（4列）
const ROW_H = 18;

/** 4列×(見出し+5行)の、全面に罫線のある表。セルの文字は罫線から約1.2pt（隣のセルと2.4pt）の位置に置く */
async function makeRuledTable(opts: { withRules: boolean; outerFrameOnly?: boolean }): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10;
  const rows = [
    ["No.", "Item", "Qty", "Price"],
    ["1", "Notebook PC", "3", "128,000"],
    ["2", "Monitor 27in", "5", "32,800"],
    ["3", "Keyboard JP", "10", "4,980"],
    ["4", "USB Hub", "8", "2,480"],
    ["5", "Support plan", "1", "60,000"],
  ];
  const top = 350;
  rows.forEach((row, r) => {
    const y = top - r * ROW_H - 13;
    row.forEach((text, c) => {
      const w = font.widthOfTextAtSize(text, size);
      // 1・3列目（No.・Qty）は右揃え、2・4列目は左揃え。罫線との余白は約1.2pt
      const x = c % 2 === 0 ? COLS[c + 1] - 1.2 - w : COLS[c] + 1.2;
      page.drawText(text, { x, y, size, font });
    });
  });
  if (opts.withRules) {
    const bottom = top - rows.length * ROW_H;
    const xs = opts.outerFrameOnly ? [COLS[0], COLS[COLS.length - 1]] : COLS;
    for (const x of xs) page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 0.5, color: rgb(0, 0, 0) });
    for (let r = 0; r <= rows.length; r++) {
      const y = top - r * ROW_H;
      page.drawLine({ start: { x: COLS[0], y }, end: { x: COLS[COLS.length - 1], y }, thickness: 0.5, color: rgb(0, 0, 0) });
    }
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ruled-")), "ruled.pdf");
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function convert(page: import("@playwright/test").Page, pdfPath: string): Promise<string[][]> {
  await page.goto("/tools/pdf-to-excel");
  await uploadFixture(page, pdfPath);
  await expect(page.getByRole("button", { name: "Excelに変換する" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await expect(page.getByText("完了", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  const download = await clickAndDownload(page, "Excelファイルをダウンロード");
  const { path: out } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
  const sheet = await readXlsxSheet(out);
  return [sheet.headers, ...sheet.rows].map((r) => r.map((c) => (c == null ? "" : String(c))));
}

const EXPECTED = [
  ["No.", "Item", "Qty", "Price"],
  ["1", "Notebook PC", "3", "128000"],
  ["2", "Monitor 27in", "5", "32800"],
  ["3", "Keyboard JP", "10", "4980"],
  ["4", "USB Hub", "8", "2480"],
  ["5", "Support plan", "1", "60000"],
];

test("罫線のある表: 文字が罫線のすぐ隣まで詰まっていても、罫線どおりの4列に分かれる", async ({ page }) => {
  const pdf = await makeRuledTable({ withRules: true });
  const cells = await convert(page, pdf);
  expect(cells).toEqual(EXPECTED);
});

// --- 純粋な関数のテスト（罫線の取捨選択・区切りの統合） ---

function item(str: string, x: number, y: number, width = 30): PositionedTextItem {
  return { str, x, y, width, height: 10, fontHeight: 10, hasEOL: false };
}
function rule(x: number, y0 = 100, y1 = 200): VerticalRule {
  return { x, y0, y1 };
}

test("罫線から列の区切りを決める: 外枠の左右の罫線は区切りにせず、内側の罫線だけが区切りになる", () => {
  const items = [item("A", 55, 150), item("B", 105, 150), item("C", 265, 150), item("D", 315, 150)];
  const ruled = computeRuledColumnBreaks([rule(50), rule(100), rule(260), rule(310), rule(400)], items);
  expect(ruled?.breaks).toEqual([100, 260, 310]);
  expect(ruled?.range).toEqual([50, 400]);
});

test("罫線から列の区切りを決める: 外枠の外側に表の文字があれば、その罫線も区切りになる", () => {
  const items = [item("label", 20, 150, 20), item("A", 55, 150), item("B", 105, 150)];
  const ruled = computeRuledColumnBreaks([rule(50), rule(100), rule(260)], items);
  expect(ruled?.breaks[0]).toBe(50);
});

test("罫線から列の区切りを決める: 外枠だけ（2本）・短い線だけのときは使わない（文字の隙間による推定に任せる）", () => {
  const items = [item("A", 55, 150), item("B", 105, 150)];
  expect(computeRuledColumnBreaks([rule(50), rule(400)], items)).toBeNull();
  expect(computeRuledColumnBreaks([rule(50, 100, 110), rule(100, 100, 110), rule(260, 100, 110)], items)).toBeNull();
  expect(computeRuledColumnBreaks(null, items)).toBeNull();
  expect(computeRuledColumnBreaks([], items)).toBeNull();
});

test("罫線から列の区切りを決める: 同じ位置を細い線2本で描いた太い罫線・セルごとに分けて描いた罫線は1本にまとまる", () => {
  const items = [item("A", 55, 150), item("B", 105, 150), item("C", 265, 150)];
  const cellByCell = [rule(50, 100, 120), rule(50, 120, 140), rule(50, 140, 160), rule(50, 160, 180), rule(50, 180, 200)];
  const double = [rule(100, 100, 200), rule(100.8, 100, 200)];
  const ruled = computeRuledColumnBreaks([...cellByCell, ...double, rule(260), rule(400)], items);
  expect(ruled?.breaks.length).toBe(2);
  expect(ruled?.breaks[0]).toBeCloseTo(100.4, 1);
  expect(ruled?.breaks[1]).toBe(260);
});

test("区切りの統合: 罫線のある範囲では罫線の位置だけを使い、範囲の外は文字の隙間による区切りを残す", () => {
  const ruled = { breaks: [100, 260], range: [50, 400] as [number, number] };
  expect(mergeRuledBreaks([80, 150, 300, 450], ruled)).toEqual([100, 260, 450]);
  expect(mergeRuledBreaks([], ruled)).toEqual([100, 260]);
});

// --- 罫線のない表: 右揃えの数字の列に、左揃えの見出しが付いている ---

async function makeBorderlessStatement(): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([500, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10;
  // 列の左端と右端。数字は右揃え、見出し・文字は左揃え。出金の数字の右端と、入金の見出しの左端の間は2pt未満
  const cols = [
    { left: 50, right: 110, align: "left" as const },
    { left: 130, right: 220, align: "left" as const },
    { left: 240, right: 320, align: "right" as const },
    { left: 321.5, right: 400, align: "right" as const },
  ];
  const rows = [
    ["Date", "Memo", "Out", "In"],
    ["9/1", "Rent", "500", "1,200"],
    ["9/2", "Transfer", "15,000", "1,200"],
    ["9/3", "Salary", "48,000", ""],
    ["9/4", "ATM", "3,200", "1,200"],
    ["9/5", "Rent", "", "250,000"],
    ["9/6", "Salary", "48,000", "250,000"],
  ];
  rows.forEach((row, r) => {
    const y = 350 - r * 16;
    row.forEach((text, c) => {
      if (text === "") return;
      const w = font.widthOfTextAtSize(text, size);
      // 見出し行は、どの列も左揃え
      const left = r === 0 || cols[c].align === "left";
      page.drawText(text, { x: left ? cols[c].left : cols[c].right - w, y, size, font });
    });
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stmt-")), "statement.pdf");
  fs.writeFileSync(file, await doc.save());
  return file;
}

test("罫線のない表: 右揃えの数字の列に左揃えの見出しが付いていても、見出しが隣の見出しとくっつかない", async ({ page }) => {
  const cells = await convert(page, await makeBorderlessStatement());
  expect(cells[0]).toEqual(["Date", "Memo", "Out", "In"]);
  expect(cells[1]).toEqual(["9/1", "Rent", "500", "1200"]);
  expect(cells[2]).toEqual(["9/2", "Transfer", "15000", "1200"]);
  expect(cells[3]).toEqual(["9/3", "Salary", "48000", ""]);
  expect(cells[6]).toEqual(["9/6", "Salary", "48000", "250000"]);
});
