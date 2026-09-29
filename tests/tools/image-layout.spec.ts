import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 画像レイアウトツール（Mr.Satto 次工程フェーズの中心ツール）のE2Eテスト。
 * 「画像結合」「グリッド配置」「文字追加」「PDF/PNG書き出し」の代表シナリオを検証する。
 */

test("image-layout: 複数画像を配置してPNGを書き出せる", async ({ page }) => {
  await page.goto("/tools/image-layout");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: "書き出す" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-layout: グリッドに配置してPDFを書き出せる", async ({ page }) => {
  await page.goto("/tools/image-layout");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: "グリッドに配置を適用" }).click();
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await page.getByRole("button", { name: "書き出す" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
});

test("image-layout: 文字を追加してテキストアイテムを編集できる", async ({ page }) => {
  await page.goto("/tools/image-layout");
  await page.getByRole("button", { name: "文字を追加" }).click();

  const textarea = page.locator("textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill("こんにちは");
  await expect(textarea).toHaveValue("こんにちは");

  // 画像なしで文字だけでもPNG書き出しができる（画像レイアウトは画像専用ツールではない）
  await page.getByRole("button", { name: "書き出す" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-layout: アイテムが無い状態では書き出すボタンが無効", async ({ page }) => {
  await page.goto("/tools/image-layout");
  await expect(page.getByRole("button", { name: "書き出す" })).toBeDisabled();
});
