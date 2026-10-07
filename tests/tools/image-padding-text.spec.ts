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
 * 画像一括余白・文字入れツール（Mr.Satto 次工程フェーズ Step 6）のE2Eテスト。
 *
 * 入力（1枚/複数枚/追加/削除/並び替え）、余白（上下左右・元画像サイズ維持）、
 * 背景、文字（入力・サイズ・色・太字・複数行・配置・文字なし）、
 * 共通設定/個別設定（反映・維持）、出力（PNG/JPEG/一括ZIP）、異常系、
 * モバイル表示を検証する。
 *
 * sample.png/sample.jpgは64x64の正方形、landscapeJpgは300x200の横長。
 */

test("image-padding-text: ページが表示され、画像を1枚アップロードすると設定UIが出る", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await expect(page.getByRole("heading", { name: "画像一括余白・文字入れ" })).toBeVisible();

  await uploadFixture(page, [fixtures.png]);

  await expect(page.getByText("1 / 1")).toBeVisible();
  await expect(page.getByText("共通設定（全画像に適用）")).toBeVisible();
  await expect(page.getByRole("button", { name: "この画像だけ保存" })).toBeVisible();
});

test("image-padding-text: 複数枚アップロードすると前へ/次へで切り替えられる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await expect(page.getByText("1 / 2")).toBeVisible();
  const prevButton = page.getByRole("button", { name: "← 前へ" });
  const nextButton = page.getByRole("button", { name: "次へ →" });
  await expect(prevButton).toBeDisabled();
  await expect(nextButton).toBeEnabled();

  await nextButton.click();
  await expect(page.getByText("2 / 2")).toBeVisible();
  await expect(nextButton).toBeDisabled();

  await prevButton.click();
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("image-padding-text: 画像を追加できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);
  await uploadFixture(page, [fixtures.jpg, fixtures.landscapeJpg]);

  await expect(page.getByText("1 / 3")).toBeVisible();
});

test("image-padding-text: 画像を削除できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg, fixtures.landscapeJpg]);

  await page.getByRole("button", { name: /削除/ }).first().click();
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("image-padding-text: 上下ボタンで画像の順序を入れ替えられる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const downButtons = page.getByRole("button", { name: /下へ移動/ });
  await expect(downButtons.first()).toBeEnabled();
  await downButtons.first().click();
  await expect(page.getByRole("button", { name: /下へ移動/ }).nth(1)).toBeDisabled();
});

test("image-padding-text: 余白を追加しても元画像はリサイズされず、キャンバスだけ拡張される", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]); // 64x64

  await page.getByLabel("上", { exact: false }).first().fill("10");
  await page.getByLabel("下", { exact: false }).first().fill("20");
  await page.getByLabel("左", { exact: false }).first().fill("5");
  await page.getByLabel("右", { exact: false }).first().fill("5");

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(74); // 64 + 5(左) + 5(右)、元画像幅は変わらない
  expect(dims.height).toBe(94); // 64 + 10(上) + 20(下)
});

test("image-padding-text: 「4辺を同じ値にする」で上下左右へ一括反映できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  // 「4辺を同じ値にする」ボタンと同じ行にある数値入力を使う
  await page.getByRole("button", { name: "4辺を同じ値にする" }).locator("..").locator('input[type="number"]').fill("15");
  await page.getByRole("button", { name: "4辺を同じ値にする" }).click();

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(94); // 64 + 15 + 15
  expect(dims.height).toBe(94); // 64 + 15 + 15
});

test("image-padding-text: 背景色を白/黒/カスタムへ切り替えられる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  const blackButton = page.getByRole("button", { name: "黒" });
  await blackButton.click();
  await expect(blackButton).toHaveClass(/bg-blue-600/);
});

test("image-padding-text: 文字を入力し、サイズ・色・太字・複数行・配置を設定できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByPlaceholder("余白に表示する文字（複数行可）").fill("1行目\n2行目");
  await page.getByLabel("サイズ", { exact: false }).first().fill("18");
  await page.getByRole("button", { name: "太字" }).click();
  await page.getByRole("button", { name: "上", exact: true }).click(); // 配置する余白: 上
  await page.getByRole("button", { name: "始点(左/上)" }).click();

  await page.getByLabel("上", { exact: false }).first().fill("40"); // 上余白がないと文字が表示されないため

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-padding-text: 特定の画像だけ「文字なし」にできる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("この画像は文字なし").check();
  await expect(page.getByLabel("この画像は文字なし")).toBeChecked();
});

test("image-padding-text: 個別設定に切り替えると共通設定と独立して変更できる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const toggle = page.getByRole("button", { name: /共通設定を使用中|個別設定を使用中/ });
  await expect(toggle).toHaveText("共通設定を使用中");
  await toggle.click();
  await expect(toggle).toHaveText("個別設定を使用中");

  // 個別設定パネルが表示され、2つ目の「上」余白入力が増えることを確認
  await expect(page.getByLabel("上", { exact: false })).toHaveCount(2);
});

test("image-padding-text: 共通設定を変更しても個別設定した画像の値は維持される", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  // 1枚目を個別設定にし、上余白を100にする
  await page.getByRole("button", { name: "共通設定を使用中" }).click();
  const individualTopInput = page.getByLabel("上", { exact: false }).nth(1);
  await individualTopInput.fill("100");

  // 共通設定（1つ目の「上」入力）を変更しても、個別設定側の値は変わらない
  await page.getByLabel("上", { exact: false }).first().fill("5");
  await expect(individualTopInput).toHaveValue("100");
});

test("image-padding-text: PNGで書き出せる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-padding-text: JPEGで書き出せる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "JPEG", exact: true }).click();
  await page.getByRole("button", { name: "この画像だけ保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
});

test("image-padding-text: 複数画像を一括出力するとZIPになる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  await page.getByRole("button", { name: "2件を一括出力" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ZIPをダウンロード");
  await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
});

test("image-padding-text: 画像1枚を一括出力するとZIPにならず直接ダウンロードされる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "1件を一括出力" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  // format:"png"のマジックバイト検証が通ること自体が、ZIP化されていない
  // （PK\x03\x04ではなくPNGシグネチャそのままである）ことの確認になる。
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("image-padding-text: 未対応ファイル（txt）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.txt]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-padding-text: 破損した画像ファイルが混ざるとエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.corruptedImage]);

  await page.getByRole("button", { name: "2件を一括出力" }).click();
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-padding-text: ファイル未選択時は出力操作が表示されない", async ({ page }) => {
  await page.goto("/tools/image-padding-text");
  await expect(page.getByRole("button", { name: "この画像だけ保存" })).toHaveCount(0);
  await expect(page.getByText(/件を一括出力/)).toHaveCount(0);
});

test("image-padding-text: モバイル幅(375px)でも横スクロールが発生せず主要要素が操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/tools/image-padding-text");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await expect(page.getByRole("button", { name: "次へ →" })).toBeVisible();
  await expect(page.getByRole("button", { name: "この画像だけ保存" })).toBeVisible();
  await expect(page.getByText(/件を一括出力/)).toBeVisible();
});
