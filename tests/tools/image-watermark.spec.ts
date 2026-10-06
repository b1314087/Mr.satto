import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 画像ウォーターマーク: リアルタイムプレビュー・文字サイズのバー・大きい上限の検証。
 */

async function previewDataUrl(page: import("@playwright/test").Page): Promise<string> {
  return page.getByTestId("watermark-preview").evaluate((el) => (el as HTMLCanvasElement).toDataURL());
}

async function openWithFile(page: import("@playwright/test").Page) {
  await page.goto("/tools/image-watermark");
  await uploadFixture(page, fixtures.png);
  const ok = await page
    .getByTestId("watermark-preview")
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    await page.reload();
    await uploadFixture(page, fixtures.png);
  }
  await expect(page.getByTestId("watermark-preview")).toBeVisible({ timeout: 20_000 });
}

test("image-watermark: 文字サイズのバーを動かすとプレビューがリアルタイムに変わる", async ({ page }) => {
  await openWithFile(page);
  await expect.poll(async () => (await previewDataUrl(page)).length, { timeout: 10_000 }).toBeGreaterThan(200);
  const before = await previewDataUrl(page);

  // フォントサイズのバー(スライダー)。不透明度・回転よりも前にある
  const sizeSlider = page.getByRole("slider").first();
  await expect(sizeSlider).toHaveAttribute("min", "6");
  await sizeSlider.fill("90");
  await expect.poll(async () => await previewDataUrl(page), { timeout: 10_000 }).not.toBe(before);
});

test("image-watermark: 数値入力ならバーの上限(400)を超えて大きな文字サイズを指定でき、そのまま書き出せる", async ({ page }) => {
  await openWithFile(page);
  const sizeInput = page.getByLabel("フォントサイズの数値");
  await sizeInput.fill("1500");
  await sizeInput.blur();
  await expect(sizeInput).toHaveValue("1500");

  // 上限(2000)を超える入力は2000へ丸められる
  await sizeInput.fill("9999");
  await sizeInput.blur();
  await expect(sizeInput).toHaveValue("2000");

  await sizeInput.fill("1200");
  await sizeInput.blur();
  await page.getByRole("button", { name: "透かしを追加する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});
