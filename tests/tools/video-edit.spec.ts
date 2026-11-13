import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test as baseTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import {
  EDIT_DEFAULTS,
  VIDEO_EDIT_PRESETS,
  buildVideoOptions,
  formatTimeInput,
  needsReencode,
  parseTimeInput,
  plannedDimensions,
  trimError,
  compareSizes,
  estimateOutputRange,
  missingChoice,
  type VideoEditSettings,
} from "@/lib/video/edit-settings";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { ensureMediabunny } from "@/lib/media/mediabunny-loader";

/**
 * 動画編集 工程2（形式変換・圧縮・解像度・フレームレートの4ツール統合）のテスト。
 * - 4つのURLが同じ画面を使い、URLごとに初期設定と目立たせる設定が違う
 * - 出力形式・画質・解像度・フレームレートを組み合わせて、1回の変換で書き出せる
 *   （書き出したファイルの実際の形式・解像度・fps・音声を ffprobe で確かめる）
 * - 元の動画より大きい解像度・高いfpsは選べない
 */

const TOOLS = ["video-convert", "video-compress", "video-resize", "video-frame-rate"] as const;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "video-edit-"));

/** テスト用の動画（音声付き）を ffmpeg で作る */
function makeVideo(opts: { w: number; h: number; fps: number; sec: number }): string {
  const out = path.join(tmp(), `src-${opts.w}x${opts.h}-${opts.fps}.mp4`);
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${opts.w}x${opts.h}:rate=${opts.fps}`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(opts.sec), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "3M", "-c:a", "aac", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

interface Probe {
  format: string;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

function probe(file: string): Probe {
  const json = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=format_name", "-of", "json", file]).toString()
  ) as { streams: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string }[]; format: { format_name: string } };
  const v = json.streams.find((s) => s.codec_type === "video")!;
  const [n, d] = (v.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    format: json.format.format_name.includes("webm") ? "webm" : json.format.format_name.includes("mp4") ? "mp4" : json.format.format_name,
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: d ? Math.round((n / d) * 10) / 10 : 0,
    hasAudio: json.streams.some((s) => s.codec_type === "audio"),
  };
}

async function choose(page: Page, label: string) {
  await page.getByTestId("video-edit-settings").getByText(label, { exact: true }).click();
}

async function runAndDownload(page: Page, actionLabel: string): Promise<string> {
  await page.getByRole("button", { name: actionLabel, exact: true }).click();
  const popup = page.getByTestId("result-popup");
  await expect(popup).toBeVisible({ timeout: 120_000 });
  const wait = page.waitForEvent("download");
  await popup.getByRole("button", { name: "ダウンロード" }).click();
  const download = await wait;
  const dest = path.join(tmp(), download.suggestedFilename());
  await download.saveAs(dest);
  return dest;
}

async function openWithVideo(page: Page, toolId: string, file: string) {
  await page.goto(`/tools/${toolId}`);
  await uploadFixture(page, file);
  await expect(page.getByTestId("video-edit-settings")).toBeVisible();
  // 動画の情報（解像度・fps）を調べ終えるまで待つ
  await expect(page.getByText("動画の情報を調べています…")).toHaveCount(0, { timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// 設定の仕組み（ブラウザを使わない確認）
// ---------------------------------------------------------------------------

baseTest.describe("設定の仕組み", () => {
  const base: VideoEditSettings = { container: "mp4", quality: "original", resolution: "original", fps: "original", ...EDIT_DEFAULTS };
  // 画質の設定値は mediabunny の定数を使うため、先に読み込んでおく（ページでは処理の直前に読み込む）
  baseTest.beforeAll(async () => {
    await ensureMediabunny();
  });

  baseTest("何も変えないときは映像のオプションを渡さない（使えるならコピーで済ませる。従来の形式変換と同じ）", () => {
    expect(buildVideoOptions(base, { width: 1280, height: 720 })).toBeUndefined();
  });

  baseTest("画質・解像度・fpsの指定は、1つのオプションにまとめて渡す（1回の変換で反映）", () => {
    const opts = buildVideoOptions({ ...base, container: "webm", quality: "high", resolution: 480, fps: 30 }, { width: 1280, height: 720 });
    expect(opts?.forceTranscode).toBe(true);
    expect(opts?.quality).toBeTruthy();
    expect(opts?.height).toBe(480);
    expect(opts?.width).toBeUndefined();
    expect(opts?.frameRate).toBe(30);
    // 縦動画は幅（短い辺）を指定する
    expect(buildVideoOptions({ ...base, resolution: 720 }, { width: 1080, height: 1920 })).toEqual({ width: 720 });
  });

  baseTest("解像度・fpsをまだ選んでいないときは実行できない", () => {
    expect(missingChoice(VIDEO_EDIT_PRESETS["video-resize"].initial)).toBe("resolution");
    expect(missingChoice(VIDEO_EDIT_PRESETS["video-frame-rate"].initial)).toBe("fps");
    expect(missingChoice(VIDEO_EDIT_PRESETS["video-convert"].initial)).toBeNull();
    expect(missingChoice(VIDEO_EDIT_PRESETS["video-compress"].initial)).toBeNull();
  });

  baseTest("サイズの比べ方：増えたときは削減率をマイナスにせず「増えた」と表す", () => {
    expect(compareSizes(120, 45)).toEqual({ kind: "smaller", savedBytes: 75, percent: 62.5 });
    expect(compareSizes(100, 100)).toEqual({ kind: "same" });
    expect(compareSizes(100, 130)).toEqual({ kind: "larger", increasedBytes: 30 });
  });

  baseTest("サイズの目安：何も変えないときは出さない。解像度・fpsを下げると目安が小さくなる", () => {
    const src = { bytes: 1000, width: 1920, height: 1080, fps: 60 };
    expect(estimateOutputRange(base, src)).toBeNull();
    const [, hiQ] = estimateOutputRange({ ...base, quality: "medium" }, src)!;
    const [, hiAll] = estimateOutputRange({ ...base, quality: "medium", resolution: 720, fps: 30 }, src)!;
    expect(hiAll).toBeLessThan(hiQ);
    expect(estimateOutputRange({ ...base, resolution: null }, src)).toBeNull();
  });

  baseTest("工程3：時間の入力（1:05.5・65.5・全角）を秒に読み、読めないものは NaN", () => {
    expect(parseTimeInput("1:05.5")).toBe(65.5);
    expect(parseTimeInput("65.5")).toBe(65.5);
    expect(parseTimeInput("１：０２")).toBe(62);
    expect(parseTimeInput("1:02:03")).toBe(3723);
    expect(parseTimeInput("")).toBeNull();
    expect(parseTimeInput("1:75")).toBeNaN();
    expect(parseTimeInput("abc")).toBeNaN();
    expect(formatTimeInput(65.5)).toBe("1:05.5");
    expect(formatTimeInput(3723)).toBe("1:02:03.0");
  });

  baseTest("工程3：切り取りの範囲の確認（終了は開始より後・動画の長さまで）", () => {
    expect(trimError({ ...base, trimStart: 1, trimEnd: 3 }, 10)).toBeNull();
    expect(trimError({ ...base, trimStart: 3, trimEnd: 2 }, 10)).toContain("開始より後");
    expect(trimError({ ...base, trimStart: 12 }, 10)).toContain("動画の長さ");
    expect(trimError({ ...base, trimEnd: 15 }, 10)).toContain("動画の長さ");
    expect(trimError({ ...base, trimStart: Number.NaN }, 10)).toContain("開始");
  });

  baseTest("工程3：回転は解像度より先にかかる（縦横が入れ替わる）。作り直しが要る設定の判定", () => {
    expect(buildVideoOptions({ ...base, rotate: 90 }, { width: 1280, height: 720 })).toEqual({ rotate: 90 });
    // 横動画を90°回すと縦動画になり、短い辺（幅）で縮める
    expect(buildVideoOptions({ ...base, rotate: 90, resolution: 480 }, { width: 1280, height: 720 })).toEqual({ rotate: 90, width: 480 });
    expect(plannedDimensions({ ...base, rotate: 270 }, 1280, 720)).toEqual({ width: 720, height: 1280 });
    expect(needsReencode(base)).toBe(false);
    expect(needsReencode({ ...base, muted: true })).toBe(false);
    expect(needsReencode({ ...base, rotate: 90 })).toBe(false);
    expect(needsReencode({ ...base, rotate: 90, container: "webm" })).toBe(true);
    expect(needsReencode({ ...base, trimStart: 2 })).toBe(true);
    expect(needsReencode({ ...base, trimStart: 2, fastTrim: true })).toBe(false);
    expect(needsReencode({ ...base, trimEnd: 5 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URLごとの初期設定
// ---------------------------------------------------------------------------

test.describe("URLごとの初期設定", () => {
  test.setTimeout(90_000);
  let src = "";
  test.beforeAll(() => {
    src = makeVideo({ w: 1280, h: 720, fps: 60, sec: 1 });
  });

  // 2026-11：詳細設定（ほかの設定・回転・音声を消す）を削除し、各ページはそのページの設定だけにした
  const OTHER_LABELS = ["元の解像度", "元のフレームレート", "元のまま", "標準", "MP4", "WebM"];

  test("形式変換：出力形式だけを出し、MP4が選ばれている（画質・解像度・fps・回転・音声の設定は無い）", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    await expect(page.getByTestId("video-edit-focus-container")).toContainText("出力形式");
    await expect(page.getByRole("radio", { name: "MP4" })).toBeChecked();
    for (const name of ["元の解像度", "元のフレームレート", "標準"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "変換する", exact: true })).toBeEnabled();
  });

  test("圧縮：画質・圧縮だけを出し、「標準」が選ばれている", async ({ page }) => {
    await openWithVideo(page, "video-compress", src);
    await expect(page.getByTestId("video-edit-focus-quality")).toContainText("画質・圧縮");
    await expect(page.getByRole("radio", { name: "標準" })).toBeChecked();
    for (const name of ["元の解像度", "元のフレームレート", "MP4", "WebM"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "圧縮する", exact: true })).toBeEnabled();
  });

  test("解像度変更：解像度だけを出し、従来どおり解像度を選ぶまで実行できない", async ({ page }) => {
    await openWithVideo(page, "video-resize", src);
    await expect(page.getByTestId("video-edit-focus-resolution")).toContainText("解像度（元: 1280×720）");
    for (const name of ["元の解像度", "720p", "480p"]) await expect(page.getByRole("radio", { name })).not.toBeChecked();
    for (const name of ["元のフレームレート", "MP4", "標準"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "解像度を変更する" })).toBeDisabled();
    await expect(page.getByTestId("video-edit-missing")).toContainText("解像度を選んでください");
    await choose(page, "720p");
    await expect(page.getByRole("button", { name: "解像度を変更する" })).toBeEnabled();
  });

  test("フレームレート変更：fpsだけを出し、従来どおりfpsを選ぶまで実行できない", async ({ page }) => {
    await openWithVideo(page, "video-frame-rate", src);
    await expect(page.getByTestId("video-edit-focus-fps")).toContainText("フレームレート（元: 60fps）");
    for (const name of ["元の解像度", "MP4", "標準"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "フレームレートを変更する" })).toBeDisabled();
    await choose(page, "30fps");
    await expect(page.getByRole("button", { name: "フレームレートを変更する" })).toBeEnabled();
  });

  test("4つのページとも、詳細設定・切り取り・回転・音声を消すの設定は無い（2026-11に削除）", async ({ page }) => {
    for (const id of TOOLS) {
      await openWithVideo(page, id, src);
      await expect(page.getByTestId("video-edit-advanced"), id).toHaveCount(0);
      await expect(page.getByText("詳細設定", { exact: true }), id).toHaveCount(0);
      await expect(page.getByTestId("video-edit-trim"), id).toHaveCount(0);
      await expect(page.getByTestId("video-edit-mute"), id).toHaveCount(0);
      await expect(page.getByTestId("video-edit-settings").getByText("右に90°", { exact: true }), id).toHaveCount(0);
    }
    expect(OTHER_LABELS.length).toBeGreaterThan(0);
  });

  test("ページ内で設定を変えても、もう一度URLを開くと、そのページの初期設定に戻る", async ({ page }) => {
    await openWithVideo(page, "video-compress", src);
    await choose(page, "高圧縮（強め）");
    await openWithVideo(page, "video-compress", src);
    await expect(page.getByRole("radio", { name: "標準" })).toBeChecked();
  });

  test("元の動画より大きい解像度・高いfpsは選択肢に出ない", async ({ page }) => {
    const smallLowFps = makeVideo({ w: 640, h: 360, fps: 24, sec: 1 });
    await openWithVideo(page, "video-resize", smallLowFps);
    await expect(page.getByRole("radio", { name: "元の解像度" })).toBeVisible();
    for (const name of ["1080p", "720p", "480p"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
    await openWithVideo(page, "video-frame-rate", smallLowFps);
    await expect(page.getByRole("radio", { name: "24fps" })).toBeVisible();
    for (const name of ["60fps", "30fps"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 設定の組み合わせ（実際に書き出して、形式・解像度・fps・音声を確かめる）
// ---------------------------------------------------------------------------

test.describe("設定の組み合わせ", () => {
  test.setTimeout(180_000);
  let src = "";
  test.beforeAll(() => {
    src = makeVideo({ w: 1280, h: 720, fps: 60, sec: 1 });
  });

  const cases: { name: string; tool: (typeof TOOLS)[number]; picks: string[]; expectProbe: Partial<Probe> }[] = [
    { name: "形式のみ（MP4→WebM）", tool: "video-convert", picks: ["WebM"], expectProbe: { format: "webm", width: 1280, height: 720, fps: 60 } },
    { name: "圧縮のみ（標準）", tool: "video-compress", picks: [], expectProbe: { format: "mp4", width: 1280, height: 720, fps: 60 } },
    { name: "解像度のみ（480p）", tool: "video-resize", picks: ["480p"], expectProbe: { format: "mp4", width: 854, height: 480, fps: 60 } },
    { name: "fpsのみ（30fps）", tool: "video-frame-rate", picks: ["30fps"], expectProbe: { format: "mp4", width: 1280, height: 720, fps: 30 } },
    { name: "圧縮（高圧縮）", tool: "video-compress", picks: ["高圧縮（強め）"], expectProbe: { format: "mp4", width: 1280, height: 720, fps: 60 } },
    { name: "fpsのみ（24fps）", tool: "video-frame-rate", picks: ["24fps"], expectProbe: { format: "mp4", width: 1280, height: 720, fps: 24 } },
  ];

  for (const c of cases) {
    test(`${c.name}：書き出したファイルの形式・解像度・fpsが設定どおりで、音声が残る`, async ({ page }) => {
      await openWithVideo(page, c.tool, src);
      for (const label of c.picks) await choose(page, label);
      const out = await runAndDownload(page, VIDEO_EDIT_PRESETS[c.tool].actionLabel);
      const p = probe(out);
      expect(p).toMatchObject({ ...c.expectProbe, hasAudio: true });
      // 結果欄にも、読み直した実際の値が出る
      const result = page.getByTestId("video-edit-result");
      await expect(result.getByTestId("video-edit-row-解像度")).toContainText(`${p.width}×${p.height}`);
      await expect(result.getByTestId("video-edit-row-音声")).toContainText("ありあり");
      await expect(result.getByTestId("video-edit-size-compare")).toBeVisible();
      // 保存するファイル名は、従来のツールと同じ付け方
      expect(path.basename(out)).toMatch(new RegExp(`^src-1280x720-60${VIDEO_EDIT_PRESETS[c.tool].fileSuffix}\\.${p.format}$`));
    });
  }

  test("総合改修 16：形式変換で MOV・MKV にも書き出せる（拡張子・中身の形式・音声）", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    for (const label of ["MP4", "MOV", "WebM", "MKV"]) await expect(page.getByTestId("video-edit-settings").getByText(label, { exact: true })).toBeVisible();
    await choose(page, "MOV");
    const mov = await runAndDownload(page, "変換する");
    expect(path.extname(mov)).toBe(".mov");
    const brand = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=major_brand", "-of", "csv=p=0", mov]).toString().trim();
    expect(brand).toBe("qt");
    expect(probe(mov)).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    await page.keyboard.press("Escape");
    await choose(page, "MKV");
    const mkv = await runAndDownload(page, "変換する");
    expect(path.extname(mkv)).toBe(".mkv");
    expect(fs.readFileSync(mkv).subarray(0, 64).toString("latin1")).toContain("matroska");
    expect(probe(mkv)).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    // ほかの動画編集ページには、出力形式の選択が無い（MP4で書き出す）
    await openWithVideo(page, "video-compress", src);
    await expect(page.getByTestId("video-edit-settings").getByText("MOV", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "MP4" })).toHaveCount(0);
  });

  test("総合改修 14：フレームレートの候補は24fps以上だけ（15fpsは選べない）", async ({ page }) => {
    await openWithVideo(page, "video-frame-rate", src);
    for (const label of ["60fps", "30fps", "24fps"]) await expect(page.getByTestId("video-edit-settings").getByText(label, { exact: true })).toBeVisible();
    await expect(page.getByTestId("video-edit-settings").getByText("15fps", { exact: true })).toHaveCount(0);
  });

  test("圧縮の設定が反映される：「高圧縮（強め）」は「高画質（弱め）」より小さくなる", async ({ page }) => {
    await openWithVideo(page, "video-compress", src);
    await choose(page, "高画質（弱め）");
    const weak = fs.statSync(await runAndDownload(page, "圧縮する")).size;
    await page.keyboard.press("Escape");
    await choose(page, "高圧縮（強め）");
    const strong = fs.statSync(await runAndDownload(page, "圧縮する")).size;
    expect(strong).toBeLessThan(weak);
  });
});

// ---------------------------------------------------------------------------
// 画面・SEO
// ---------------------------------------------------------------------------

test.describe("画面・SEO", () => {
  test.setTimeout(90_000);

  for (const id of TOOLS) {
    test(`${id}：URLに直接アクセスでき、title・description・canonicalがそのページのもの`, async ({ page }) => {
      const res = await page.goto(`/tools/${id}`);
      expect(res?.status()).toBe(200);
      const seo = getToolSeoContent(id)!;
      await expect(page).toHaveTitle(new RegExp(seo.metaTitle.split("｜")[0]));
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/tools/${id}$`));
      const desc = await page.locator('meta[name="description"]').getAttribute("content");
      expect(desc).toContain(seo.metaDescription.slice(0, 15));
    });
  }

  test("スマホ幅：4つのページとも、動画を選んだあとの画面が横にはみ出さない", async ({ page }) => {
    const src = makeVideo({ w: 1280, h: 720, fps: 30, sec: 1 });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of TOOLS) {
      await openWithVideo(page, id, src);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, id).toBeLessThanOrEqual(1);
    }
  });
});
