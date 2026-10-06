import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, waitForSuccess } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function fillBasic(page: import("@playwright/test").Page, rows = 2) {
  await page.getByRole("button", { name: "自動採番" }).click();
  const company = page.getByPlaceholder("会社名・屋号");
  await company.nth(0).fill("株式会社お客様商事");
  await page.getByPlaceholder("担当者名").nth(0).fill("山田 太郎");
  await page.getByPlaceholder("住所").nth(0).fill("東京都千代田区1-1-1");
  await company.nth(1).fill("株式会社テスト工務店");
  await page.getByPlaceholder("住所").nth(1).fill("大阪府大阪市2-2-2");
  await page.getByPlaceholder("商品名・作業内容").first().fill("外壁塗装工事");
  await page.getByPlaceholder("0", { exact: true }).first().fill("10000");
  for (let i = 1; i < rows; i++) {
    await page.getByRole("button", { name: /明細.*追加|行を追加/ }).first().click();
    await page.getByPlaceholder("商品名・作業内容").nth(i).fill(`追加作業${i}`);
    await page.getByPlaceholder("0", { exact: true }).nth(i).fill("5000");
  }
}

test("見積書・注文書一体: 1枚のPDFの上に見積書、下に注文書が入る", async ({ page }) => {
  await page.goto("/tools/quote-order-generator");
  await fillBasic(page, 1);
  await page.getByPlaceholder("例: 2026年11月30日 / 受注後2週間").fill("2026年11月30日");

  const preview = page.getByTestId("tool-preview");
  await expect(preview).toContainText("見積書");
  await expect(preview).toContainText("注文書");
  await expect(preview).toContainText("キリトリ線");
  await expect(preview).toContainText("納期: 2026年11月30日");

  await page.getByRole("button", { name: "見積書・注文書を作成する" }).click();
  await waitForSuccess(page, "作成しました");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qo-"));
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  if (process.env.QO_DUMP_DIR) fs.copyFileSync(pdf, path.join(process.env.QO_DUMP_DIR, "quote-order.pdf"));

  const info = execFileSync("pdfinfo", [pdf]).toString();
  expect(info).toMatch(/Pages:\s+1/);
  const txt = execFileSync("pdftotext", ["-layout", pdf, "-"]).toString();
  // 見積書(上)→注文書(下)の順に出る
  const iQuote = txt.indexOf("見積書");
  const iOrder = txt.indexOf("注文書");
  expect(iQuote).toBeGreaterThanOrEqual(0);
  expect(iOrder).toBeGreaterThan(iQuote);
  expect(txt).toContain("株式会社お客様商事");
  expect(txt).toContain("株式会社テスト工務店");
  expect(txt).toContain("外壁塗装工事");
  expect(txt).toContain("納期: 2026年11月30日");
  // 税込の合計(10,000円×1 + 10%)が両方に入る
  expect((txt.match(/¥11,000|11,000円|￥11,000/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("見積書・注文書一体: 明細が多すぎると案内が出て、PDF作成はエラーになる", async ({ page }) => {
  await page.goto("/tools/quote-order-generator");
  await fillBasic(page, 1);
  for (let i = 1; i < 20; i++) {
    await page.getByRole("button", { name: /明細.*追加|行を追加/ }).first().click();
    await page.getByPlaceholder("商品名・作業内容").nth(i).fill(`追加作業${i}`);
  }
  await expect(page.getByTestId("quote-order-overflow")).toContainText("1枚");
  await page.getByRole("button", { name: "見積書・注文書を作成する" }).click();
  await expect(page.getByText("収まりません").first()).toBeVisible();
});
