import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * 動画サムネイル抽出（総合改修 13）：一時停止した位置のフレームだけを抽出する。
 * - 再生 → 一時停止した位置が「抽出するフレーム」に出る → 抽出した画像がその時点のもの
 * - 再生中に抽出ボタンを押すと、その位置で止めて抽出する
 * - 以前の「指定した時刻・一定の間隔・均等に」の取り出し方は無い
 */

let dir = "";
let video = "";

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "thumb-pause-"));
  video = path.join(dir, "clip.mp4");
  // 1秒ごとに色が変わる動画（0〜1秒：赤、1〜2秒：緑、2〜3秒：青、3〜4秒：白）
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:r=30:d=1",
    "-f", "lavfi", "-i", "color=c=green:s=320x240:r=30:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=30:d=1",
    "-f", "lavfi", "-i", "color=c=white:s=320x240:r=30:d=1",
    "-filter_complex", "[0][1][2][3]concat=n=4:v=1:a=0",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video,
  ]);
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

async function pauseAt(page: Page, sec: number) {
  await page.getByTestId("thumb-video").evaluate(async (el: HTMLVideoElement, t) => {
    if (el.readyState < 2) await new Promise((r) => el.addEventListener("loadeddata", r, { once: true }));
    el.pause();
    el.currentTime = t;
    await new Promise((r) => el.addEventListener("seeked", r, { once: true }));
  }, sec);
}

/** PNGの真ん中の色 */
function centerColor(file: string): [number, number, number] {
  return JSON.parse(
    execFileSync("python3", ["-c", "import sys,json\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB')\nprint(json.dumps(im.getpixel((im.width//2, im.height//2))))", file], { encoding: "utf8" })
  );
}

test("一時停止した位置（2.5秒＝青）のフレームがプレビューに出て、抽出した画像もその位置のフレームになる", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/video-thumbnail");
  await uploadFixture(page, video);
  // 以前の取り出し方（指定した時刻・一定の間隔・均等に）は無い
  await expect(page.getByText("一定の間隔")).toHaveCount(0);
  await expect(page.getByText("均等に")).toHaveCount(0);
  await expect(page.getByTestId("thumb-video")).toBeVisible();
  await pauseAt(page, 2.5);
  await expect(page.getByTestId("thumb-paused-at")).toContainText("0:02.5");
  // プレビューのキャンバスに、止めた位置のフレーム（青）が描かれている
  const rgb = await page.getByTestId("thumb-paused-frame").evaluate((c: HTMLCanvasElement) => Array.from(c.getContext("2d")!.getImageData(c.width / 2, c.height / 2, 1, 1).data.slice(0, 3)));
  expect(rgb[2]).toBeGreaterThan(150);
  expect(rgb[0]).toBeLessThan(80);

  await page.getByRole("button", { name: "一時停止した位置を抽出する" }).click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("thumb-result-time")).toContainText("0:02.5");
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "画像をダウンロード" }).click();
  const dl = await wait;
  expect(dl.suggestedFilename()).toBe("clip-thumbnail.png");
  const out = test.info().outputPath("thumb.png");
  await dl.saveAs(out);
  const [r, g, b] = centerColor(out);
  expect(b).toBeGreaterThan(150);
  expect(r).toBeLessThan(80);
  expect(g).toBeLessThan(80);
});

test("再生中に抽出ボタンを押すと、その位置で一時停止して抽出する", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/tools/video-thumbnail");
  await uploadFixture(page, video);
  await page.getByTestId("thumb-video").evaluate(async (el: HTMLVideoElement) => {
    if (el.readyState < 2) await new Promise((r) => el.addEventListener("loadeddata", r, { once: true }));
    el.muted = true;
    await el.play();
  });
  await expect(page.getByTestId("thumb-playing-note")).toBeVisible();
  await page.getByRole("button", { name: "一時停止した位置を抽出する" }).click();
  await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
  expect(await page.getByTestId("thumb-video").evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
  await expect(page.getByTestId("thumb-playing-note")).toHaveCount(0);
});
