import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures as FIXTURES } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";
import { validateClips } from "@/lib/processors/browser/video-cut-merge";

/**
 * 動画カット・結合（次期機能追加 3）。
 * - 1本の動画から残す区間を複数指定して順番につなぐ
 * - 複数の動画を順番を入れ替えて1本にする（縦向き・横向き・解像度・fps・音声の有無が違っても）
 * - 書き出したファイルを ffprobe で読み直し、長さ・大きさ・音声（映像と同じ長さ＝ずれない）を確かめる
 * - 処理中のキャンセル
 */

type Probe = { width: number; height: number; videoSec: number; audioSec: number | null; formatSec: number };

function probe(file: string): Probe {
  const json = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", file]).toString()
  ) as { streams: { codec_type: string; width?: number; height?: number; duration?: string }[]; format: { duration?: string } };
  const v = json.streams.find((s) => s.codec_type === "video")!;
  const a = json.streams.find((s) => s.codec_type === "audio");
  const formatSec = Number(json.format.duration ?? 0);
  return {
    width: v.width ?? 0,
    height: v.height ?? 0,
    videoSec: Number(v.duration ?? formatSec),
    audioSec: a ? Number(a.duration ?? formatSec) : null,
    formatSec,
  };
}

async function runAndDownload(page: Page, out: string): Promise<string> {
  await page.getByTestId("video-cut-merge-run").click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 120_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "ダウンロード" }).click();
  const download = await wait;
  const dest = path.join(path.dirname(out), download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

plainTest.describe("区間の確認（ブラウザを使わない）", () => {
  plainTest("終了が開始より前・短すぎる区間・長さを超える区間・空は、理由つきで止める", () => {
    const d = 5;
    plainExpect(validateClips([])).toMatch(/1つ以上/);
    plainExpect(validateClips([{ start: 2, end: 1, durationSec: d }])).toMatch(/終了を開始より後/);
    plainExpect(validateClips([{ start: 1, end: 1.05, durationSec: d }])).toMatch(/0.1秒以上/);
    plainExpect(validateClips([{ start: 1, end: 9, durationSec: d }])).toMatch(/超えています/);
    plainExpect(validateClips([{ start: 0, end: 1, durationSec: d }, { start: 2, end: 3, durationSec: d }])).toBeNull();
  });
});

test.describe("動画カット・結合の画面", () => {
  test("不要部分を削除：2つの区間（0.5〜1.5秒、2〜3秒）を残して1本にする。音声も同じ長さで残る", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/tools/video-cut-merge");
    await uploadFixture(page, FIXTURES.cutLandscapeWebm);
    await expect(page.getByTestId("video-cut-segments")).toBeVisible();
    await page.getByTestId("video-cut-start").first().fill("0.5");
    await page.getByTestId("video-cut-end").first().fill("1.5");
    await page.getByTestId("video-cut-add").click();
    await page.getByTestId("video-cut-start").nth(1).fill("2");
    await page.getByTestId("video-cut-end").nth(1).fill("3");
    await expect(page.getByTestId("video-cut-summary")).toContainText("2区間・合計");
    // 終了が開始より前なら、実行できず理由が出る
    await page.getByTestId("video-cut-end").nth(1).fill("1");
    await expect(page.getByTestId("video-cut-error")).toBeVisible();
    await expect(page.getByTestId("video-cut-merge-run")).toBeDisabled();
    await page.getByTestId("video-cut-end").nth(1).fill("3");
    await expect(page.getByTestId("video-cut-merge-run")).toBeEnabled();

    const out = await runAndDownload(page, test.info().outputPath("x"));
    expect(path.basename(out)).toBe("cut-landscape_カット.mp4");
    const p = probe(out);
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
    expect(p.formatSec).toBeGreaterThan(1.8);
    expect(p.formatSec).toBeLessThan(2.3);
    expect(p.audioSec).not.toBeNull();
    expect(Math.abs((p.audioSec ?? 0) - p.videoSec)).toBeLessThan(0.15); // 映像と音声の長さがそろう（ずれない）
    await expect(page.getByTestId("video-cut-merge-result")).toContainText("320×240");
    await expect(page.getByTestId("video-cut-merge-result")).toContainText("音声あり");
  });

  test("複数の動画を結合：横向き・縦向き（fps違い）・音声なしを、順番を入れ替えて1本にする。大きさは1本目に合わせ、黒い余白を付ける", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/tools/video-cut-merge");
    await page.getByTestId("video-cut-merge-mode").getByRole("radio", { name: "複数の動画を結合" }).click();
    await uploadFixture(page, [FIXTURES.cutPortraitWebm, FIXTURES.cutLandscapeWebm, FIXTURES.cutSilentWebm]);
    const list = page.getByTestId("video-merge-item");
    await expect(list).toHaveCount(3);
    await expect(list.nth(0)).toContainText("cut-portrait.webm");
    await expect(list.nth(0)).toContainText("240×320");
    await expect(list.nth(2)).toContainText("音声なし");
    // 横向きの動画を1本目にする
    await page.getByRole("button", { name: "cut-landscape.webm を上へ移動" }).click();
    await expect(list.nth(0)).toContainText("cut-landscape.webm");
    await expect(page.getByTestId("video-merge-summary")).toContainText("3本・合計");
    await expect(page.getByTestId("video-merge-size-note")).toContainText("320×240");
    // 書き出し形式：WebM
    await page.getByTestId("video-cut-merge-container").getByRole("radio", { name: /WebM/ }).click();

    const out = await runAndDownload(page, test.info().outputPath("x"));
    expect(path.basename(out)).toBe("cut-landscape_結合.webm");
    const p = probe(out);
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
    expect(p.formatSec).toBeGreaterThan(6.6); // 3秒 + 2秒 + 2秒
    expect(p.formatSec).toBeLessThan(7.4);
    expect(p.audioSec).not.toBeNull(); // 音声なしの動画は無音として入る
    await expect(page.getByTestId("result-popup")).toContainText("黒い余白を付けて大きさをそろえました");
  });

  test("処理中にキャンセルできる。キャンセル後はもう一度実行できる", async ({ page }) => {
    test.setTimeout(180_000);
    const long = test.info().outputPath("long.webm");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "40", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus", long,
    ]);
    expect(fs.existsSync(long)).toBe(true);
    await page.goto("/tools/video-cut-merge");
    await uploadFixture(page, long);
    await expect(page.getByTestId("video-cut-summary")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("video-cut-merge-run").click();
    await expect(page.getByText(/書き出し中\.\.\. \d+%/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(page.getByText("処理をキャンセルしました。")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("result-popup")).toHaveCount(0);
    await expect(page.getByTestId("video-cut-merge-run")).toBeEnabled();
  });
});
