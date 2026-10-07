import type { Locator } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile, getPngDimensions } from "../helpers/tool-runner";
import { decodePng } from "../helpers/png-inspect";

/**
 * 画像モザイクツール（Mr.Satto 次工程フェーズ Step 8）のE2Eテスト。
 *
 * sample.png/sample.jpg は64x64、青(#1d4ed8)背景の中央に白(#ffffff)32x32の
 * 正方形((16,16)-(48,48))が配置された既知の画像（tests/global-setup.ts参照）。
 * この既知の色境界を利用し、「モザイク・ぼかしが実際に指定範囲へ焼き込まれているか」
 * 「範囲外のピクセルは変化していないか」を、ダウンロードしたPNGを実際にデコードして
 * 数値で検証する（tests/helpers/png-inspect.ts を再利用。新規デコーダーは作らない）。
 *
 * ズーム・画面サイズ変更後も範囲の元画像ピクセル座標が変化しないこと
 * （開発指示書22・23・39章、最重要要件）も直接検証する。
 */

async function setRangeValue(locator: Locator, value: number) {
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("image-mosaic: ページが表示され、画像をアップロードすると編集UIが出る", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await expect(page.getByRole("heading", { name: "画像モザイク" })).toBeVisible();
  await expect(page.getByRole("button", { name: "＋ 範囲を追加" })).toHaveCount(0);

  await uploadFixture(page, [fixtures.png]);

  await expect(page.getByRole("button", { name: "＋ 範囲を追加" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PNGで保存" })).toBeVisible();
  await expect(page.getByRole("button", { name: "JPEGで保存" })).toBeVisible();
});

test("image-mosaic: 非画像ファイル（txt）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.txt]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-mosaic: 破損した画像ファイルはエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.corruptedImage]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-mosaic: 範囲を追加するとデフォルトでモザイク・選択状態になる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await expect(page.getByText("1個の範囲")).toBeVisible();
  await expect(page.getByText("選択中の範囲の設定")).toBeVisible();
  await expect(page.getByRole("button", { name: "モザイク", exact: true })).toHaveClass(/bg-blue-600/);
});

test("image-mosaic: 複数の範囲を追加でき、個別に削除できる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await expect(page.getByText("3個の範囲")).toBeVisible();

  await page.getByRole("button", { name: "この範囲を削除" }).click();
  await expect(page.getByText("2個の範囲")).toBeVisible();
});

test("image-mosaic: 種類をぼかしへ変更できる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();

  await page.getByRole("button", { name: "ぼかし", exact: true }).click();
  await expect(page.getByRole("button", { name: "ぼかし", exact: true })).toHaveClass(/bg-blue-600/);
  await expect(page.getByText("1: ぼかし")).toBeVisible();
});

test("image-mosaic: 強度スライダーで強度を変更できる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();

  const slider = page.getByLabel("モザイク・ぼかしの強度");
  await setRangeValue(slider, 9);
  await expect(page.getByText("強度: 9")).toBeVisible();
});

test("image-mosaic: 数値入力で範囲の位置・サイズを直接指定できる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();

  await page.getByLabel("X(px)").fill("10");
  await page.getByLabel("Y(px)").fill("20");
  await page.getByLabel("幅(px)").fill("80");
  await page.getByLabel("高さ(px)").fill("50");

  await expect(page.getByLabel("X(px)")).toHaveValue("10");
  await expect(page.getByLabel("Y(px)")).toHaveValue("20");
  await expect(page.getByLabel("幅(px)")).toHaveValue("80");
  await expect(page.getByLabel("高さ(px)")).toHaveValue("50");
});

test("image-mosaic: ドラッグで範囲を移動できる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]); // 300x200、既定100%表示

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  const xBefore = Number(await page.getByLabel("X(px)").inputValue());
  const yBefore = Number(await page.getByLabel("Y(px)").inputValue());

  const region = page.locator('[aria-label^="モザイクの範囲"]').first();
  const box = await region.boundingBox();
  if (!box) throw new Error("範囲の座標が取得できませんでした");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 5 });
  await page.mouse.up();

  const xAfter = Number(await page.getByLabel("X(px)").inputValue());
  const yAfter = Number(await page.getByLabel("Y(px)").inputValue());
  expect(xAfter).toBeGreaterThan(xBefore + 15);
  expect(yAfter).toBeGreaterThan(yBefore + 10);
});

test("image-mosaic: ハンドルドラッグで範囲をリサイズできる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  const wBefore = Number(await page.getByLabel("幅(px)").inputValue());
  const hBefore = Number(await page.getByLabel("高さ(px)").inputValue());

  const handle = page.getByLabel("範囲のse角をドラッグしてサイズ変更");
  const box = await handle.boundingBox();
  if (!box) throw new Error("ハンドルの座標が取得できませんでした");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 25, cy + 25, { steps: 5 });
  await page.mouse.up();

  const wAfter = Number(await page.getByLabel("幅(px)").inputValue());
  const hAfter = Number(await page.getByLabel("高さ(px)").inputValue());
  expect(wAfter).toBeGreaterThan(wBefore + 10);
  expect(hAfter).toBeGreaterThan(hBefore + 10);
});

test("image-mosaic: 「編集をリセット」で全範囲が削除される", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await expect(page.getByText("2個の範囲")).toBeVisible();

  await page.getByRole("button", { name: "編集をリセット" }).click();
  await expect(page.getByText("0個の範囲")).toBeVisible();
  await expect(page.getByText("選択中の範囲の設定")).toHaveCount(0);
});

