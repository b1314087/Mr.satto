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

  // フォントサイズのバー(スライダー)
  const sizeSlider = page.getByRole("slider", { name: "フォントサイズ", exact: true });
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

// ---------------------------------------------------------------------------
// X/Y のバーと文字の色（次期機能追加 6）
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";

/** 画像の中で、赤っぽい画素（文字）の重心を 0〜1 で返す */
function redCentroid(file: string, bg: "gray" | "white" = "gray"): { x: number; y: number; count: number } {
  const out = execFileSync("python3", ["-c", `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert("RGB")
w, h = im.size
px = im.load()
sx = sy = n = 0
for y in range(h):
    for x in range(w):
        r, g, b = px[x, y]
        if r - g > 50 and r - b > 50:
            sx += x; sy += y; n += 1
print(json.dumps({"x": sx / n / w if n else -1, "y": sy / n / h if n else -1, "count": n}))
`, file], { encoding: "utf8" });
  void bg;
  return JSON.parse(out);
}

function grayPng(file: string, w: number, h: number) {
  execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nImage.new('RGB',(int(sys.argv[2]),int(sys.argv[3])),(128,128,128)).save(sys.argv[1])", file, String(w), String(h)]);
}

test("image-watermark: 横・縦の位置（X/Y）のバーと文字の色を変えると、プレビューにすぐ出て、書き出した画像も同じ位置・同じ色になる", async ({ page }) => {
  test.setTimeout(90_000);
  const src = test.info().outputPath("gray.png");
  grayPng(src, 400, 300);
  await page.goto("/tools/image-watermark");
  await uploadFixture(page, src);
  await expect(page.getByTestId("watermark-preview")).toBeVisible({ timeout: 20_000 });
  // 既定は白。いまの値が見える
  await expect(page.getByTestId("watermark-color-value")).toContainText(/#ffffff/i);
  await page.getByLabel("不透明度の数値").fill("100");
  await page.getByLabel("不透明度の数値").blur();
  await page.getByLabel("フォントサイズの数値").fill("40");
  await page.getByLabel("フォントサイズの数値").blur();
  const before = await previewDataUrl(page);
  await page.getByTestId("watermark-color-赤").click();
  await expect(page.getByTestId("watermark-color-赤")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => await previewDataUrl(page), { timeout: 10_000 }).not.toBe(before);
  // バー：数値もいっしょに変わり、プリセットの位置から「バーで決めた位置」に切り替わる
  const afterColor = await previewDataUrl(page);
  await page.getByLabel("横の位置（X）の数値").fill("25");
  await page.getByLabel("横の位置（X）の数値").blur();
  await page.getByLabel("縦の位置（Y）の数値").fill("20");
  await page.getByLabel("縦の位置（Y）の数値").blur();
  await expect(page.getByTestId("watermark-custom-position")).toBeVisible();
  await expect.poll(async () => await previewDataUrl(page), { timeout: 10_000 }).not.toBe(afterColor);
  await expect(page.getByTestId("watermark-xy").getByRole("slider").first()).toHaveValue("25");

  await page.getByRole("button", { name: "透かしを追加する" }).click();
  await waitForSuccess(page, "完了");
  const out = test.info().outputPath("wm.png");
  await (await clickAndDownload(page, "ダウンロード")).saveAs(out);
  const c = redCentroid(out);
  expect(c.count).toBeGreaterThan(100);
  // 文字の形で重心は少しずれるので、幅・高さの6%以内
  expect(Math.abs(c.x - 0.25)).toBeLessThan(0.06);
  expect(Math.abs(c.y - 0.2)).toBeLessThan(0.06);

  // プリセットの位置を押すと、バーの位置は解除される
  await page.keyboard.press("Escape");
  await page.getByTestId("watermark-position").getByRole("button").first().click();
  await expect(page.getByTestId("watermark-custom-position")).toHaveCount(0);
});
