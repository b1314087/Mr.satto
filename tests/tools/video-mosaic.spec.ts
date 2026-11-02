import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { assertDownloadedFile, clickAndDownload } from "../helpers/tool-runner";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { boxAt, setKeyframe, type MosaicRegion } from "@/lib/video/mosaic-regions";

/**
 * 動画モザイク（video-mosaic・Stage 5）のテスト。
 * テスト用の動画は、ffmpeg で、模様のある正方形（40×40）が一定の速さで動く3秒のWebM（音声付き）を作る。
 * 正方形の位置は x = 20 + 60t、y = 60 + 20t（t は秒）なので、追跡の結果を正解と比べられる。
 */

const W = 320;
const H = 240;
const objAt = (t: number) => ({ x: 20 + 60 * t, y: 60 + 20 * t, w: 40, h: 40 });

let dir: string;
let videoPath: string;

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-mosaic-"));
  videoPath = path.join(dir, "moving.webm");
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `color=c=0x336699:s=${W}x${H}:r=30:d=3`,
      "-f", "lavfi", "-i", "testsrc=s=40x40:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[0][1]overlay=x='20+t*60':y='60+t*20'[v]",
      "-map", "[v]", "-map", "2:a",
      "-c:v", "libvpx", "-b:v", "2M", "-c:a", "libopus", "-shortest",
      videoPath,
    ],
    { stdio: "ignore" }
  );
});

test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 規則（範囲の位置）
// ---------------------------------------------------------------------------

plainTest("範囲の位置：固定はいつも同じ。追跡は結果を使い、手で直した位置を優先する。追跡前は手で決めた位置の間を直線でつなぐ", () => {
  const base: MosaicRegion = { id: "a", mode: "fixed", kind: "mosaic", level: 5, box: { x: 10, y: 10, w: 20, h: 20 }, keyframes: [], track: [], from: null, to: null };
  plainExpect(boxAt(base, 2)).toEqual(base.box);
  let r: MosaicRegion = { ...base, mode: "track" };
  r = setKeyframe(r, 0, { x: 0, y: 0, w: 10, h: 10 });
  r = setKeyframe(r, 2, { x: 100, y: 50, w: 10, h: 10 });
  plainExpect(boxAt(r, 1)).toEqual({ x: 50, y: 25, w: 10, h: 10 });
  r = { ...r, track: [0, 1 / 30, 2 / 30].map((t, i) => ({ t, x: i * 3, y: 0, w: 10, h: 10, score: 0.9 })) };
  plainExpect(boxAt(r, 1 / 30).x).toBeCloseTo(3);
  plainExpect(boxAt(r, 0)).toMatchObject({ x: 0, y: 0 });
});

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

async function openWithVideo(page: Page) {
  await page.goto("/tools/video-mosaic");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("main input[type=file]");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
  await page.locator("main input[type=file]").first().setInputFiles(videoPath);
  await expect(page.getByTestId("vm-stage")).toHaveAttribute("data-video-width", String(W), { timeout: 30_000 });
  await expect(page.getByTestId("vm-time")).toContainText("/ 0:03");
}

async function toScreen(page: Page, x: number, y: number) {
  const b = (await page.getByTestId("vm-stage").boundingBox())!;
  return { x: b.x + (x / W) * b.width, y: b.y + (y / H) * b.height };
}

