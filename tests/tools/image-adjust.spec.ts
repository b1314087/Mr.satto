import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 画像の明るさ・コントラスト調整: リアルタイムプレビューと一括処理の検証。
 */

async function previewDataUrl(page: import("@playwright/test").Page): Promise<string> {
  return page.getByTestId("adjust-preview").evaluate((el) => (el as HTMLCanvasElement).toDataURL());
}

async function openWithFiles(page: import("@playwright/test").Page, files: string | string[]) {
  await page.goto("/tools/image-adjust");
  await uploadFixture(page, files);
  // next dev の初回コンパイル待ちでアップロードが反映されないことがある既知の不安定さへの対処
  const ok = await page
    .getByTestId("adjust-preview")
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    await page.reload();
    await uploadFixture(page, files);
  }
  await expect(page.getByTestId("adjust-preview")).toBeVisible({ timeout: 20_000 });
}

test("image-adjust: スライダー(数値)を変えるとプレビューがリアルタイムに変わる", async ({ page }) => {
  await openWithFiles(page, fixtures.png);

  // 描画されるまで待つ(変更前のプレビュー)
  await expect.poll(async () => (await previewDataUrl(page)).length, { timeout: 10_000 }).toBeGreaterThan(200);
  const before = await previewDataUrl(page);

  // 「ダウンロード」ボタンを押さずに、スライダー操作だけでプレビューが変わる
  const slider = page.getByRole("slider").first();
  await slider.fill("60");
  await expect.poll(async () => await previewDataUrl(page), { timeout: 10_000 }).not.toBe(before);

  // リセットで元に戻る
  await page.getByRole("button", { name: "リセット" }).first().click();
  await expect.poll(async () => await previewDataUrl(page), { timeout: 10_000 }).toBe(before);
});

test("image-adjust: 数値入力でも値を変えられ、1枚はそのままダウンロードできる", async ({ page }) => {
  await openWithFiles(page, fixtures.png);
  await page.getByLabel("明るさの数値").fill("40");
  await page.getByLabel("明るさの数値").blur();
  await expect(page.getByRole("slider").first()).toHaveValue("40");

  await page.getByRole("button", { name: "適用する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  expect(download.suggestedFilename()).toMatch(/-adjusted\.png$/);
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-adjust: 複数画像に同じ設定を一括適用し、ZIPでダウンロードできる", async ({ page }) => {
  await openWithFiles(page, [fixtures.png, fixtures.jpg]);
  // 複数のときはプレビューする画像を選べる
  await expect(page.getByText("プレビューする画像")).toBeVisible();

  await page.getByRole("slider").nth(1).fill("30");
  await page.getByRole("button", { name: "2枚をまとめて調整する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  await assertDownloadedFile(download, { format: "zip", minBytes: 50 });
});
