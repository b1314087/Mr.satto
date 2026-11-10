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
import { openAdvanced } from "../helpers/advanced-settings";

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
  // 出力形式・回転・音声などは「詳細設定」の中にあるので、開いておく
  await openAdvanced(page, "video-edit-advanced");
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

  test("形式変換：出力形式を目立たせ、MP4・元の画質・元の解像度・元のfpsが選ばれている", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    await expect(page.getByTestId("video-edit-focus-container")).toContainText("出力形式");
    await expect(page.getByRole("radio", { name: "MP4" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "元のまま" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "元の解像度" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "元のフレームレート" })).toBeChecked();
    await expect(page.getByRole("button", { name: "変換する", exact: true })).toBeEnabled();
  });

  test("圧縮：画質・圧縮を目立たせ、「標準」が選ばれている（解像度・fpsは元のまま）", async ({ page }) => {
    await openWithVideo(page, "video-compress", src);
    await expect(page.getByTestId("video-edit-focus-quality")).toContainText("画質・圧縮");
    await expect(page.getByRole("radio", { name: "標準" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "元の解像度" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "元のフレームレート" })).toBeChecked();
    await expect(page.getByRole("button", { name: "圧縮する", exact: true })).toBeEnabled();
  });

  test("解像度変更：解像度を目立たせ、従来どおり解像度を選ぶまで実行できない", async ({ page }) => {
    await openWithVideo(page, "video-resize", src);
    await expect(page.getByTestId("video-edit-focus-resolution")).toContainText("解像度（元: 1280×720）");
    for (const name of ["元の解像度", "720p", "480p"]) await expect(page.getByRole("radio", { name })).not.toBeChecked();
    await expect(page.getByRole("button", { name: "解像度を変更する" })).toBeDisabled();
    await expect(page.getByTestId("video-edit-missing")).toContainText("解像度を選んでください");
    await choose(page, "720p");
    await expect(page.getByRole("button", { name: "解像度を変更する" })).toBeEnabled();
  });

  test("フレームレート変更：fpsを目立たせ、従来どおりfpsを選ぶまで実行できない", async ({ page }) => {
    await openWithVideo(page, "video-frame-rate", src);
    await expect(page.getByTestId("video-edit-focus-fps")).toContainText("フレームレート（元: 60fps）");
    await expect(page.getByRole("button", { name: "フレームレートを変更する" })).toBeDisabled();
    await choose(page, "30fps");
    await expect(page.getByRole("button", { name: "フレームレートを変更する" })).toBeEnabled();
  });

  test("ページ内で設定を変えても、もう一度URLを開くと、そのページの初期設定に戻る", async ({ page }) => {
    await openWithVideo(page, "video-compress", src);
    await choose(page, "高圧縮（強め）");
    await choose(page, "WebM");
    await openWithVideo(page, "video-compress", src);
    await expect(page.getByRole("radio", { name: "標準" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "MP4" })).toBeChecked();
  });

  test("元の動画より大きい解像度・高いfpsは選択肢に出ない", async ({ page }) => {
    const smallLowFps = makeVideo({ w: 640, h: 360, fps: 24, sec: 1 });
    await openWithVideo(page, "video-convert", smallLowFps);
    await expect(page.getByRole("radio", { name: "元の解像度" })).toBeVisible();
    for (const name of ["1080p", "720p", "480p"]) await expect(page.getByRole("radio", { name })).toHaveCount(0);
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
    { name: "形式＋圧縮", tool: "video-compress", picks: ["WebM"], expectProbe: { format: "webm", width: 1280, height: 720, fps: 60 } },
    { name: "形式＋解像度＋fps", tool: "video-convert", picks: ["WebM", "480p", "30fps"], expectProbe: { format: "webm", width: 854, height: 480, fps: 30 } },
    { name: "圧縮＋解像度＋fps", tool: "video-compress", picks: ["高圧縮（強め）", "480p", "24fps"], expectProbe: { format: "mp4", width: 854, height: 480, fps: 24 } },
    { name: "すべて同時（WebM・高圧縮・480p・15fps）", tool: "video-resize", picks: ["480p", "WebM", "高圧縮（強め）", "15fps"], expectProbe: { format: "webm", width: 854, height: 480, fps: 15 } },
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

// ---------------------------------------------------------------------------
// 工程3：切り取り・音声を消す・回転
// ---------------------------------------------------------------------------

function probeDuration(file: string): number {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}

test.describe("工程3：切り取り・音声を消す・回転", () => {
  test.setTimeout(180_000);
  let src = "";
  test.beforeAll(() => {
    src = makeVideo({ w: 640, h: 360, fps: 30, sec: 6 });
  });

  test("4つのページとも、切り取り・回転・音声を消すの設定がある", async ({ page }) => {
    for (const id of TOOLS) {
      await openWithVideo(page, id, src);
      await expect(page.getByTestId("video-edit-trim")).toBeVisible();
      await expect(page.getByTestId("video-edit-mute")).toBeVisible();
      await expect(page.getByTestId("video-edit-settings").getByText("右に90°", { exact: true })).toBeVisible();
    }
  });

  test("切り取り（正確）：2秒〜4.5秒を残すと、長さが約2.5秒になり、音声も残る", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    await page.getByTestId("video-edit-trim-start").fill("0:02");
    await page.getByTestId("video-edit-trim-end").fill("4.5");
    await expect(page.getByTestId("video-edit-trim-summary")).toContainText("0:02.0 〜 0:04.5（0:02.5）を残します");
    await expect(page.getByTestId("tool-preview")).toContainText("0:02.5（0:02.0〜0:04.5）");
    const out = await runAndDownload(page, "変換する");
    const dur = probeDuration(out);
    expect(dur).toBeGreaterThan(2.3);
    expect(dur).toBeLessThan(2.75);
    expect(probe(out).hasAudio).toBe(true);
    await expect(page.getByTestId("video-edit-result").getByTestId("video-edit-row-長さ")).toContainText("0:060:03");
  });

  test("切り取り（速さ優先）：作り直さずに切れ、長さは指定以上・元より短い", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    await page.getByTestId("video-edit-trim-start").fill("2");
    await page.getByTestId("video-edit-trim-fast").check();
    const out = await runAndDownload(page, "変換する");
    const dur = probeDuration(out);
    expect(dur).toBeGreaterThan(3.8);
    expect(dur).toBeLessThan(5.9);
  });

  test("切り取りの範囲がおかしいときは、理由を出して実行できない。「切り取りをやめる」で戻る", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    await page.getByTestId("video-edit-trim-start").fill("5");
    await page.getByTestId("video-edit-trim-end").fill("3");
    await expect(page.getByTestId("video-edit-trim-error")).toContainText("開始より後");
    await expect(page.getByRole("button", { name: "変換する", exact: true })).toBeDisabled();
    await page.getByTestId("video-edit-trim-end").fill("9");
    await expect(page.getByTestId("video-edit-trim-error")).toContainText("動画の長さ");
    await page.getByTestId("video-edit-trim-reset").click();
    await expect(page.getByTestId("video-edit-trim-error")).toHaveCount(0);
    await expect(page.getByTestId("video-edit-trim-start")).toHaveValue("");
    await expect(page.getByRole("button", { name: "変換する", exact: true })).toBeEnabled();
  });

  test("「今の位置」：プレビューの再生位置が、開始に入る", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    const video = page.getByTestId("tool-preview").locator("video");
    await video.evaluate(async (el: HTMLVideoElement) => {
      if (el.readyState < 1) await new Promise((r) => el.addEventListener("loadedmetadata", r, { once: true }));
      el.currentTime = 1.5;
      await new Promise((r) => el.addEventListener("seeked", r, { once: true }));
    });
    await page.getByTestId("video-edit-trim-start-now").click();
    await expect(page.getByTestId("video-edit-trim-start")).toHaveValue("0:01.5");
  });

  test("音声を消す：書き出した動画に音声がない", async ({ page }) => {
    await openWithVideo(page, "video-compress", src);
    await page.getByTestId("video-edit-mute").check();
    await expect(page.getByTestId("tool-preview")).toContainText("消す");
    const out = await runAndDownload(page, "圧縮する");
    expect(probe(out).hasAudio).toBe(false);
    await expect(page.getByTestId("video-edit-result").getByTestId("video-edit-row-音声")).toContainText("ありなし");
  });

  test("回転：MP4は右に90°で縦向き（360×640）になる。WebMは作り直して実際に縦の映像になる", async ({ page }) => {
    await openWithVideo(page, "video-convert", src);
    await choose(page, "右に90°");
    await expect(page.getByTestId("tool-preview")).toContainText("360×640");
    await runAndDownload(page, "変換する");
    await expect(page.getByTestId("video-edit-result").getByTestId("video-edit-row-解像度")).toContainText("640×360360×640");
    await page.keyboard.press("Escape");
    await choose(page, "WebM");
    await choose(page, "左に90°");
    const webm = await runAndDownload(page, "変換する");
    expect(probe(webm)).toMatchObject({ format: "webm", width: 360, height: 640, hasAudio: true });
  });

  test("組み合わせ：切り取り＋回転＋解像度＋音声を消すを、1回の変換でまとめて反映できる", async ({ page }) => {
    const wide = makeVideo({ w: 1280, h: 720, fps: 30, sec: 6 });
    await openWithVideo(page, "video-resize", wide);
    await choose(page, "480p");
    await choose(page, "右に90°");
    await page.getByTestId("video-edit-mute").check();
    await page.getByTestId("video-edit-trim-start").fill("1");
    await page.getByTestId("video-edit-trim-end").fill("3");
    const out = await runAndDownload(page, "解像度を変更する");
    const p = probe(out);
    expect(p.hasAudio).toBe(false);
    const dur = probeDuration(out);
    expect(dur).toBeGreaterThan(1.8);
    expect(dur).toBeLessThan(2.3);
    // 縦になってから短い辺（幅）を480にする（480×854）
    await expect(page.getByTestId("video-edit-result").getByTestId("video-edit-row-解像度")).toContainText("1280×720480×85");
  });
});
