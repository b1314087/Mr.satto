import { test, expect } from "../fixtures/premium-test";
import { waitHydrated } from "../helpers/hydrated";
import { TOOL_SEARCH_CONSENT_VERSION } from "@/lib/ai/tool-search";

/**
 * ツール検索（2026-11-20）の画面。
 * ① 文章で探す（近いツールの表示）② 話して探す（マイク。ブラウザの音声認識を偽物に差し替える）
 * ③ AIに相談して探す（プレミアム。/api/ai/* はテスト内で差し替え、実際のOpenAIには接続しない）
 */

const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 0, remainingAiTokens: 30_000_000, periodEnd: "2026-11-30T00:00:00Z" } };

/** 決まった言葉を返す、偽物の音声認識 */
async function fakeSpeech(page: import("@playwright/test").Page, text: string) {
  await page.addInitScript((spoken) => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as Record<string, unknown>).__speechLang = this.lang;
        const res = (t: string, isFinal: boolean) => Object.assign([{ transcript: t }], { isFinal });
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res(spoken.slice(0, 3), false)] }), 200);
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res(spoken, true)] }), 600);
        setTimeout(() => this.onend?.(), 800);
      }
      stop() {}
      abort() {}
    }
    const w = window as unknown as Record<string, unknown>;
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  }, text);
}

