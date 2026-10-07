import { unzipSync } from "fflate";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile, getPngDimensions } from "../helpers/tool-runner";
import { computeTileBoundaries } from "@/lib/processors/browser/image-tile-split";

/**
 * 画像タイル分割ツール（Mr.Satto 次工程フェーズ Step 7）のE2Eテスト。
 *
 * 正常系（プリセット・カスタム行列・非正方形分割）、境界（1×1・1×N・N×1・
 * 端数が出る画像サイズ）、異常系（空入力・非画像・破損画像・行列0・上限超過）、
 * 出力（PNG/JPEG/ZIP/連番ファイル名）、モバイル表示、そして最も重要な
 * 「分割結果に欠損・重複がないこと」をZIPを展開して実際のタイル寸法を
 * 数値検証することで確認する（開発指示書30章）。
 *
 * sample.png/sample.jpgは64x64の正方形、landscapeJpgは300x200（3分割で
 * 端数が出るサイズ）、portraitPngは120x200。
 */

test("image-tile-split: ページが表示され、画像をアップロードすると設定UIが出る", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await expect(page.getByRole("heading", { name: "画像タイル分割" })).toBeVisible();

  await uploadFixture(page, [fixtures.png]);

  await expect(page.getByText("分割方法")).toBeVisible();
  await expect(page.getByRole("button", { name: "3×3" })).toBeVisible();
  await expect(page.getByText("合計9枚に分割")).toBeVisible();
});

test("image-tile-split: プリセット（2×2・4×4）を切り替えられる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  const preset2x2 = page.getByRole("button", { name: "2×2" });
  await preset2x2.click();
  await expect(preset2x2).toHaveClass(/bg-blue-600/);
  await expect(page.getByText("合計4枚に分割")).toBeVisible();

  const preset4x4 = page.getByRole("button", { name: "4×4" });
  await preset4x4.click();
  await expect(preset4x4).toHaveClass(/bg-blue-600/);
  await expect(page.getByText("合計16枚に分割")).toBeVisible();
});

test("image-tile-split: 行・列を自由に指定できる（非正方形の分割）", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.landscapeJpg]);

  await page.getByLabel("行").fill("2");
  await page.getByLabel("列").fill("5");

  await expect(page.getByText("合計10枚に分割")).toBeVisible();
});

test("image-tile-split: 分割してZIPをダウンロードでき、ファイル名が連番になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "9枚に分割する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ZIPをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });

  const fs = await import("node:fs");
  const zip = unzipSync(fs.readFileSync(path));
  const names = Object.keys(zip).sort();
  expect(names).toEqual([
    "sample_01.png",
    "sample_02.png",
    "sample_03.png",
    "sample_04.png",
    "sample_05.png",
    "sample_06.png",
    "sample_07.png",
    "sample_08.png",
    "sample_09.png",
  ]);
});

test("image-tile-split: 分割結果に欠損・重複がなく、元画像領域を正確に再現できる（3×3・正方形）", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]); // 64x64

  await page.getByRole("button", { name: "3×3" }).click();
  await page.getByRole("button", { name: "9枚に分割する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ZIPをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });

  const fs = await import("node:fs");
  const zip = unzipSync(fs.readFileSync(path));

  const colB = computeTileBoundaries(64, 3);
  const rowB = computeTileBoundaries(64, 3);

  let index = 1;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const name = `sample_${String(index).padStart(2, "0")}.png`;
      const bytes = zip[name];
      expect(bytes, `${name} がZIPに含まれていること`).toBeTruthy();
      const dims = getPngDimensions(Buffer.from(bytes));
      expect(dims.width, `${name}の幅`).toBe(colB[c + 1] - colB[c]);
      expect(dims.height, `${name}の高さ`).toBe(rowB[r + 1] - rowB[r]);
      index++;
    }
  }

  // 各行の幅の合計・各列の高さの合計が元画像サイズと一致する = 欠損・重複がない
  expect(colB[3]).toBe(64);
  expect(rowB[3]).toBe(64);
});

