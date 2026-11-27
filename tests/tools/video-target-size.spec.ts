import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as baseTest, expect as baseExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import { DEFAULT_TARGET_MB, MIN_TARGET_VIDEO_BITRATE, targetBitrates, targetSizeError, type VideoEditSettings } from "@/lib/video/edit-settings";

/**
 * 動画圧縮の「目標サイズで指定」（2026-11-27）。
 * 動画の長さから映像・音声のビットレートを計算し、目標のファイルサイズ以下に書き出す。
 */

const MB = 1024 * 1024;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-target-"));

baseTest.describe("目標サイズの計算", () => {
  baseTest("目標・長さから映像と音声のビットレートを決め、合計が目標を超えない", () => {
    const plan = targetBitrates(10, 60, true);
    baseExpect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // 10MB × 8bit ÷ 60秒 ≒ 1.40Mbps。入れ物の分（4%）を引き、音声128kbpsを引いた残りが映像
    baseExpect(plan.audioBps).toBe(128_000);
    const totalBits = ((plan.videoBps + (plan.audioBps ?? 0)) * 60) / 8;
    baseExpect(totalBits).toBeLessThanOrEqual(10 * MB);
    baseExpect(plan.videoBps).toBeGreaterThan(1_000_000);
  });

  baseTest("音声がない動画は、目標をすべて映像に使う", () => {
    const plan = targetBitrates(10, 60, false);
    baseExpect(plan.ok && plan.audioBps).toBe(null);
  });

  baseTest("目標が小さすぎる（映像が最低のビットレートを下回る）ときは、必要な最小の目標を返す", () => {
    const plan = targetBitrates(1, 600, true);
    baseExpect(plan.ok).toBe(false);
    if (plan.ok) return;
    // 10分の動画：最低（映像100kbps＋音声64kbps）× 600秒 ÷ 8 ÷ 0.96 ≒ 12.2MB
    baseExpect(plan.minMb).toBeGreaterThan(12);
    baseExpect(plan.minMb).toBeLessThan(13);
    const ok = targetBitrates(plan.minMb, 600, true);
    baseExpect(ok.ok && ok.videoBps >= MIN_TARGET_VIDEO_BITRATE).toBe(true);
  });

  baseTest("目標の指定の確認：元の動画より大きい目標・小さすぎる目標・数字以外は、理由を返す", () => {
    const base: VideoEditSettings = { container: "mp4", quality: "target", resolution: "original", fps: "original", trimStart: 0, trimEnd: null, fastTrim: false, muted: false, rotate: 0, targetMb: DEFAULT_TARGET_MB };
    const src = { bytes: 50 * MB, durationSec: 60, hasAudio: true };
    baseExpect(targetSizeError(base, src)).toBeNull();
    baseExpect(targetSizeError({ ...base, targetMb: 80 }, src)).toContain("すでに目標のサイズ以下");
    baseExpect(targetSizeError({ ...base, targetMb: 0.5 }, { ...src, durationSec: 600 })).toContain("以上にするか");
    baseExpect(targetSizeError({ ...base, targetMb: NaN }, src)).toContain("0より大きい数字");
    // 目標サイズ以外の画質では確かめない
    baseExpect(targetSizeError({ ...base, quality: "medium", targetMb: 80 }, src)).toBeNull();
  });
});

test.describe("動画圧縮の画面：目標サイズで指定", () => {
  test.setTimeout(240_000);
  let src = "";
  test.beforeAll(() => {
    // 約8MBの動画（8秒・8Mbps・音声つき）
    src = path.join(tmp(), "big.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "8M", "-maxrate", "8M", "-bufsize", "8M", "-c:a", "aac", "-pix_fmt", "yuv420p", src,
    ]);
  });

  test("2MBを指定すると、2MB以下の動画ができ、目標に収まったと表示される", async ({ page }) => {
    const srcBytes = fs.statSync(src).size;
    expect(srcBytes).toBeGreaterThan(4 * MB);
    await page.goto("/tools/video-compress");
    await uploadFixture(page, src);
    await expect(page.getByText("動画の情報を調べています…")).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId("video-edit-settings").getByText("目標サイズで指定", { exact: true }).click();
    const box = page.getByTestId("video-edit-target");
    await expect(box).toBeVisible();
    await expect(page.getByTestId("video-edit-target-mb")).toHaveValue(String(DEFAULT_TARGET_MB));

    // 元の動画より大きい目標は、実行できない
    await page.getByTestId("video-edit-target-mb").fill("20");
    await expect(page.getByTestId("video-edit-target-error")).toContainText("すでに目標のサイズ以下");
    await expect(page.getByRole("button", { name: "圧縮する", exact: true })).toBeDisabled();

    await page.getByTestId("video-edit-target-mb").fill("2");
    await expect(page.getByTestId("video-edit-target-error")).toHaveCount(0);
    await expect(page.getByText("目標サイズ（2MB以下）")).toBeVisible();

    await page.getByRole("button", { name: "圧縮する", exact: true }).click();
    const popup = page.getByTestId("result-popup");
    await expect(popup).toBeVisible({ timeout: 180_000 });
    await expect(popup.getByTestId("video-edit-target-result")).toContainText("目標（2.0 MB以下）に収まりました");
    const wait = page.waitForEvent("download");
    await popup.getByRole("button", { name: "ダウンロード" }).click();
    const download = await wait;
    const dest = path.join(tmp(), download.suggestedFilename());
    await download.saveAs(dest);
    const outBytes = fs.statSync(dest).size;
    expect(outBytes).toBeLessThanOrEqual(2 * MB);
    // 目標から大きく下回りすぎない（画質を必要以上に落としていない）
    expect(outBytes).toBeGreaterThan(0.8 * MB);
    // 音声も残る
    const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", dest]).toString();
    expect(streams).toContain("audio");
  });
});