async function dragVideo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  // 動画の全体が画面に入るようにしてから操作する（固定のヘッダーの下を押さないため）
  await page.getByTestId("vm-stage").evaluate((el) => el.scrollIntoView({ block: "center" }));
  const a = await toScreen(page, from.x, from.y);
  const b = await toScreen(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

async function boxOf(page: Page, index = 0) {
  const v = await page.getByTestId("vm-box").nth(index).getAttribute("data-box");
  const [x, y, w, h] = v!.split(",").map(Number);
  return { x, y, w, h };
}

async function seekTo(page: Page, t: number) {
  await page.getByTestId("vm-seek").fill(String(t));
  await expect(page.getByTestId("vm-time")).toContainText(`0:0${Math.floor(t)}.`);
  await page.waitForTimeout(150);
}

function near(a: number, b: number, tol: number) {
  plainExpect(Math.abs(a - b), `${a} と ${b}`).toBeLessThanOrEqual(tol);
}

test("video-mosaic: 動画の上をドラッグして範囲を指定でき、元の動画の座標で持つ。表示サイズを変えてもずれない。移動・大きさの変更・削除ができる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWithVideo(page);
  await dragVideo(page, { x: 20, y: 60 }, { x: 60, y: 100 });
  await expect(page.getByTestId("vm-box")).toHaveCount(1);
  const b1 = await boxOf(page);
  near(b1.x, 20, 2);
  near(b1.y, 60, 2);
  near(b1.w, 40, 2);
  near(b1.h, 40, 2);

  // 表示を小さくしても、元の動画の座標は変わらず、画面上の位置も同じ所を指す
  await page.setViewportSize({ width: 520, height: 900 });
  await page.waitForTimeout(300);
  plainExpect(await boxOf(page)).toEqual(b1);
  const stage = (await page.getByTestId("vm-stage").boundingBox())!;
  const el = (await page.getByTestId("vm-box").boundingBox())!;
  near(el.x - stage.x, (b1.x / W) * stage.width - 2, 3);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);

  // 移動
  await dragVideo(page, { x: 40, y: 80 }, { x: 70, y: 90 });
  const moved = await boxOf(page);
  near(moved.x, 50, 2);
  near(moved.y, 70, 2);
  // 大きさの変更（右下の角）
  const handle = (await page.getByTestId("vm-handle-se").boundingBox())!;
  const target = await toScreen(page, moved.x + moved.w + 20, moved.y + moved.h + 10);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.up();
  const resized = await boxOf(page);
  near(resized.w, 60, 3);
  near(resized.h, 50, 3);
  // 動画は枠いっぱいに表示される（右に黒い帯が出ない）
  const sizes = await page.evaluate(() => {
    const st = document.querySelector('[data-testid="vm-stage"]')!.getBoundingClientRect();
    const v = document.querySelector('[data-testid="vm-video"]')!.getBoundingClientRect();
    return [st.width, v.width];
  });
  near(sizes[1], sizes[0], 1);
  // 削除
  await page.getByTestId("vm-delete").click();
  await expect(page.getByTestId("vm-box")).toHaveCount(0);
});

test("video-mosaic: 追跡すると、範囲が対象の動きに付いていく（前へも後ろへも）。固定にすると動かない", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWithVideo(page);
  await seekTo(page, 1);
  const o1 = objAt(1);
  await dragVideo(page, { x: o1.x, y: o1.y }, { x: o1.x + o1.w, y: o1.y + o1.h });
  await page.getByTestId("vm-track").click();
  await expect(page.getByTestId("vm-track-note")).toContainText("追跡しました", { timeout: 120_000 });
  await expect(page.getByTestId("vm-timeline")).toBeVisible();
  for (const t of [2, 2.8, 0.3]) {
    await seekTo(page, t);
    const b = await boxOf(page);
    const o = objAt(t);
    near(b.x, o.x, 6);
    near(b.y, o.y, 6);
  }
  // 固定にすると、どの時刻でも同じ位置
  await seekTo(page, 1);
  await page.getByTestId("vm-mode-fixed").click();
  const fixed = await boxOf(page);
  await seekTo(page, 2.5);
  plainExpect(await boxOf(page)).toEqual(fixed);
});

test("video-mosaic: 追跡のあと、位置を手で直すと、その時刻は直した位置になり、「ここから追跡し直す」で後ろにも反映される（前は変わらない）", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWithVideo(page);
  const o0 = objAt(0);
  await dragVideo(page, { x: o0.x, y: o0.y }, { x: o0.x + o0.w, y: o0.y + o0.h });
  await page.getByTestId("vm-track").click();
  await expect(page.getByTestId("vm-track-note")).toContainText("追跡しました", { timeout: 120_000 });
  await seekTo(page, 0.5);
  const before05 = await boxOf(page);

  // 1秒の所で、範囲を右下へ動かす（手で直す）
  await seekTo(page, 1);
  const cur = await boxOf(page);
  await dragVideo(page, { x: cur.x + 20, y: cur.y + 20 }, { x: cur.x + 20 + 60, y: cur.y + 20 + 50 });
  const fixedAt1 = await boxOf(page);
  near(fixedAt1.x, cur.x + 60, 3);
  near(fixedAt1.y, cur.y + 50, 3);
  await page.getByTestId("vm-retrack").click();
  await expect(page.getByTestId("vm-track-note")).toContainText(/追跡しました/, { timeout: 120_000 });
  // 直した位置から後ろを追跡し直したので、1.5秒の位置は、もとの追跡（対象の位置）から離れている
  await seekTo(page, 1.5);
  const after = await boxOf(page);
  plainExpect(Math.hypot(after.x - objAt(1.5).x, after.y - objAt(1.5).y)).toBeGreaterThan(25);
  // 前（0.5秒）は変わらない
  await seekTo(page, 0.5);
  plainExpect(await boxOf(page)).toEqual(before05);
});

