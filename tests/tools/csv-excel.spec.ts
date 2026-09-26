import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * CSV/Excelカテゴリの代表E2E（Phase 14 優先度1位）:
 * csv-format / csv-to-excel / excel-to-csv / csv-merge
 */

test("csv-format: テキストエリアにCSVを入力して整形し、コピー可能になる", async ({ page }) => {
  await page.goto("/tools/csv-format");
  const csvContent = fs.readFileSync(fixtures.csv, "utf8");

  await page.locator("textarea").first().fill(csvContent);
  await page.getByRole("button", { name: "整形する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "CSVとしてダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1 });
  const outContent = fs.readFileSync(path, "utf8");
  expect(outContent).toContain("テスト商品A");
});

test("csv-to-excel: CSVをアップロードしてExcelに変換しダウンロードできる", async ({ page }) => {
  await page.goto("/tools/csv-to-excel");
  await uploadFixture(page, fixtures.csv);

  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "zip", minBytes: 10 }); // xlsx = zipコンテナ
});

test("excel-to-csv: Excelをアップロードしてcsvに変換しダウンロードできる", async ({ page }) => {
  await page.goto("/tools/excel-to-csv");
  await uploadFixture(page, fixtures.xlsx);

  await page.getByRole("button", { name: "CSVに変換する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "CSVでダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1 });
  const outContent = fs.readFileSync(path, "utf8");
  expect(outContent).toContain("テスト商品A");
});

test("csv-merge: 複数CSVを結合してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/csv-merge");
  await uploadFixture(page, [fixtures.csv, fixtures.csvForMerge]);

  await page.getByRole("button", { name: /件のCSVを結合する$/ }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "CSVでダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1 });
  const outContent = fs.readFileSync(path, "utf8");
  expect(outContent).toContain("テスト商品A");
  expect(outContent).toContain("テスト商品D");
});
