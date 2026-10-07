import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 証明写真サイズ変換ツール（Mr.Satto 次工程フェーズ Step 4）のE2Eテスト。
 * 正常系（プリセット/カスタムサイズ・トリミング操作・画像出力・A4 PDF出力）、
 * 異常系（未対応ファイル・破損ファイル・不正なサイズ）、モバイル表示を検証する。
 */

test("passport-photo: ページが表示され、画像をアップロードするとサイズ選択・トリミングUIが出る", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await expect(page.getByRole("heading", { name: "証明写真サイズ変換" })).toBeVisible();

  await uploadFixture(page, [fixtures.jpg]);

  await expect(page.getByText("証明写真サイズ")).toBeVisible();
  await expect(page.getByRole("button", { name: "35×45mm" })).toBeVisible();
  await expect(page.getByText("トリミング・位置調整")).toBeVisible();
});

test("passport-photo: プリセットサイズを切り替えられる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  const preset30x40 = page.getByRole("button", { name: "30×40mm" });
  await preset30x40.click();
  await expect(preset30x40).toHaveClass(/border-blue-500/);
});

test("passport-photo: カスタムサイズを指定できる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  await page.getByRole("button", { name: "カスタム" }).click();
  const widthInput = page.getByLabel("幅 (mm)");
  const heightInput = page.getByLabel("高さ (mm)");
  await widthInput.fill("50");
  await heightInput.fill("70");

  await expect(page.getByText("出力サイズ: 50 × 70mm")).toBeVisible();
});

test("passport-photo: トリミング枠をドラッグして移動できる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  const box = page.locator(".cursor-move");
  await expect(box).toBeVisible();
  const before = await box.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2 + 20, before!.y + before!.height / 2 + 10);
  await page.mouse.up();

  const after = await box.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.x).not.toBeCloseTo(before!.x, 0);
});

test("passport-photo: 拡大/縮小ボタンでズームできる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  const box = page.locator(".cursor-move");
  const before = await box.boundingBox();
  await page.getByRole("button", { name: "縮小 −" }).click();
  const after = await box.boundingBox();
  expect(after!.width).toBeLessThan(before!.width);
});

test("passport-photo: JPEGで証明写真を書き出せる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  await page.getByRole("button", { name: "画像を書き出す" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
});

test("passport-photo: PNGで証明写真を書き出せる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  await page.getByRole("button", { name: "PNG", exact: true }).click();
  await page.getByRole("button", { name: "画像を書き出す" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("passport-photo: 横長写真でも証明写真比率にトリミングしてA4にPDF配置できる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
});

test("passport-photo: 用紙・余白を変更すると最大枚数の表示が更新される", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  const marginInput = page.getByLabel(/余白 \(mm\)/);
  const before = await page.getByText(/枚数（最大\d+枚）/).textContent();
  await marginInput.fill("50");
  await expect(page.getByText(/枚数（最大\d+枚）/)).not.toHaveText(before ?? "");
});

test("passport-photo: 未対応ファイル（txt）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.txt]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("passport-photo: 破損した画像ファイルはエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.corruptedImage]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("passport-photo: 不正なカスタムサイズ（0mm）はエラー表示になり、出力ボタンが無効", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  await page.getByRole("button", { name: "カスタム" }).click();
  await page.getByLabel("幅 (mm)").fill("0");

  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
  await expect(page.getByRole("button", { name: "画像を書き出す" })).toHaveCount(0);
});

test("passport-photo: 極端に大きいカスタムサイズはエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  await page.getByRole("button", { name: "カスタム" }).click();
  await page.getByLabel("幅 (mm)").fill("9999");

  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("passport-photo: ファイル未選択時は出力操作が表示されない", async ({ page }) => {
  await page.goto("/tools/image-passport-photo");
  await expect(page.getByRole("button", { name: "画像を書き出す" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PDFを書き出す" })).toHaveCount(0);
});

test("passport-photo: モバイル幅(375px)でも横スクロールが発生せず主要要素が操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/tools/image-passport-photo");
  await uploadFixture(page, [fixtures.jpg]);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await expect(page.getByRole("button", { name: "画像を書き出す" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PDFを書き出す" })).toBeVisible();
});
