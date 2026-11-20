import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { applyReadings, pickDefaultVoice, sortVoices, splitForSpeech } from "@/lib/tts/speech-text";
import { extensionForType, formatClock, RecordingClock, timestampName } from "@/lib/media/recorder";
import { waitHydrated } from "../helpers/hydrated";

/**
 * テキスト読み上げ・録音・画面録画（2026-11-18）
 * - 部品：文の区切り方・読みの登録・声の選び方・録音の時間の数え方
 * - 画面：読み上げ（声の一覧と注意書き・文ごとの読み上げ）、録音（マイクで録ってMP3で保存）、
 *   画面録画（画面＋カメラを重ねて録る・スマホ等で使えないときの案内）、マイク・カメラの許可の範囲
 *
 * マイク・カメラは Chromium の「偽物の機器」（--use-fake-device-for-media-stream）を使う。
 * 画面の共有は、テストの中では選ぶ画面を出せないため、動く絵（canvas）を返す偽物に差し替える。
 */

// ---------------------------------------------------------------------------
// 1. 部品
// ---------------------------------------------------------------------------
plainTest.describe("読み上げ・録音：部品", () => {
  plainTest("文に区切る：「。」「！」「？」と改行で区切り、閉じかっこは前の文に含める。長い文は「、」で分ける", () => {
    const chunks = splitForSpeech("こんにちは。「元気？」と聞いた！\n次の行です\n\n  最後。");
    plainExpect(chunks.map((c) => c.text)).toEqual(["こんにちは。", "「元気？」", "と聞いた！", "次の行です", "最後。"]);
    // 元の文章の中の位置を持つ
    plainExpect(chunks[0]).toMatchObject({ start: 0, end: 6 });
    const long = "あ".repeat(50) + "、" + "い".repeat(50) + "、" + "う".repeat(50) + "。";
    const parts = splitForSpeech(long, 120);
    plainExpect(parts.length).toBe(2);
    plainExpect(parts.every((p) => p.text.length <= 120)).toBe(true);
    plainExpect(parts[0].text.endsWith("、")).toBe(true);
    plainExpect(parts.map((p) => p.text).join("")).toBe(long);
  });

  plainTest("読みの登録：長い言葉から先に置き換える。空欄の行は無視する", () => {
    const entries = [
      { word: "明日", reading: "あした" },
      { word: "明日香", reading: "あすか" },
      { word: "", reading: "なし" },
    ];
    plainExpect(applyReadings("明日香と明日会う", entries)).toBe("あすかとあした会う");
    plainExpect(applyReadings("そのまま", [])).toBe("そのまま");
  });

  plainTest("声の並べ方：日本語 → 端末の中だけで動く声 の順。最初は日本語の端末の声を選ぶ", () => {
    const voices = [
      { name: "Google US English", lang: "en-US", localService: false },
      { name: "Google 日本語", lang: "ja-JP", localService: false },
      { name: "Samantha", lang: "en-US", localService: true },
      { name: "Kyoko", lang: "ja-JP", localService: true },
    ];
    plainExpect(sortVoices(voices).map((v) => v.name)).toEqual(["Kyoko", "Google 日本語", "Samantha", "Google US English"]);
    plainExpect(pickDefaultVoice(voices)?.name).toBe("Kyoko");
    // 日本語の端末の声がないときは、日本語のネットの声
    plainExpect(pickDefaultVoice(voices.filter((v) => v.name !== "Kyoko"))?.name).toBe("Google 日本語");
    plainExpect(pickDefaultVoice([])).toBeNull();
  });

  plainTest("録音の部品：形式から拡張子、時間の表示、一時停止を除いた時間、日時入りの名前", () => {
    plainExpect(extensionForType("audio/webm;codecs=opus")).toBe("webm");
    plainExpect(extensionForType("audio/mp4")).toBe("m4a");
    plainExpect(extensionForType("video/mp4;codecs=avc1")).toBe("mp4");
    plainExpect(formatClock(65)).toBe("1:05");
    plainExpect(formatClock(3725)).toBe("1:02:05");
    const c = new RecordingClock();
    c.start(0);
    c.pause(2000);
    c.start(5000);
    plainExpect(c.elapsedSec(6500)).toBeCloseTo(3.5);
    plainExpect(timestampName("録音", new Date(2026, 10, 18, 9, 5))).toBe("録音_20261118-0905");
  });
});

