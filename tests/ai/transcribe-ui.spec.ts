import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { uploadFixture } from "../helpers/tool-runner";
import { TRANSCRIBE_CONSENT_VERSION, encodeWavPcm16Mono, parseWavPcm16 } from "@/lib/ai/transcribe";

/**
 * 文字起こし（AI）と、動画字幕の「AIで字幕を自動で作る」の画面のテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAIには接続しない（音声の認識の正確さは、このテストでは確かめられない）。
 */

const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_000, remainingAiTokens: 29_999_000, periodEnd: "2026-11-30T00:00:00Z" } };
const RATE = 16_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-ui-"));

/** 声のかわりの音（440Hz）と無音を並べたWAVを作る。parts は [秒, 音あり] */
function makeWav(name: string, parts: [number, boolean][]): string {
  const total = parts.reduce((s, [sec]) => s + Math.round(sec * RATE), 0);
  const samples = new Int16Array(total);
  let i = 0;
  for (const [sec, loud] of parts) {
    for (let k = 0; k < Math.round(sec * RATE); k++, i++) samples[i] = loud ? Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 8000) : 0;
  }
  const file = path.join(tmp(), name);
  fs.writeFileSync(file, encodeWavPcm16Mono(samples, RATE));
  return file;
}

interface Sent {
  fields: Record<string, string>;
  audioBytes: number;
  durationSec: number;
}

async function mockAi(page: Page, opts: { usage?: unknown; reply?: (n: number, route: Route) => Promise<void> | void } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route("**/api/ai/usage", (route) => route.fulfill({ json: opts.usage ?? USAGE_OK }));
  await page.route("**/api/ai/transcribe", async (route) => {
    const req = route.request();
    const form = await new Response(new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0)), { headers: { "content-type": req.headers()["content-type"] } }).formData();
    const fields: Record<string, string> = {};
    let audioBytes = 0;
    let durationSec = 0;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
      else {
        const bytes = new Uint8Array(await v.arrayBuffer());
        audioBytes = bytes.length;
        const info = parseWavPcm16(bytes);
        durationSec = info.ok ? info.durationSec : -1;
      }
    }
    sent.push({ fields, audioBytes, durationSec });
    if (opts.reply) return opts.reply(sent.length, route);
    await route.fulfill({ json: { ok: true, text: `${sent.length}番目の区切りです。テストの文章です。`, durationSec, usage: USAGE_OK.usage } });
  });
  return sent;
}

