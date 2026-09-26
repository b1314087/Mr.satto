import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 画像カテゴリの代表E2E（Phase 14 優先度1位）:
 * image-resize / image-compress / image-batch-convert
 *
 * 「ボタンを押した」だけで成功扱いにせず、実際に生成された画像ファイルの
 * マジックバイト・サイズまで確認する。
 */

test("image-resize: 画像を入力してリサイズし、PNGをダウンロードできる", async ({ page }) => {
  await page.goto("/tools/image-resize");
  await uploadFixture(page, fixtures.png);

  await page.getByRole("button", { name: "リサイズする" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-compress: 画像を入力して圧縮し、ファイルをダウンロードできる", async ({ page }) => {
  await page.goto("/tools/image-compress");
  await uploadFixture(page, fixtures.jpg);

  await page.getByRole("button", { name: "圧縮する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { minBytes: 10 });
});

test("image-batch-convert: 複数画像を一括変換し、ZIPでダウンロードできる", async ({ page }) => {
  await page.goto("/tools/image-batch-convert");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: /件を変換する$/ }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, /ダウンロード/);
  const { size } = await assertDownloadedFile(download, { minBytes: 10 });
  expect(size).toBeGreaterThan(0);
});
