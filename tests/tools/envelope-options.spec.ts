import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 封筒宛名: 封筒の向き(縦/横)・敬称(様/御中/なし)・文字サイズ・太字 */
async function fillRecipient(page: import("@playwright/test").Page) {
  await page.locator('input[placeholder*="郵便番号"]').first().fill("1000001");
  await page.locator('input[placeholder="住所"]').first().fill("東京都千代田区千代田1-1");
  await page.locator('input[placeholder="氏名"]').first().fill("山田商事");
}

async function makePdf(page: import("@playwright/test").Page): Promise<string> {
  await page.getByRole("button", { name: "PDFを作成" }).click();
  await expect(page.getByText("封筒PDFを作成しました")).toBeVisible({ timeout: 20_000 });
  const download = await clickAndDownload(page, /PDFをダウンロード/);
  const pdf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "env-")), "out.pdf");
  await download.saveAs(pdf);
  return pdf;
}

function pageSize(pdf: string): { w: number; h: number } {
  const m = execFileSync("pdfinfo", [pdf]).toString().match(/Page size:\s+([\d.]+) x ([\d.]+)/)!;
  return { w: Number(m[1]), h: Number(m[2]) };
}

test("封筒の向き(縦向き)・敬称(御中)・文字サイズ・太字を指定してPDFを作成できる", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByRole("button", { name: "横書き" }).click();
  await page.getByRole("button", { name: "縦向き" }).click();
  await page.getByRole("button", { name: "御中", exact: true }).click();
  await page.getByLabel("宛名の文字サイズ").fill("30");
  await page.getByLabel("宛名を太字にする").check();

  // プレビューにも反映されている
  const preview = page.getByTestId("tool-preview");
  await expect(preview).toContainText("山田商事 御中");
  await expect(preview).toContainText("縦向き");

  const pdf = await makePdf(page);
  const size = pageSize(pdf);
  expect(size.h, "縦向きなら高さ>幅").toBeGreaterThan(size.w);
  const txt = execFileSync("pdftotext", ["-layout", pdf, "-"]).toString();
  expect(txt).toContain("山田商事 御中");
  expect(txt).not.toContain("様");
});

test("敬称なしにすると、宛名に様も御中も付かない。横向きは横長のPDF", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByRole("button", { name: "横書き" }).click();
  await page.getByRole("button", { name: "なし", exact: true }).click();
  const pdf = await makePdf(page);
  const size = pageSize(pdf);
  expect(size.w).toBeGreaterThan(size.h);
  const txt = execFileSync("pdftotext", ["-layout", pdf, "-"]).toString();
  expect(txt).toContain("山田商事");
  expect(txt).not.toMatch(/様|御中/);
});

test("文字サイズが範囲外ならエラーになる", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByLabel("宛名の文字サイズ").fill("200");
  await expect(page.getByText(/文字サイズは.*の範囲/)).toBeVisible();
});