test.describe("文字起こし（AI）", () => {
  test("ファイルを選ぶと長さと利用枠の目安が出る。同意すると実行でき、時刻つきの結果を直して保存できる", async ({ page }) => {
    const sent = await mockAi(page);
    await page.goto("/tools/audio-transcribe");
    await uploadFixture(page, makeWav("会議.wav", [[1, false], [3, true], [1, false], [3, true]]));
    await expect(page.getByTestId("tr-ai-estimate")).toContainText("00:00:08", { timeout: 30_000 });
    const run = page.getByTestId("tr-ai-run");
    await expect(run).toBeDisabled();
    await page.getByTestId("tr-ai-terms").fill("Mr.Satto");
    await page.getByTestId("tr-ai-consent").check();
    await run.click();
    await expect(page.getByTestId("transcribe-result")).toBeVisible({ timeout: 60_000 });

    // 送った内容: 16kHz・モノラルのWAV（約8秒）、同意の版、言語、用語のヒント
    expect(sent).toHaveLength(1);
    expect(sent[0].fields.consentAccepted).toBe("true");
    expect(sent[0].fields.consentVersion).toBe(TRANSCRIBE_CONSENT_VERSION);
    expect(sent[0].fields.language).toBe("ja");
    expect(sent[0].fields.prompt).toBe("用語: Mr.Satto");
    expect(sent[0].durationSec).toBeGreaterThan(7.5);
    expect(sent[0].durationSec).toBeLessThan(8.5);

    // 文は字幕の長さに分け、声のある時間（1秒〜）に割り当てる
    const segments = page.getByTestId("transcribe-segment");
    await expect(segments).toHaveCount(2);
    await expect(page.getByTestId("transcribe-output")).toContainText("[00:00:01] 1番目の区切りです。");
    await segments.nth(1).fill("直した文章です。");
    await expect(page.getByTestId("transcribe-output")).toContainText("直した文章です。");
    await page.getByTestId("transcribe-kind-plain").check();
    await expect(page.getByTestId("transcribe-output")).toHaveText("1番目の区切りです。直した文章です。");

    // 同意は実行のたびに確認する
    await expect(page.getByTestId("tr-ai-consent")).not.toBeChecked();

    const srt = page.waitForEvent("download");
    await page.getByTestId("transcribe-save-srt").click();
    const d = await srt;
    expect(d.suggestedFilename()).toBe("会議.srt");
    const text = fs.readFileSync(await d.path(), "utf-8");
    expect(text).toMatch(/^1\n00:00:01,\d{3} --> 00:00:0\d,\d{3}\n1番目の区切りです。\n/);
  });

  test("長い音声は区切って順に送り、途中で失敗したら、そこまでの結果を残して知らせる。話し声のない音声は送らない", async ({ page }) => {
    const sent = await mockAi(page, {
      reply: (n, route) =>
        n === 1
          ? route.fulfill({ json: { ok: true, text: "前半の文章です。", usage: USAGE_OK.usage } })
          : route.fulfill({ status: 429, json: { error: "rate_limited", message: "短時間に多く実行されました。少し待ってから、もう一度お試しください。" } }),
    });
    await page.goto("/tools/audio-transcribe");
    // 0〜39秒 声、39〜40秒 無音、40〜75秒 声 → 2つに区切る
    await uploadFixture(page, makeWav("long.wav", [[39, true], [1, false], [35, true]]));
    await page.getByTestId("tr-ai-consent").check({ timeout: 30_000 });
    await page.getByTestId("tr-ai-run").click();
    await expect(page.getByTestId("tr-ai-error")).toContainText("短時間に多く実行されました", { timeout: 60_000 });
    expect(sent).toHaveLength(2);
    expect(sent[0].durationSec).toBeGreaterThan(38);
    expect(sent[0].durationSec).toBeLessThan(41);
    // 2つ目の区切りには、直前の文字起こしの末尾をヒントとして渡す
    expect(sent[1].fields.prompt).toBe("前半の文章です。");
    for (const s of sent) expect(s.audioBytes).toBeLessThan(2_100_000);
    await expect(page.getByTestId("tr-ai-notice")).toContainText("までの分（1件）は、結果に入れました");
    await expect(page.getByTestId("transcribe-segment")).toHaveCount(1);

    // 無音だけの音声: 送らずに知らせる
    await uploadFixture(page, makeWav("silent.wav", [[5, false]]));
    await expect(page.getByTestId("tr-ai-estimate")).toContainText("00:00:05", { timeout: 30_000 });
    await page.getByTestId("tr-ai-consent").check();
    await page.getByTestId("tr-ai-run").click();
    await expect(page.getByTestId("tr-ai-notice")).toContainText("話し声が見つかりませんでした", { timeout: 60_000 });
    expect(sent).toHaveLength(2);
  });

  test("プレミアムでない人には、プランの案内だけを出し、実行できない", async ({ page }) => {
    const sent = await mockAi(page, { usage: { available: false, reason: "not_premium" } });
    await page.goto("/tools/audio-transcribe");
    await expect(page.getByTestId("ai-unavailable")).toContainText("プレミアムプランの機能", { timeout: 30_000 });
    await expect(page.getByTestId("ai-upgrade-link")).toBeVisible();
    await expect(page.getByTestId("tr-ai-run")).toHaveCount(0);
    expect(sent).toHaveLength(0);
  });
});

test.describe("動画字幕: AIで字幕を自動で作る", () => {
  test("動画の音声を文字起こしして、時間つきの字幕として加える（今ある字幕は残す）", async ({ page }) => {
    const video = path.join(tmp(), "talk.mp4");
    // 1秒無音 → 3秒音 → 1秒無音
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-af", "volume=enable='between(t,0,1)+between(t,4,5)':volume=0",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", video,
    ]);
    const sent = await mockAi(page, { reply: (_n, route) => route.fulfill({ json: { ok: true, text: "字幕のテストです。", usage: USAGE_OK.usage } }) });
    await page.goto("/tools/video-subtitle");
    await uploadFixture(page, video);
    await expect(page.getByTestId("vs-add")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("vs-add").click();
    await page.getByTestId("vs-ai-toggle").click();
    await page.getByTestId("vs-ai-consent").check({ timeout: 30_000 });
    await page.getByTestId("vs-ai-run").click();
    await expect(page.getByTestId("vs-cues").locator("> li")).toHaveCount(2, { timeout: 60_000 });
    expect(sent).toHaveLength(1);
    expect(await page.getByTestId("vs-cue-text-view").allTextContents()).toContain("字幕のテストです。");
  });
});

test.describe("音声の受け渡し", () => {
  test("音声形式変換の結果を、「ほかのツールで使う」から文字起こし（AI）へ渡せる", async ({ page }) => {
    test.setTimeout(120_000);
    await mockAi(page);
    await page.goto("/tools/audio-convert");
    await uploadFixture(page, makeWav("memo.wav", [[1, false], [2, true]]));
    await page.locator("label", { hasText: /^WAV$/ }).click({ timeout: 30_000 });
    await page.getByRole("button", { name: "変換する" }).click();
    await expect(page.getByText("変換が完了しました")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("handoff-open").click();
    await expect(page.getByTestId("handoff-panel")).toBeVisible();
    await expect(page.getByTestId("handoff-target-video-subtitle")).toHaveCount(0);
    await page.getByTestId("handoff-target-audio-transcribe").click();
    await expect(page).toHaveURL(/\/tools\/audio-transcribe/, { timeout: 30_000 });
    await expect(page.getByTestId("handoff-received-names")).toHaveText(/memo.*\.wav$/, { timeout: 30_000 });
    await expect(page.getByTestId("tr-ai-estimate")).toContainText("00:00:03", { timeout: 30_000 });
  });
});
