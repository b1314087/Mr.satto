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
  await page.getByRole("button", { name: /^pdf$/i }).click();
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

test("image-layout: 写真をほかの写真の真ん中へドラッグして離すと、2枚が入れ替わる（枠はそのまま）。端で離したときは入れ替わらない（2026-11）", async ({ page }) => {
  await page.goto("/tools/image-layout");
  await uploadFixture(page, [fixtures.png, fixtures.jpg]);
  const imgs = page.getByTestId("whiteboard-image-item");
  await expect(imgs).toHaveCount(2);
  const a = imgs.nth(0);
  const b = imgs.nth(1);
  await a.scrollIntoViewIfNeeded();
  // 追加した直後は少しずつずれて重なっているので、上にある2つ目を右へ離して置く
  const b0 = (await b.boundingBox())!;
  await page.mouse.move(b0.x + b0.width - 8, b0.y + b0.height - 8);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width - 8 + 160, b0.y + b0.height - 8, { steps: 6 });
  await page.mouse.up();
  const ia = await a.getAttribute("data-image-index");
  const ib = await b.getAttribute("data-image-index");
  expect(ia).not.toBe(ib);
  const boxA = (await a.boundingBox())!;
  const boxB = (await b.boundingBox())!;

  // 1つ目を、2つ目の真ん中へドラッグ → ドラッグ中は2つ目に黄色い枠、離すと入れ替わる
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2, { steps: 8 });
  await expect(b).toHaveAttribute("data-swap-target", "true");
  await page.mouse.up();
  await expect(a).toHaveAttribute("data-image-index", ib!);
  await expect(b).toHaveAttribute("data-image-index", ia!);
  await expect(page.locator('[data-swap-target="true"]')).toHaveCount(0);
  // 枠の場所は元のまま
  const afterA = (await a.boundingBox())!;
  expect(Math.abs(afterA.x - boxA.x)).toBeLessThan(2);
  expect(Math.abs(afterA.y - boxA.y)).toBeLessThan(2);

  // 2つ目の端のあたりで離すと、入れ替わらずに重ねて置ける
  const boxB2 = (await b.boundingBox())!;
  await page.mouse.move(afterA.x + afterA.width / 2, afterA.y + afterA.height / 2);
  await page.mouse.down();
  await page.mouse.move(boxB2.x + boxB2.width * 0.05, boxB2.y + boxB2.height * 0.05, { steps: 8 });
  await expect(page.locator('[data-swap-target="true"]')).toHaveCount(0);
  await page.mouse.up();
  await expect(a).toHaveAttribute("data-image-index", ib!);
  const moved = (await a.boundingBox())!;
  expect(Math.abs(moved.x - afterA.x)).toBeGreaterThan(10);
});