// ---------------------------------------------------------------------------
// 2. マイク・カメラの許可の範囲（ほかのページでは使えないまま）
// ---------------------------------------------------------------------------
test("カメラ・画面の共有は画面録画のページだけ許可。マイクは自分のサイトだけに許可（話して探す検索のため、どのページでも）", async ({ request }) => {
  const policy = async (url: string) => (await request.get(url)).headers()["permissions-policy"] ?? "";
  expect(await policy("/tools/voice-recorder")).toContain("microphone=(self)");
  expect(await policy("/tools/voice-recorder")).toContain("camera=()");
  const screen = await policy("/tools/screen-recorder");
  expect(screen).toContain("microphone=(self)");
  expect(screen).toContain("camera=(self)");
  expect(screen).toContain("display-capture=(self)");
  for (const url of ["/", "/tools/pdf-fix", "/tools/text-to-speech"]) {
    const p = await policy(url);
    // マイクは自分のサイトだけ（広告などの埋め込みには許可しない）。カメラは使えないまま
    expect(p, url).toContain("microphone=(self)");
    expect(p, url).toContain("camera=()");
    expect(p, url).not.toContain("display-capture=(self)");
  }
});

// ---------------------------------------------------------------------------
// 3. テキスト読み上げ（ブラウザの読み上げを偽物に差し替えて、何を読ませたかを確かめる）
// ---------------------------------------------------------------------------
const FAKE_SPEECH = `
  (() => {
    const voices = [
      { name: "Google 日本語", lang: "ja-JP", localService: false, voiceURI: "google-ja", default: false },
      { name: "Kyoko", lang: "ja-JP", localService: true, voiceURI: "kyoko", default: true },
      { name: "Samantha", lang: "en-US", localService: true, voiceURI: "samantha", default: false },
    ];
    window.__spoken = [];
    let current = null;
    const synth = {
      speaking: false, paused: false, pending: false,
      getVoices: () => voices,
      addEventListener() {}, removeEventListener() {},
      speak(u) {
        window.__spoken.push({ text: u.text, voice: u.voice && u.voice.name, rate: u.rate });
        current = u;
        setTimeout(() => { if (current === u) { u.onstart && u.onstart({}); } }, 10);
        setTimeout(() => { if (current === u) { current = null; u.onend && u.onend({}); } }, 400);
      },
      cancel() { const u = current; current = null; if (u && u.onerror) u.onerror({ error: "canceled" }); },
      pause() { this.paused = true; }, resume() { this.paused = false; },
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  })();
`;

test.describe("テキスト読み上げ", () => {
  test("最初は端末の中だけで動く声を選び、ネットを使う声を選ぶと注意書きが出る。文ごとに、読みの登録を当てはめて読む", async ({ page }) => {
    await page.addInitScript(FAKE_SPEECH);
    await page.goto("/tools/text-to-speech");
    await waitHydrated(page.getByTestId("tts-text"));
    const voice = page.getByTestId("tts-voice");
    await expect(voice).toHaveValue("kyoko");
    await expect(page.getByTestId("tts-network-warning")).toHaveCount(0);
    // ネットを使う声には、一覧でも印が付き、選ぶと注意書きが出る
    await expect(voice.locator("option", { hasText: "Google 日本語" })).toHaveText(/ネットを使う声/);
    await voice.selectOption("google-ja");
    await expect(page.getByTestId("tts-network-warning")).toBeVisible();
    await voice.selectOption("kyoko");
    await expect(page.getByTestId("tts-network-warning")).toHaveCount(0);

    await page.getByTestId("tts-text").fill("明日は晴れです。明日香さんも来ます。");
    await expect(page.getByTestId("tts-chunk")).toHaveCount(2);
    // 読みの登録
    await page.locator("summary", { hasText: "読みの登録" }).click();
    await page.getByLabel("1件目の言葉").fill("明日");
    await page.getByLabel("1件目の読み").fill("あした");
    await page.getByTestId("tts-play").click();
    await expect(page.getByTestId("tts-chunk").first()).toHaveAttribute("data-current", "true");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: unknown[] }).__spoken.length), { timeout: 5000 }).toBe(2);
    const spoken = await page.evaluate(() => (window as unknown as { __spoken: { text: string; voice: string }[] }).__spoken);
    expect(spoken.map((s) => s.text)).toEqual(["あしたは晴れです。", "あした香さんも来ます。"]);
    expect(spoken.every((s) => s.voice === "Kyoko")).toBe(true);
    // 読み終わると元に戻る
    await expect(page.getByTestId("tts-state")).toHaveAttribute("data-state", "idle", { timeout: 5000 });
    // 画面に出す文は変えない
    await expect(page.getByTestId("tts-chunk").first()).toHaveText("明日は晴れです。");
  });

  test("読み上げに対応していないブラウザでは、案内を出す", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
    });
    await page.goto("/tools/text-to-speech");
    await expect(page.getByTestId("tts-unsupported")).toBeVisible();
    await expect(page.getByTestId("tts-text")).toHaveCount(0);
  });
});
