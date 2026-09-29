import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import {
  uploadFixture,
  waitForSuccess,
  clickAndDownload,
  assertDownloadedFile,
  getPngDimensions,
} from "../helpers/tool-runner";

/**
 * 画像結合ツール（Mr.Satto 次工程フェーズ Step 5）のE2Eテスト。
 *
 * 入力（複数画像・追加・削除）、結合方法（横/縦/グリッド）、サイズ
 * （元サイズ・倍率・サイズ統一）、レイアウト（間隔・背景・並び替え）、
 * 出力（PNG/JPEG）、異常系、モバイル表示、Registry整合性を検証する。
 *
 * sample.png/sample.jpg は64x64の正方形、landscapeJpgは300x200の横長、
 * portraitPngは120x200の縦長で、サイズ・向きが異なる画像を混在させた
 * 際の挙動（元サイズ維持・縦横比を潰さないこと）を確認できるようにしている。
 */

test("image-merge: ページが表示され、画像を2枚アップロードすると設定UIが出る", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await expect(page.getByRole("heading", { name: "画像結合" })).toBeVisible();

  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await expect(page.getByText("結合方法")).toBeVisible();
  await expect(page.getByRole("button", { name: "横結合" })).toBeVisible();
  await expect(page.getByRole("button", { name: "縦結合" })).toBeVisible();
  await expect(page.getByRole("button", { name: "グリッド" })).toBeVisible();
});

test("image-merge: 画像1枚のみでは結合できず案内が表示される", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png]);

  await expect(page.getByText("2枚以上")).toBeVisible();
  await expect(page.getByRole("button", { name: "PNGで保存" })).toHaveCount(0);
});

test("image-merge: 画像を追加できる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await expect(page.getByRole("button", { name: /下へ移動/ })).toHaveCount(3);
});

test("image-merge: 画像を削除できる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg, fixtures.landscapeJpg]);

  await page.getByRole("button", { name: /削除/ }).first().click();
  await expect(page.getByRole("button", { name: /下へ移動/ })).toHaveCount(2);
});

test("image-merge: 上下ボタンで画像の順序を入れ替えられる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const downButtons = page.getByRole("button", { name: /下へ移動/ });
  await expect(downButtons.first()).toBeEnabled();
  await downButtons.first().click();
  // 1件目が2件目に移動した後は「下へ」が無効になる
  await expect(page.getByRole("button", { name: /下へ移動/ }).nth(1)).toBeDisabled();
});

test("image-merge: 横結合（元サイズ）で正しい幅・高さのPNGが書き出される", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.png]); // 64x64を2枚

  await page.getByRole("button", { name: "横結合" }).click();
  // 間隔を10pxに固定
  await page.getByRole("button", { name: "10px" }).click();

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  // 64 + 10(gap) + 64 = 138、高さは64のまま（元サイズ維持を数値で確認）
  expect(dims.width).toBe(138);
  expect(dims.height).toBe(64);
});

test("image-merge: 縦結合（元サイズ）で正しい幅・高さのPNGが書き出される", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.png]);

  await page.getByRole("button", { name: "縦結合" }).click();
  await page.getByRole("button", { name: "0px" }).click();

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(64);
  expect(dims.height).toBe(128);
});

test("image-merge: グリッド結合でサイズが異なる画像でも崩れず書き出せる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.landscapeJpg, fixtures.portraitPng]);

  await page.getByRole("button", { name: "グリッド" }).click();
  await page.getByLabel("列数").fill("2");

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-merge: 元サイズモード（既定）では画像が縮小されない", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.landscapeJpg, fixtures.portraitPng]); // 300x200 + 120x200

  await page.getByRole("button", { name: "横結合" }).click();
  await page.getByRole("button", { name: "0px" }).click();

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(420); // 300 + 120
  expect(dims.height).toBe(200);
});

test("image-merge: 倍率指定でサイズが変わる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.png]);

  await page.getByRole("button", { name: "横結合" }).click();
  await page.getByRole("button", { name: "0px" }).click();
  await page.getByRole("button", { name: "倍率指定" }).click();
  await page.getByRole("button", { name: "50%" }).click();

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  // 64px * 50% = 32px を2枚、間隔0
  expect(dims.width).toBe(64);
  expect(dims.height).toBe(32);
});

test("image-merge: サイズを揃える（フィット）で縦横比を潰さずに指定サイズへ揃う", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.landscapeJpg, fixtures.portraitPng]); // 300x200 + 120x200

  await page.getByRole("button", { name: "横結合" }).click();
  await page.getByRole("button", { name: "0px" }).click();
  await page.getByRole("button", { name: "サイズを揃える" }).click();
  await page.getByLabel("幅").fill("100");
  await page.getByLabel("高さ").fill("100");
  await page.getByRole("button", { name: "比率維持+フィット" }).click();

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  // 各セル100x100を2枚、間隔0
  expect(dims.width).toBe(200);
  expect(dims.height).toBe(100);
});

test("image-merge: 背景を透明に切り替えられ、JPEGフォールバックの案内が表示される", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.png]);

  await expect(page.getByText("JPEGで保存する場合、透明は白背景になります")).toBeVisible();

  const transparentButton = page.getByRole("button", { name: "透明" });
  await transparentButton.click();
  await expect(transparentButton).toHaveClass(/bg-blue-600/);
});

test("image-merge: JPEGで書き出せる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: "JPEGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
});

test("image-merge: 未対応ファイル（txt）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.txt]);
  await expect(page.getByRole("alert")).toBeVisible();
});

test("image-merge: 破損した画像ファイルが混ざるとエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.corruptedImage]);

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("image-merge: ファイル未選択時は保存ボタンが表示されない", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await expect(page.getByRole("button", { name: "PNGで保存" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "JPEGで保存" })).toHaveCount(0);
});

test("image-merge: 不正なサイズ指定（0px）はエラー表示になり保存ボタンが無効", async ({ page }) => {
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: "サイズを揃える" }).click();
  await page.getByLabel("幅").fill("0");

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "PNGで保存" })).toBeDisabled();
});

test("image-merge: モバイル幅(375px)でも横スクロールが発生せず主要要素が操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await expect(page.getByRole("button", { name: "グリッド" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PNGで保存" })).toBeVisible();
  await expect(page.getByRole("button", { name: "JPEGで保存" })).toBeVisible();
});

test("image-merge: モバイル幅(320px)でも横スクロールが発生しない", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/tools/image-merge");
  await uploadFixture(page, [fixtures.png, fixtures.jpg, fixtures.landscapeJpg]);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
});
