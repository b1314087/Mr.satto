import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * ロードマップC 工程4：動画・音声の部品（mediabunny・MP3エンコーダー）を、
 * ページを開いた時点では読み込まず、ファイルを選んで処理が必要になったときに初めて読み込むことのテスト。
 */

/**
 * 読み込んだスクリプトの中に、mediabunny・MP3エンコーダーが入っているか。
 * 開発用のサーバーでは、スクリプトの中に部品の定義（場所の名前つき）が入っているので、それで判断する。
 */
async function loadedMediaParts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((u) => u.includes("/_next/static/") && u.split("?")[0].endsWith(".js"));
    const found = new Set<string>();
    for (const u of urls) {
      const text = await fetch(u).then((r) => r.text()).catch(() => "");
      // 部品の中身（モジュールの定義：「"[project]/node_modules/mediabunny/…(ecmascript)", ((」）が入っているときだけ数える
      if (/"\[project\]\/node_modules\/mediabunny\/[^"]*\(ecmascript\)", \(\(/.test(text)) found.add("mediabunny");
      if (/"\[project\]\/node_modules\/@mediabunny\/mp3-encoder\/[^"]*\(ecmascript\)", \(\(/.test(text)) found.add("mp3-encoder");
    }
    return [...found].sort();
  });
}

const VIDEO_TOOLS = [
  "video-convert",
  "video-compress",
  "video-resize",
  "video-frame-rate",
  "video-metadata-remove",
  "video-mosaic",
  "video-thumbnail",
  "video-h264",
];
const AUDIO_TOOLS = ["audio-convert", "audio-compress", "audio-extract", "audio-trim", "audio-volume", "audio-merge"];

test.describe("動画・音声の部品は、ページを開いた時点では読み込まない", () => {
  test.setTimeout(120_000);

  for (const tool of [...VIDEO_TOOLS, ...AUDIO_TOOLS]) {
    test(`${tool}：ページを開いただけでは mediabunny・MP3エンコーダーを読み込まない`, async ({ page }) => {
      await page.goto(`/tools/${tool}`);
      await page.waitForTimeout(2500);
      expect(await loadedMediaParts(page)).toEqual([]);
    });
  }

  test("音声の形式変換：ファイルを選ぶと部品を読み込み、MP3を選択肢に出す（書き出せるかの確認はファイル選択後）", async ({ page }) => {
    await page.goto("/tools/audio-convert");
    await page.waitForTimeout(1500);
    expect(await loadedMediaParts(page)).toEqual([]);
    await uploadFixture(page, fixtures.audioWav);
    await expect(page.locator("label", { hasText: /^MP3$/ })).toBeVisible({ timeout: 20_000 });
    expect(await loadedMediaParts(page)).toEqual(["mediabunny", "mp3-encoder"]);
  });

  test("動画の形式変換：動画を選ぶと mediabunny を読み込み、動画の情報を調べられる", async ({ page }) => {
    await page.goto("/tools/video-convert");
    await page.waitForTimeout(1500);
    expect(await loadedMediaParts(page)).toEqual([]);
    await uploadFixture(page, fixtures.videoWithMetadataMp4);
    await expect(page.getByTestId("video-edit-settings")).toBeVisible();
    await expect(page.getByText("動画の情報を調べています…")).toHaveCount(0, { timeout: 30_000 });
    expect(await loadedMediaParts(page)).toContain("mediabunny");
  });
});
