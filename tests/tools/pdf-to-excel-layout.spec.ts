import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readXlsxSheet, readXlsxRawStructure } from "../helpers/xlsx-inspect";

/**
 * PDF→Excelの「使いやすさ」整形のテスト。
 *
 * 給料表のように、同じ構成の表が左右に並ぶPDF(番号1〜12と13〜24)を、
 * - 左右の表を縦に1つの表へつなげる(番号が1〜30の順に並ぶ)
 * - 縦書きの区分名を1つのセルにする(1文字ずつの行が混ざらない)
 * - 字間を広げたタイトルを1つの文字列にする
 * - 複数行に割れた見出しを1行にする
 * - ページ番号をデータに混ぜない
 * ことを確認する。ブラウザの操作→ダウンロードしたxlsxの中身まで見る。
 */

async function openAndUpload(page: import("@playwright/test").Page) {
  await page.goto("/tools/pdf-to-excel");
  await uploadFixture(page, fixtures.pdfToExcelSideBySidePdf);
  const visible = await page
    .getByRole("button", { name: "Excelに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    await page.reload();
    await uploadFixture(page, fixtures.pdfToExcelSideBySidePdf);
  }
  await expect(page.getByRole("button", { name: "Excelに変換する" })).toBeVisible({ timeout: 20_000 });
}

async function convert(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 30_000 });
  const download = await clickAndDownload(page, "Excelファイルをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
  return path;
}

async function allRows(path: string): Promise<string[][]> {
  const sheet = await readXlsxSheet(path);
  return [sheet.headers, ...sheet.rows].map((r) => r.map((c) => (c == null ? "" : String(c))));
}

test("左右に並んだ表が縦に1つの表になり、番号が1〜30の順に並ぶ", async ({ page }) => {
  await openAndUpload(page);
  // 左右に並んだ表を見つけたことが、画面に案内される
  await expect(page.getByTestId("option-stack-side-by-side")).toBeChecked();
  const path = await convert(page);
  const rows = await allRows(path);

  // 番号(列の中で最初に数値が1つだけ入っている列)を行順に取り出す
  const keys = rows
    .map((r) => r.find((c) => /^\d{1,2}$/.test(c)) ?? "")
    .filter((c) => c !== "")
    .map(Number);
  expect(keys, `番号が1〜30の順に並んでいません: ${JSON.stringify(rows.slice(0, 40))}`).toEqual(
    Array.from({ length: 30 }, (_, i) => i + 1)
  );

  // 右の表(13〜24)の値が、左の表と同じ列に入っている(列がずれていない)
  const row1 = rows.find((r) => r.includes("1") && r.includes("201100"));
  const row13 = rows.find((r) => r.includes("13") && r.includes("213100"));
  expect(row1, JSON.stringify(rows.slice(0, 8))).toBeTruthy();
  expect(row13, JSON.stringify(rows.slice(10, 20))).toBeTruthy();
  expect(row13!.indexOf("213100")).toBe(row1!.indexOf("201100"));
});

test("縦書きの区分名・字間を広げたタイトル・見出し・ページ番号が整理される", async ({ page }) => {
  await openAndUpload(page);
  const path = await convert(page);
  const rows = await allRows(path);
  const flat = rows.flat();

  // 縦書きの区分名は1文字ずつの行にならず、まとまった1つの文字列で出る(左・右の表と2ページ目の3か所)
  expect(flat.filter((c) => c === "SENIORSTAFF").length).toBe(3);
  expect(flat.filter((c) => c.length === 1 && /[A-Z]/.test(c)).length, "1文字ずつのセルが残っています").toBe(0);

  // 字間を広げたタイトルは1つの文字列
  expect(flat).toContain("GRADETABLE");

  // 複数行に割れた見出しは1行にまとまる(列ごとに「Grade A Salary」)
  expect(flat).toContain("Grade A Salary");

  // ページ番号(「1」「2」だけの孤立した行)がデータに混ざっていない:
  // 番号は1〜30がちょうど1回ずつ。ページ番号の「1」「2」が余分に入ると重複する
  const keyCells = rows.map((r) => r.filter((c) => /^\d{1,2}$/.test(c))).filter((r) => r.length > 0);
  expect(keyCells.length).toBe(30);

  // 縦書きの区分名は縦に結合したセル(rowSpan)になっている
  const raw = await readXlsxRawStructure(path);
  expect(raw.mergedRanges.length, JSON.stringify(raw.mergedRanges)).toBeGreaterThanOrEqual(3);
  expect(raw.mergedRanges.some((r) => /^A\d+:A\d+$/.test(r))).toBe(true);
  // 見出しは固定表示(freeze panes)される
  expect(raw.sheetXml).toContain("<pane");
});

test("オプションを切り替えると、左右の表のまま出力される", async ({ page }) => {
  await openAndUpload(page);
  await page.getByTestId("option-stack-side-by-side").uncheck();
  const path = await convert(page);
  const rows = await allRows(path);
  // 連結しないので、1行に「1」と「13」が同時に入っている
  const both = rows.find((r) => r.includes("1") && r.includes("13"));
  expect(both, JSON.stringify(rows.slice(0, 10))).toBeTruthy();
});

test("ページごとに別シートに分けるオプション", async ({ page }) => {
  await openAndUpload(page);
  await page.getByTestId("option-sheet-per-page").check();
  const path = await convert(page);
  const raw = await readXlsxRawStructure(path);
  expect(raw.sheetXml.length).toBeGreaterThan(0);
  const { unzipSync, strFromU8 } = await import("fflate");
  const fs = await import("node:fs/promises");
  const entries = unzipSync(new Uint8Array(await fs.readFile(path)), { filter: (i) => i.name === "xl/workbook.xml" });
  const workbook = strFromU8(entries["xl/workbook.xml"]);
  expect((workbook.match(/<sheet /g) ?? []).length).toBe(2);
});
