import fs from "node:fs";
import { test, expect } from "../fixtures/premium-test";
import { waitHydrated } from "../helpers/hydrated";
import { downsampleTo16k } from "@/lib/transcribe/live";
import { TRANSCRIBE_CONSENT_VERSION, parseWavPcm16 } from "@/lib/ai/transcribe";

/**
 * 録音のリアルタイム文字起こし（2026-11-19）。
 * マイクは Chromium の偽物の機器（ピッという音が鳴り続ける）。
 * - かんたん：ブラウザの音声認識を、決まった文字を返す偽物に差し替える。
 * - 高精度：AIのAPI（/api/ai/*）をテスト内で差し替える（実際のOpenAIには接続しない）。
 */
test.use({
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 0, remainingAiTokens: 30_000_000, periodEnd: "2026-11-30T00:00:00Z" } };

test.describe("録音のリアルタイム文字起こし", () => {
  test("16kHzへの間引き：長さが比率どおりで、端数は次に持ち越す", () => {
    const carry = { pos: 0 };
    const a = downsampleTo16k(new Float32Array(4800).fill(0.5), 48_000, carry);
    expect(a.length).toBe(1600);
    expect(a[0]).toBe(Math.round(0.5 * 32767));
    const b = downsampleTo16k(new Float32Array(4410), 44_100, carry);
    expect(b.length).toBeGreaterThanOrEqual(1599);
    expect(b.length).toBeLessThanOrEqual(1601);
  });

  test("既定はオフ。かんたん（ブラウザの音声認識）をオンにすると、話している途中の文字と、確定した文が時刻つきで出る。止まっても自動でつなぎ直す", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      let started = 0;
      class FakeRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        onresult: ((e: unknown) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          started++;
          w.__recognitionStarts = started;
          w.__recognitionLang = this.lang;
          const n = started;
          const res = (text: string, isFinal: boolean) => Object.assign([{ transcript: text }], { isFinal });
          setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res(`${n}回目のテス`, false)] }), 300);
          setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res(`${n}回目のテストです`, true)] }), 1500);
          // ブラウザは、しばらくすると自分で止まる
          if (n === 1) setTimeout(() => this.onend?.(), 1800);
        }
        stop() {
          setTimeout(() => this.onend?.(), 0);
        }
        abort() {}
      }
      // 新しい Chrome は名前の頭に webkit が付かないものも持っているので、両方を差し替える
      w.webkitSpeechRecognition = FakeRecognition;
      w.SpeechRecognition = FakeRecognition;
    });
    await page.goto("/tools/voice-recorder");
    await waitHydrated(page.getByTestId("recorder-start"));
    await expect(page.getByTestId("live-toggle")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("live-toggle").click();
    await expect(page.getByTestId("live-mode-browser")).toBeChecked();
    await page.getByTestId("recorder-start").click();
    await expect(page.getByTestId("live-interim")).toContainText("1回目のテス", { timeout: 10_000 });
    await expect(page.getByTestId("live-line").first()).toContainText("1回目のテストです");
    // 自動でつなぎ直して、続きも文字になる
    await expect(page.getByTestId("live-line").nth(1)).toContainText("2回目のテストです", { timeout: 10_000 });
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__recognitionLang)).toBe("ja-JP");
    await page.getByTestId("recorder-stop").click();
    await expect(page.getByTestId("recorder-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("live-line").first()).toContainText(/00:00:0\d/);
    const wait = page.waitForEvent("download");
    await page.getByTestId("live-save-txt").click();
    const d = await wait;
    expect(d.suggestedFilename()).toMatch(/^録音_\d{8}-\d{4}_文字起こし\.txt$/);
    expect(fs.readFileSync((await d.path())!, "utf8")).toMatch(/^\[00:00:0\d\] 1回目のテストです\n\[00:00:0\d\] 2回目のテストです$/);
  });

  test("高精度（AI）：同意しないと録音を始められない。同意して録音すると、止めたときに残りの音声をAIへ送り、文が足される", async ({ page }) => {
    const sent: { fields: Record<string, string>; durationSec: number }[] = [];
    await page.route("**/api/ai/usage", (route) => route.fulfill({ json: USAGE_OK }));
    await page.route("**/api/ai/transcribe", async (route) => {
      const req = route.request();
      const form = await new Response(new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0)), { headers: { "content-type": req.headers()["content-type"] } }).formData();
      const fields: Record<string, string> = {};
      let durationSec = 0;
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") fields[k] = v;
        else {
          const info = parseWavPcm16(new Uint8Array(await v.arrayBuffer()));
          durationSec = info.ok && info.sampleRate === 16_000 && info.channels === 1 ? info.durationSec : -1;
        }
      }
      sent.push({ fields, durationSec });
      await route.fulfill({ json: { ok: true, text: "録音しながらの文字起こしです。", usage: USAGE_OK.usage } });
    });
    // 偽物のマイクは短いピッという音だけ（話し声と判断されない）なので、鳴り続ける音のマイクに差し替える
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.3;
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain).connect(dest);
        osc.start();
        return dest.stream;
      };
    });
    await page.goto("/tools/voice-recorder");
    await waitHydrated(page.getByTestId("recorder-start"));
    await page.getByTestId("live-toggle").click();
    await page.getByTestId("live-mode-ai").check();
    await expect(page.getByTestId("live-ai-remaining")).toContainText("約666分", { timeout: 15_000 });
    await page.getByTestId("recorder-start").click();
    await expect(page.getByText("同意にチェックしてください")).toBeVisible();
    await expect(page.getByTestId("recorder-phase")).toHaveAttribute("data-phase", "idle");

    await page.getByTestId("live-terms").fill("Mr.Satto");
    await page.getByTestId("live-ai-consent").check();
    await page.getByTestId("recorder-start").click();
    await expect(page.getByTestId("recorder-phase")).toHaveAttribute("data-phase", "recording", { timeout: 15_000 });
    await page.waitForTimeout(3000);
    expect(sent).toHaveLength(0); // 30秒たまるまでは送らない
    await page.getByTestId("recorder-stop").click();
    await expect(page.getByTestId("live-line").first()).toContainText("録音しながらの文字起こしです。", { timeout: 20_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0].durationSec).toBeGreaterThan(2);
    expect(sent[0].durationSec).toBeLessThan(5);
    expect(sent[0].fields.consentVersion).toBe(TRANSCRIBE_CONSENT_VERSION);
    expect(sent[0].fields.prompt).toBe("用語: Mr.Satto");
    // 同意は録音1回ごと
    await expect(page.getByTestId("live-ai-consent")).not.toBeChecked();
    await expect(page.getByTestId("live-save-srt")).toBeVisible();
  });

  test("高精度（AI）：プレミアムでない人には案内だけを出し、録音を始めようとすると知らせる", async ({ page }) => {
    await page.route("**/api/ai/usage", (route) => route.fulfill({ json: { available: false, reason: "not_premium" } }));
    await page.goto("/tools/voice-recorder");
    await waitHydrated(page.getByTestId("recorder-start"));
    await page.getByTestId("live-toggle").click();
    await page.getByTestId("live-mode-ai").check();
    await expect(page.getByTestId("ai-unavailable")).toContainText("プレミアムプランの機能", { timeout: 15_000 });
    await page.getByTestId("recorder-start").click();
    await expect(page.getByText("プレミアムプランでログインしているときに使えます")).toBeVisible();
  });
});
