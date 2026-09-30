import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 次工程・印刷帳票4ツール追加フェーズのE2Eスモークテスト。
 * 各ツールの基本動作（入力→生成→ダウンロード）のみを確認する
 * 詳細なレイアウト検証（mm精度そのもの）は自動テストでは検証しきれないため、
 * 「正しい形式のファイルが壊れずに生成される」ことを確認する範囲にとどめる。
 */

test.describe("excel-label", () => {
  test("既定値のままExcelラベルシートを作成してダウンロードできる", async ({ page }) => {
    await page.goto("/tools/excel-label");
    await page.getByRole("button", { name: "Excelを作成" }).click();
    await expect(page.getByText("ラベルシートを作成しました")).toBeVisible({ timeout: 15_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    await assertDownloadedFile(download, { format: "zip", minBytes: 500 });
  });
});

test.describe("envelope-address", () => {
  test("1件の宛先を入力して封筒PDFを作成できる", async ({ page }) => {
    await page.goto("/tools/envelope-address");
    const postal = page.locator('input[placeholder*="郵便番号"]').first();
    const address = page.locator('input[placeholder="住所"]').first();
    const name = page.locator('input[placeholder="氏名"]').first();
    await postal.fill("1000001");
    await address.fill("東京都千代田区千代田1-1");
    await name.fill("山田太郎");
    await page.getByRole("button", { name: "PDFを作成" }).click();
    await expect(page.getByText("封筒PDFを作成しました")).toBeVisible({ timeout: 15_000 });
    const download = await clickAndDownload(page, /PDFをダウンロード/);
    await assertDownloadedFile(download, { format: "pdf", minBytes: 500 });
  });
});

test.describe("ticket-voucher", () => {
  test("既定値のまま整理券PDFを作成してダウンロードできる", async ({ page }) => {
    await page.goto("/tools/ticket-voucher");
    await page.getByRole("button", { name: "PDFを作成" }).click();
    await expect(page.getByText("PDFを作成しました")).toBeVisible({ timeout: 15_000 });
    const download = await clickAndDownload(page, /PDFをダウンロード/);
    await assertDownloadedFile(download, { format: "pdf", minBytes: 500 });
  });

  test("QRコード・バーコードを有効にしても作成できる", async ({ page }) => {
    await page.goto("/tools/ticket-voucher");
    await page.getByText("QRコードを表示する").click();
    await page.getByText("バーコードを表示する（CODE128）").click();
    await page.getByRole("button", { name: "PDFを作成" }).click();
    await expect(page.getByText("PDFを作成しました")).toBeVisible({ timeout: 20_000 });
    const download = await clickAndDownload(page, /PDFをダウンロード/);
    await assertDownloadedFile(download, { format: "pdf", minBytes: 500 });
  });
});

test.describe("roster-template", () => {
  test("CSVを読み込み、Excel・PDFの両方を作成できる", async ({ page }) => {
    const csvContent = "氏名,学年,組\n山田太郎,1,A\n佐藤花子,2,B\n鈴木一郎,3,C\n";
    const tmpPath = path.join(os.tmpdir(), `roster-test-${Date.now()}.csv`);
    fs.writeFileSync(tmpPath, csvContent, "utf-8");

    await page.goto("/tools/roster-template");
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(tmpPath);

    await expect(page.getByText("3行読み込みました", { exact: false })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Excelを作成" }).click();
    await expect(page.getByText("作成しました")).toBeVisible({ timeout: 15_000 });
    const excelDownload = await clickAndDownload(page, /Excelファイルをダウンロード/);
    await assertDownloadedFile(excelDownload, { format: "zip", minBytes: 300 });

    await page.getByRole("button", { name: "PDFを作成" }).click();
    await expect(page.getByText("作成しました")).toBeVisible({ timeout: 15_000 });
    const pdfDownload = await clickAndDownload(page, /PDFファイルをダウンロード/);
    await assertDownloadedFile(pdfDownload, { format: "pdf", minBytes: 300 });

    fs.unlinkSync(tmpPath);
  });
});
