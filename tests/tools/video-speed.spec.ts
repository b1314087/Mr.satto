import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as baseTest, expect as baseExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import { timeStretch } from "@/lib/audio/time-stretch";
import { isValidSpeed, speedLabel, speedOutputFps } from "@/lib/video/speed";
import { getOriginalRequiredPlan, getToolById } from "@/lib/tools/data";
import { getToolSeoContent } from "@/lib/seo/tool-content";

/**
 * 動画の再生速度変更（2026-11-27）。
 * - 速さに合わせて長さが変わる（2倍速なら半分）
 * - 「音の高さを保つ」がオンなら、440Hzの音は440Hzのまま。オフなら速さに合わせて高さも変わる
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-speed-"));
const SR = 48000;

const sine = (sec: number, f: number) => {
  const a = new Float32Array(SR * sec);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * f * i) / SR) * 0.5;
  return a;
};
/** ゼロを下から上へまたぐ回数から、音の高さ（Hz）を求める */
const pitchOf = (a: Float32Array, rate = SR) => {
  let n = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) n++;
  return n / (a.length / rate);
};

baseTest.describe("音の高さを保ったまま速さを変える計算（タイムストレッチ）", () => {
  for (const speed of [2, 0.5, 1.5]) {
    baseTest(`${speed}倍：長さは元の1/${speed}になり、440Hzは440Hzのまま、音の大きさも変わらない`, () => {
      const [y] = timeStretch([sine(2, 440)], { speed, sampleRate: SR });
      baseExpect(y.length / SR).toBeCloseTo(2 / speed, 2);
      const mid = y.subarray(Math.floor(y.length * 0.1), Math.floor(y.length * 0.9));
      baseExpect(Math.abs(pitchOf(mid) - 440)).toBeLessThan(5);
      let rms = 0;
      for (const v of mid) rms += v * v;
      baseExpect(Math.sqrt(rms / mid.length)).toBeCloseTo(0.5 / Math.SQRT2, 1);
    });
  }

  baseTest("左右のチャンネルの長さはそろい、1分のステレオでも数秒以内に終わる", () => {
    const t = Date.now();
    const [l, r] = timeStretch([sine(60, 300), sine(60, 500)], { speed: 1.5, sampleRate: SR });
    baseExpect(l.length).toBe(r.length);
    baseExpect(Date.now() - t).toBeLessThan(5000);
  });

  baseTest("速さの判定・表示・書き出すfps", () => {
    baseExpect(isValidSpeed(2)).toBe(true);
    baseExpect(isValidSpeed(0.25)).toBe(true);
    baseExpect(isValidSpeed(1)).toBe(false);
    baseExpect(isValidSpeed(5)).toBe(false);
    baseExpect(isValidSpeed(NaN)).toBe(false);
    baseExpect(speedLabel(2)).toBe("2倍速");
    baseExpect(speedLabel(0.5)).toBe("0.5倍（ゆっくり）");
    baseExpect(speedOutputFps(60)).toBe(60);
    baseExpect(speedOutputFps(15)).toBe(24);
    baseExpect(speedOutputFps(120)).toBe(60);
    baseExpect(speedOutputFps(null)).toBe(30);
  });

  baseTest("ツールとして登録され、使い方・よくある質問がある（プレミアム）", () => {
    baseExpect(getToolById("video-speed")?.status).toBe("available");
    baseExpect(getOriginalRequiredPlan("video-speed")).toBe("premium");
    baseExpect(getToolSeoContent("video-speed")?.faq.length).toBeGreaterThanOrEqual(4);
  });
});

/** 書き出した動画の長さ（秒）と、音声の高さ（Hz） */
function inspect(file: string): { duration: number; hasAudio: boolean; pitch: number | null } {
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
  const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]).toString();
  if (!streams.includes("audio")) return { duration, hasAudio: false, pitch: null };
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 64 * 1024 * 1024 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const mid = pcm.subarray(Math.floor(pcm.length * 0.15), Math.floor(pcm.length * 0.85));
  return { duration, hasAudio: true, pitch: pitchOf(mid) };
}

async function runAndDownload(page: Page): Promise<string> {
  await page.getByRole("button", { name: "速さを変える", exact: true }).click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 150_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "ダウンロード" }).click();
  const download = await wait;
  const dest = path.join(tmp(), download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

test.describe("動画の再生速度変更の画面", () => {
  test.setTimeout(300_000);
  let src = "";
  test.beforeAll(() => {
    src = path.join(tmp(), "clip.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", src,
    ]);
  });

  test("2倍速（音の高さを保つ）：長さが半分になり、音は440Hzのまま", async ({ page }) => {
    await page.goto("/tools/video-speed");
    await uploadFixture(page, src);
    await expect(page.getByTestId("video-speed-settings")).toBeVisible();
    await expect(page.getByTestId("video-speed-preset-2")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("video-speed-keep-pitch")).toBeChecked();
    const out = await runAndDownload(page);
    expect(path.basename(out)).toBe("clip-x2.mp4");
    const r = inspect(out);
    expect(r.duration).toBeGreaterThan(1.8);
    expect(r.duration).toBeLessThan(2.3);
    expect(r.hasAudio).toBe(true);
    expect(Math.abs((r.pitch ?? 0) - 440)).toBeLessThan(15);
    await expect(page.getByTestId("video-speed-result")).toContainText("640×360");
  });

  test("0.5倍（音の高さを保たない）：長さが2倍になり、音は低く（約220Hz）なる。1倍や範囲外は実行できない", async ({ page }) => {
    await page.goto("/tools/video-speed");
    await uploadFixture(page, src);
    await page.getByTestId("video-speed-value").fill("1");
    await expect(page.getByTestId("video-speed-error")).toContainText("1倍のままでは変わりません");
    await expect(page.getByRole("button", { name: "速さを変える", exact: true })).toBeDisabled();
    await page.getByTestId("video-speed-value").fill("9");
    await expect(page.getByTestId("video-speed-error")).toContainText("0.25〜4倍");
    await page.getByTestId("video-speed-preset-0.5").click();
    await expect(page.getByTestId("video-speed-error")).toHaveCount(0);
    await page.getByTestId("video-speed-keep-pitch").uncheck();
    const out = await runAndDownload(page);
    const r = inspect(out);
    expect(r.duration).toBeGreaterThan(7.5);
    expect(r.duration).toBeLessThan(8.6);
    expect(Math.abs((r.pitch ?? 0) - 220)).toBeLessThan(10);
  });

  test("音声を消すと、音声のない動画になる", async ({ page }) => {
    await page.goto("/tools/video-speed");
    await uploadFixture(page, src);
    await page.getByTestId("video-speed-preset-1.5").click();
    await page.getByTestId("video-speed-muted").check();
    const out = await runAndDownload(page);
    const r = inspect(out);
    expect(r.hasAudio).toBe(false);
    expect(r.duration).toBeGreaterThan(2.4);
    expect(r.duration).toBeLessThan(2.9);
  });
});