test("image-mosaic: ズームしても範囲の元画像座標（X/Y入力値）は変化しない", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]);
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();

  const xBefore = await page.getByLabel("X(px)").inputValue();
  const yBefore = await page.getByLabel("Y(px)").inputValue();
  const wBefore = await page.getByLabel("幅(px)").inputValue();

  await page.getByRole("button", { name: "200%", exact: true }).click();
  await expect(page.getByTestId("zoom-percent-display")).toHaveText("200%");

  expect(await page.getByLabel("X(px)").inputValue()).toBe(xBefore);
  expect(await page.getByLabel("Y(px)").inputValue()).toBe(yBefore);
  expect(await page.getByLabel("幅(px)").inputValue()).toBe(wBefore);

  await page.getByRole("button", { name: "100%", exact: true }).click();
  expect(await page.getByLabel("X(px)").inputValue()).toBe(xBefore);
});

test("image-mosaic: 画面サイズを変更しても範囲の座標は維持される", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await page.setViewportSize({ width: 1000, height: 800 });
  await uploadFixture(page, [fixtures.landscapeJpg]);
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();

  const xBefore = await page.getByLabel("X(px)").inputValue();
  const yBefore = await page.getByLabel("Y(px)").inputValue();

  await page.setViewportSize({ width: 500, height: 800 });
  await page.getByRole("button", { name: "画面に合わせる" }).click();

  expect(await page.getByLabel("X(px)").inputValue()).toBe(xBefore);
  expect(await page.getByLabel("Y(px)").inputValue()).toBe(yBefore);
});

test("image-mosaic: PNGで保存すると元画像と同じピクセル寸法で出力される", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.landscapeJpg]); // 300x200

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(300);
  expect(dims.height).toBe(200);
});

test("image-mosaic: JPEGで保存できる", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await page.getByRole("button", { name: "JPEGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "jpg", minBytes: 10 });
});

test("image-mosaic: 範囲を指定しない場合は元画像のまま出力される", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });
  const fs = await import("node:fs");
  const dims = getPngDimensions(fs.readFileSync(path));
  expect(dims.width).toBe(64);
  expect(dims.height).toBe(64);
});

test("image-mosaic: モザイクが実際に指定範囲へ焼き込まれ、範囲外は変化しない（ピクセル検証）", async ({ page }) => {
  // sample.png: 64x64、青(#1d4ed8)背景 + 中央に白32x32((16,16)-(48,48))の既知の画像。
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  // 青(8,8)〜白(24,24)の境界をまたぐ16x16範囲。強度10(ブロックサイズ44>16)で
  // 範囲全体が単色に潰れることを利用し、モザイク適用を数値で確認する。
  await page.getByLabel("X(px)").fill("8");
  await page.getByLabel("Y(px)").fill("8");
  await page.getByLabel("幅(px)").fill("16");
  await page.getByLabel("高さ(px)").fill("16");
  await setRangeValue(page.getByLabel("モザイク・ぼかしの強度"), 10);

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });

  const decoded = decodePng(path);
  const at = (x: number, y: number) => {
    const i = (y * decoded.width + x) * 4;
    return [decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]];
  };

  // 範囲内: 元は青寄り(10,10)と白寄り(20,20)だったが、モザイク後は同一色になっているはず
  const blueCorner = at(10, 10);
  const whiteCorner = at(20, 20);
  expect(blueCorner).toEqual(whiteCorner);

  // 範囲外: 元の青背景がそのまま残っているはず(#1d4ed8 = 29,78,216)
  const untouched = at(60, 60);
  expect(untouched).toEqual([29, 78, 216]);
});

test("image-mosaic: ぼかしが境界を滑らかにする（ピクセル検証）", async ({ page }) => {
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();
  await page.getByRole("button", { name: "ぼかし", exact: true }).click();
  // 青/白境界(x=16)をまたぐ範囲(4,16)-(28,48)を、境界から離れた場所ではなく
  // 内部に含める形で指定する。
  await page.getByLabel("X(px)").fill("4");
  await page.getByLabel("Y(px)").fill("16");
  await page.getByLabel("幅(px)").fill("24");
  await page.getByLabel("高さ(px)").fill("32");
  await setRangeValue(page.getByLabel("モザイク・ぼかしの強度"), 8);

  await page.getByRole("button", { name: "PNGで保存" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "ダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 10 });

  const decoded = decodePng(path);
  const i = (32 * decoded.width + 14) * 4; // 境界(x=16)から2px青側、範囲の内部
  const r = decoded.data[i];
  const g = decoded.data[i + 1];
  const b = decoded.data[i + 2];

  // 純粋な青(29,78,216)とも純粋な白(255,255,255)とも異なる中間色になっているはず
  const isPureBlue = r === 29 && g === 78 && b === 216;
  const isPureWhite = r === 255 && g === 255 && b === 255;
  expect(isPureBlue || isPureWhite).toBe(false);
  // 白に近づく方向へ変化しているはず（ぼかしで白が混ざる）
  expect(r).toBeGreaterThan(29);
});

test("image-mosaic: モバイル幅(375px)でも横スクロールが発生せず主要要素が操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/tools/image-mosaic");
  await uploadFixture(page, [fixtures.png]);
  await page.getByRole("button", { name: "＋ 範囲を追加" }).click();

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await expect(page.getByRole("button", { name: "＋ 範囲を追加" })).toBeVisible();
  await expect(page.getByText("選択中の範囲の設定")).toBeVisible();
  await expect(page.getByRole("button", { name: "PNGで保存" })).toBeVisible();
  await expect(page.getByRole("button", { name: "JPEGで保存" })).toBeVisible();
});