test.describe("ツール検索", () => {
  test("① ぴったりのツールがない文章でも、近いツールを出して知らせる", async ({ page }) => {
    await page.goto(`/tools?q=${encodeURIComponent("スマホの写真をまとめてPDFにして送りたい")}`);
    await expect(page.getByTestId("search-related-note")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('a[href="/tools/image-to-pdf"]').first()).toBeVisible();
    // ぴったり当てはまるときは、知らせを出さない
    await page.goto(`/tools?q=${encodeURIComponent("PDF 圧縮")}`);
    await expect(page.locator('a[href="/tools/pdf-compress"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("search-related-note")).toHaveCount(0);
  });

  test("① トップページの候補でも、近いツールを出して知らせる", async ({ page }) => {
    await page.goto("/");
    const input = page.getByTestId("home-search-input");
    await waitHydrated(input);
    await input.fill("スマホの写真をまとめてPDFにして送りたい");
    await expect(page.getByTestId("home-search-related")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("home-search-option").first()).toHaveAttribute("data-tool-id", "image-to-pdf");
  });

  test("② マイクのボタンで話すと、その言葉で検索する（日本語で聞き取る）", async ({ page }) => {
    await fakeSpeech(page, "動画を並べて比べたい");
    await page.goto("/tools");
    const mic = page.getByTestId("voice-search");
    await waitHydrated(mic);
    await mic.click();
    await expect(page).toHaveURL(/q=%E5%8B%95%E7%94%BB/, { timeout: 10_000 });
    await expect(page.locator("form", { has: page.getByTestId("voice-search") }).getByRole("searchbox")).toHaveValue("動画を並べて比べたい");
    await expect(page.locator('a[href="/tools/video-whiteboard"]').first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__speechLang)).toBe("ja-JP");
  });

  test("② トップページでも、話した言葉で候補を出す", async ({ page }) => {
    await fakeSpeech(page, "インタビューの音声を文字にしたい");
    await page.goto("/");
    const mic = page.getByTestId("home-voice-search");
    await waitHydrated(mic);
    await mic.click();
    await expect(page.getByTestId("home-search-input")).toHaveValue("インタビューの音声を文字にしたい", { timeout: 10_000 });
    await expect(page.getByTestId("home-search-option").first()).toHaveAttribute("data-tool-id", "audio-transcribe", { timeout: 15_000 });
  });

  test("② トップページの「声でツールを探す」ボタン：押すとすぐ聞き取りを始め、話した言葉が検索欄に入って候補が出る", async ({ page }) => {
    await fakeSpeech(page, "PDFを小さくしたい");
    await page.goto("/");
    const big = page.getByTestId("home-voice-big");
    await waitHydrated(big);
    await expect(big).toHaveText(/声でツールを探す/);
    await big.click();
    await expect(page.getByTestId("home-voice-status")).toContainText("聞き取っています");
    await expect(page.getByTestId("home-search-input")).toHaveValue("PDFを小さくしたい", { timeout: 10_000 });
    await expect(page.getByTestId("home-search-input")).toBeFocused();
    await expect(page.getByTestId("home-search-option").first()).toHaveAttribute("data-tool-id", "pdf-compress", { timeout: 15_000 });
    await expect(big).toHaveText(/声でツールを探す/);
    // 幕やせり上がる案内は出さない
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("② 音声認識のないブラウザでは、マイクのボタンを出さない", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.SpeechRecognition;
      delete w.webkitSpeechRecognition;
    });
    await page.goto("/tools");
    await waitHydrated(page.getByRole("searchbox", { name: "ツールを検索" }).first());
    await expect(page.getByTestId("voice-search")).toHaveCount(0);
    await page.goto("/");
    await waitHydrated(page.getByTestId("home-search-input"));
    await expect(page.getByTestId("home-voice-big")).toHaveCount(0);
    await expect(page.getByTestId("home-voice-search")).toHaveCount(0);
  });

  test("③ AIに相談すると、合うツールと使う順番が出る（同意してから送る）", async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await page.route("**/api/ai/usage", (route) => route.fulfill({ json: USAGE_OK }));
    await page.route("**/api/ai/tool-search", async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        json: { ok: true, picks: [{ id: "voice-recorder", reason: "会議をそのまま録音できます" }, { id: "audio-transcribe", reason: "録音を文字にできます" }], steps: ["録音で会議を録る", "文字起こし（AI）で文字にする"], note: "", rejected: 0, usage: USAGE_OK.usage },
      });
    });
    await page.goto(`/tools?q=${encodeURIComponent("会議を録音して議事録を作りたい")}`);
    await page.getByTestId("tool-search-ai-toggle").click();
    await expect(page.getByTestId("tool-search-ai-text")).toHaveValue("会議を録音して議事録を作りたい", { timeout: 15_000 });
    await expect(page.getByTestId("tool-search-ai-run")).toBeDisabled();
    await page.getByTestId("tool-search-ai-consent").check();
    await page.getByTestId("tool-search-ai-run").click();
    const picks = page.getByTestId("tool-search-ai-pick");
    await expect(picks).toHaveCount(2, { timeout: 15_000 });
    await expect(picks.first().locator("a")).toHaveAttribute("href", "/tools/voice-recorder");
    await expect(picks.first()).toContainText("会議をそのまま録音できます");
    await expect(page.getByTestId("tool-search-ai-steps")).toContainText("文字起こし（AI）で文字にする");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ text: "会議を録音して議事録を作りたい", consent: { accepted: true, version: TOOL_SEARCH_CONSENT_VERSION } });
    // 同意は実行のたびに確認する
    await expect(page.getByTestId("tool-search-ai-consent")).not.toBeChecked();
  });

  test("③ プレミアムでない人には、プランの案内だけを出す", async ({ page }) => {
    let called = false;
    await page.route("**/api/ai/usage", (route) => route.fulfill({ json: { available: false, reason: "not_premium" } }));
    await page.route("**/api/ai/tool-search", (route) => {
      called = true;
      return route.abort();
    });
    await page.goto(`/tools?q=${encodeURIComponent("PDF 圧縮")}`);
    await page.getByTestId("tool-search-ai-toggle").click();
    await expect(page.getByTestId("ai-unavailable")).toContainText("プレミアムプランの機能", { timeout: 15_000 });
    await expect(page.getByTestId("tool-search-ai-run")).toHaveCount(0);
    expect(called).toBe(false);
  });
});