test("image-tile-split: 端数が出る画像サイズでも欠損・重複なく分割できる（300×200を3×3）", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.landscapeJpg]); // 300x200、200/3は割り切れない

  await page.getByRole("button", { name: "3×3" }).click();
  await page.getByRole("button", { name: "9枚に分割する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ZIPをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });

  const fs = await import("node:fs");
  const zip = unzipSync(fs.readFileSync(path));
  const colB = computeTileBoundaries(300, 3);
  const rowB = computeTileBoundaries(200, 3);
  expect(colB[3]).toBe(300);
  expect(rowB[3]).toBe(200);

  let index = 1;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const name = `landscape_${String(index).padStart(2, "0")}.png`;
      const dims = getPngDimensions(Buffer.from(zip[name]));
      expect(dims.width).toBe(colB[c + 1] - colB[c]);
      expect(dims.height).toBe(rowB[r + 1] - rowB[r]);
      index++;
    }
  }
});

test("image-tile-split: 1×1では分割せず元画像領域全体が1枚になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("行").fill("1");
  await page.getByLabel("列").fill("1");
  await page.getByRole("button", { name: "1枚に分割する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ZIPをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  const fs = await import("node:fs");
  const zip = unzipSync(fs.readFileSync(path));
  const dims = getPngDimensions(Buffer.from(zip["sample_01.png"]));
  expect(dims.width).toBe(64);
  expect(dims.height).toBe(64);
});

test("image-tile-split: 1×Nの横一列分割ができる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("行").fill("1");
  await page.getByLabel("列").fill("4");
  await expect(page.getByText("合計4枚に分割")).toBeVisible();
});

test("image-tile-split: N×1の縦一列分割ができる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("行").fill("4");
  await page.getByLabel("列").fill("1");
  await expect(page.getByText("合計4枚に分割")).toBeVisible();
});

test("image-tile-split: JPEGで書き出せる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByRole("button", { name: "JPEG", exact: true }).click();
  await page.getByRole("button", { name: "9枚に分割する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ZIPをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  const fs = await import("node:fs");
  const zip = unzipSync(fs.readFileSync(path));
  expect(Object.keys(zip)).toContain("sample_01.jpg");
});

test("image-tile-split: プレビューの番号表示をオフにできる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await expect(page.getByText("1", { exact: true })).toBeVisible();
  await page.getByLabel("プレビューに番号を表示する（出力画像には含まれません）").uncheck();
  await expect(page.getByText("1", { exact: true })).toHaveCount(0);
});

test("image-tile-split: 行数0はエラー表示になり、分割ボタンが無効になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("行").fill("0");
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
  await expect(page.getByRole("button", { name: /枚に分割する/ })).toBeDisabled();
});

test("image-tile-split: 列数0はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("列").fill("0");
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-tile-split: 上限を超える行数・列数はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("行").fill("50");
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-tile-split: 極端に多い分割数（行列とも上限内だが合計が多すぎる）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  await page.getByLabel("行").fill("20");
  await page.getByLabel("列").fill("20");
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-tile-split: 未対応ファイル（txt）はエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.txt]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-tile-split: 破損した画像ファイルはエラー表示になる", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.corruptedImage]);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
});

test("image-tile-split: ファイル未選択時は分割操作が表示されない", async ({ page }) => {
  await page.goto("/tools/image-tile-split");
  await expect(page.getByRole("button", { name: /枚に分割する/ })).toHaveCount(0);
});

test("image-tile-split: モバイル幅(375px)でも横スクロールが発生せず主要要素が操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/tools/image-tile-split");
  await uploadFixture(page, [fixtures.png]);

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

  await expect(page.getByRole("button", { name: "3×3" })).toBeVisible();
  await expect(page.getByRole("button", { name: "9枚に分割する" })).toBeVisible();
});