function frameRgb(file: string, t: number): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 10 * 1024 * 1024 });
}

/** 2つのフレームの、範囲の中の画素の差の平均（モザイクがかかった所は大きく、かかっていない所は小さい） */
function diffIn(a: Buffer, b: Buffer, box: { x: number; y: number; w: number; h: number }): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.round(box.y); y < Math.round(box.y + box.h); y++) {
    for (let x = Math.round(box.x); x < Math.round(box.x + box.w); x++) {
      const i = (y * W + x) * 3;
      sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
      n++;
    }
  }
  return sum / n;
}

test("video-mosaic: 書き出した動画は、追跡に沿って対象にモザイクがかかり、音声・長さが残る。ファイルは外部に送信されない", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const recorder = new NetworkRecorder(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWithVideo(page);
  const o0 = objAt(0);
  await dragVideo(page, { x: o0.x - 2, y: o0.y - 2 }, { x: o0.x + o0.w + 2, y: o0.y + o0.h + 2 });
  await page.getByTestId("vm-track").click();
  await expect(page.getByTestId("vm-track-note")).toContainText("追跡しました", { timeout: 120_000 });
  await page.getByText("WebM", { exact: true }).click();
  await page.getByTestId("vm-export").click();
  const dl = await clickAndDownload(page, "ダウンロード");
  plainExpect(dl.suggestedFilename()).toBe("moving-mosaic.webm");
  const out = await assertDownloadedFile(dl, { minBytes: 1000 });

  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", out.path]).toString());
  const types = probe.streams.map((s: { codec_type: string }) => s.codec_type);
  plainExpect(types).toContain("video");
  plainExpect(types).toContain("audio");
  near(Number(probe.format.duration), 3, 0.25);

  for (const t of [0.5, 1.5, 2.5]) {
    const orig = frameRgb(videoPath, t);
    const mos = frameRgb(out.path, t);
    const inner = { ...objAt(t), x: objAt(t).x + 4, y: objAt(t).y + 4, w: 32, h: 32 };
    // 対象（正方形の模様）は、モザイクで大きく変わる
    plainExpect(diffIn(orig, mos, inner), `t=${t} 対象`).toBeGreaterThan(12);
    // 対象から離れた所（右上の背景）は、ほとんど変わらない
    const bg = { x: 260, y: 10, w: 50, h: 30 };
    plainExpect(diffIn(orig, mos, bg), `t=${t} 背景`).toBeLessThan(3);
  }
  plainExpect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  plainExpect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("video-mosaic: 追跡しなくても、固定の範囲で書き出せる（ぼかし・黒塗りも選べる）", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openWithVideo(page);
  await dragVideo(page, { x: 200, y: 150 }, { x: 300, y: 220 });
  await page.getByTestId("vm-mode-fixed").click();
  await page.getByTestId("vm-kind").selectOption("fill");
  await page.getByText("WebM", { exact: true }).click();
  await page.getByTestId("vm-export").click();
  const dl = await clickAndDownload(page, "ダウンロード");
  const out = await assertDownloadedFile(dl, { minBytes: 1000 });
  const f = frameRgb(out.path, 1);
  // 黒塗りの範囲の真ん中は黒い
  const i = (185 * W + 250) * 3;
  plainExpect(f[i] + f[i + 1] + f[i + 2]).toBeLessThan(40);
});

test("video-mosaic: 動画として読み込めないファイルは、理由を表示する", async ({ page }) => {
  const bad = path.join(dir, "broken.mp4");
  fs.writeFileSync(bad, "これは動画ではありません");
  await page.goto("/tools/video-mosaic");
  await page.waitForFunction(
    () => {
      const el = document.querySelector("main input[type=file]");
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
  await page.locator("main input[type=file]").first().setInputFiles(bad);
  await expect(page.getByRole("alert").filter({ hasText: /対応して|読み込みに失敗/ })).toBeVisible({ timeout: 30_000 });
});
