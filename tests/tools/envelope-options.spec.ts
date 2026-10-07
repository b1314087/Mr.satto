import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** スライダー横の数値欄に値を入れて確定する(Enter) */
async function setSlider(page: import("@playwright/test").Page, label: string, value: number) {
  const box = page.getByLabel(`${label}の数値`);
  await box.fill(String(value));
  await box.press("Enter");
}

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
  await setSlider(page, "宛名の文字サイズ", 30);
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

test("文字サイズの数値が範囲外でも、範囲内に丸められる", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await setSlider(page, "宛名の文字サイズ", 200);
  await expect(page.getByLabel("宛名の文字サイズの数値")).toHaveValue("60");
  await expect(page.getByRole("button", { name: "PDFを作成" })).toBeEnabled();
});

test("郵便番号の枠(四角)は描かず、プレビューには背景以外の四角が無い", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  const svg = page.getByTestId("tool-preview").locator("svg");
  await expect(svg).toContainText("〒100-0001");
  await expect(svg.locator("rect")).toHaveCount(1);
});

test("宛名のX・Y位置をスライダーで指定すると、その位置にPDFへ印刷される", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByRole("button", { name: "横書き" }).click();
  await page.getByRole("button", { name: "横向き" }).click();
  await setSlider(page, "宛名のX位置", 30);
  await setSlider(page, "宛名のY位置", 60);
  const pdf = await makePdf(page);
  const size = pageSize(pdf);
  const bbox = execFileSync("pdftotext", ["-bbox", pdf, "-"]).toString();
  const m = bbox.match(/<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>山田商事<\/word>/);
  expect(m, "宛名の位置が取得できる").toBeTruthy();
  expect(Math.abs(Number(m![1]) - size.w * 0.3), "X位置").toBeLessThan(4);
  expect(Math.abs(Number(m![2]) - size.h * 0.6), "Y位置").toBeLessThan(10);
});

test("自由に入力したテキストを追加でき、位置と文字サイズも決められる", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByRole("button", { name: "横書き" }).click();
  await page.getByRole("button", { name: /自由に入力するテキストを追加/ }).click();
  await page.getByLabel("自由テキスト1の内容").fill("請求書在中");
  await setSlider(page, "自由テキスト1のX位置", 10);
  await setSlider(page, "自由テキスト1のY位置", 10);
  await setSlider(page, "自由テキスト1の文字サイズ", 20);
  await expect(page.getByTestId("tool-preview")).toContainText("請求書在中");
  const pdf = await makePdf(page);
  expect(execFileSync("pdftotext", ["-layout", pdf, "-"]).toString()).toContain("請求書在中");
});
