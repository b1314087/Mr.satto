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
  // 初回表示直後は入力が反映されないことがあるため、プレビューに出るまで入力し直す
  await expect(async () => {
    await page.getByLabel("宛先1").fill("〒100-0001\n東京都千代田区千代田1-1\n山田商事");
    await expect(page.getByTestId("tool-preview").locator("svg")).toContainText("東", { timeout: 3000 });
  }).toPass({ timeout: 40_000 });
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
  await setSlider(page, "宛先の文字サイズ", 30);
  await page.getByLabel("宛先を太字にする").check();

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
  await setSlider(page, "宛先の文字サイズ", 200);
  await expect(page.getByLabel("宛先の文字サイズの数値")).toHaveValue("60");
  await expect(page.getByRole("button", { name: "PDFを作成" })).toBeEnabled();
});

test("郵便番号の枠(四角)は描かず、プレビューには背景以外の四角が無い", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByRole("button", { name: "横書き" }).click();
  const svg = page.getByTestId("tool-preview").locator("svg");
  await expect(svg).toContainText("〒100-0001");
  await expect(svg.locator("rect")).toHaveCount(1);
});

test("宛名のX・Y位置をスライダーで指定すると、その位置にPDFへ印刷される", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  await page.getByRole("button", { name: "横書き" }).click();
  await page.getByRole("button", { name: "横向き" }).click();
  await setSlider(page, "宛先のX位置", 30);
  await setSlider(page, "宛先のY位置", 60);
  const pdf = await makePdf(page);
  const size = pageSize(pdf);
  const bbox = execFileSync("pdftotext", ["-bbox", pdf, "-"]).toString();
  const m = bbox.match(/<word xMin="([\d.]+)" yMin="([\d.]+)"[^>]*>山田商事<\/word>/);
  expect(m, "宛先の位置が取得できる").toBeTruthy();
  expect(Math.abs(Number(m![1]) - size.w * 0.3), "X位置").toBeLessThan(4);
  const ys = [...bbox.matchAll(/<word xMin="[\d.]+" yMin="([\d.]+)"/g)].map((x) => Number(x[1]));
  expect(Math.abs(Math.min(...ys) - size.h * 0.6), "Y位置(1行目の上端)").toBeLessThan(12);
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

test("設定を操作しても、プレビューは常に画面内に見えている", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await fillRecipient(page);
  const slider = page.getByLabel("宛先のX位置の数値");
  await slider.scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 600);
  const preview = page.getByTestId("tool-preview");
  await expect(preview).toBeInViewport({ ratio: 0.9 });
  await setSlider(page, "宛先のX位置", 20);
  await expect(preview).toBeInViewport({ ratio: 0.9 });
});

test("宛先は郵便番号・住所・氏名に分けず、1つの枠に自由に入力できる", async ({ page }) => {
  await page.goto("/tools/envelope-address");
  await expect(page.locator('input[placeholder="住所"]')).toHaveCount(0);
  await expect(page.getByLabel("宛先1")).toBeVisible();
  await expect(page.getByLabel("宛先のX位置の数値")).toHaveCount(1);
});
