import { test, expect } from "@playwright/test";
import {
  TRANSCRIBE_CONSENT_VERSION,
  TRANSCRIBE_MAX_PROMPT_CHARS,
  buildTranscribePrompt,
  encodeWavPcm16Mono,
  estimateTranscribeAiTokens,
  parseWavPcm16,
  transcribeCostMicroUsd,
  transcribeReserveMicroUsd,
  validateTranscribeAudio,
  validateTranscribeFields,
} from "@/lib/ai/transcribe";
import { callOpenAiTranscribe, interpretTranscribeResponse, type OpenAiTranscribeResult } from "@/lib/ai/openai-transcribe";
import { handleTranscribe, type AssistDeps, type Availability, type Caller } from "@/lib/ai/service";
import { frameEnergy, planChunks, speechThreshold, splitTranscriptText, timeSegments, toPlainText, toSrt, toTimestampedText, voicedRanges } from "@/lib/transcribe/transcript";
import { MemoryLedger, USER_ID, newRequestId } from "./helpers";

/**
 * AI文字起こし（工程：プレミアムの文字起こし）の、計算・検証・サーバーの流れのテスト。
 * 本物のOpenAIは呼ばない（呼び出しは差し替える）。
 */

const RATE = 16_000;

/** 声のかわりの音（440Hz）と無音を並べた、16kHzの音声。parts は [秒, 音あり] */
function makeSamples(parts: [number, boolean][]): Int16Array {
  const total = parts.reduce((s, [sec]) => s + Math.round(sec * RATE), 0);
  const out = new Int16Array(total);
  let i = 0;
  for (const [sec, loud] of parts) {
    const n = Math.round(sec * RATE);
    for (let k = 0; k < n; k++, i++) out[i] = loud ? Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 8000) : Math.round((Math.random() - 0.5) * 40);
  }
  return out;
}

test.describe("文字起こし: WAV・料金・依頼の項目", () => {
  test("WAVの書き出しと読み取りが一致する。長さはデータ量から計算する", () => {
    const wav = encodeWavPcm16Mono(new Int16Array(RATE * 2), RATE);
    const info = parseWavPcm16(wav);
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.sampleRate).toBe(RATE);
      expect(info.channels).toBe(1);
      expect(info.dataOffset).toBe(44);
      expect(info.durationSec).toBeCloseTo(2, 5);
    }
    expect(validateTranscribeAudio(wav)).toEqual({ ok: true, durationSec: 2 });
  });

  test("サーバーは、16kHz・モノラル・60.5秒以下のWAVだけを受け付ける", () => {
    expect(validateTranscribeAudio(new Uint8Array([1, 2, 3])).ok).toBe(false);
    expect(validateTranscribeAudio(encodeWavPcm16Mono(new Int16Array(44_100), 44_100)).ok).toBe(false);
    expect(validateTranscribeAudio(encodeWavPcm16Mono(new Int16Array(RATE * 61), RATE)).ok).toBe(false);
    expect(validateTranscribeAudio(encodeWavPcm16Mono(new Int16Array(100), RATE)).ok).toBe(false);
    // ヘッダーが実際より長いデータを宣言していても、実際のバイト数で数える（多く数えさせない）
    const wav = encodeWavPcm16Mono(new Int16Array(RATE), RATE);
    new DataView(wav.buffer).setUint32(40, 0xffffffff, true);
    const info = parseWavPcm16(wav);
    expect(info.ok && info.durationSec).toBeCloseTo(1, 5);
    // 余計なチャンク（LIST）は飛ばす
    const extra = new Uint8Array(wav.length + 12);
    extra.set(wav.subarray(0, 36));
    extra.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], 36);
    extra.set(wav.subarray(36), 48);
    new DataView(extra.buffer).setUint32(52, RATE * 2, true);
    const withList = parseWavPcm16(extra);
    expect(withList.ok && withList.dataOffset).toBe(56);
  });

  test("料金は音声の長さだけで決まる（0.0045ドル/分 = 75µUSD/秒）。予約は余裕を足す", () => {
    expect(transcribeCostMicroUsd(60)).toBe(4_500);
    expect(transcribeCostMicroUsd(0.01)).toBe(1);
    expect(transcribeReserveMicroUsd(60)).toBe(4_950);
    expect(transcribeReserveMicroUsd(0)).toBe(75);
    // 1分 = 45,000 AIトークン。1期間の枠（3,000,000µUSD）で約11時間
    expect(estimateTranscribeAiTokens(60)).toBe(45_000);
  });

  test("依頼の項目: 番号・言語・ヒントの長さを確かめる。制御文字は取り除く", () => {
    const id = newRequestId();
    expect(validateTranscribeFields({ requestId: id })).toEqual({ ok: true, value: { requestId: id, language: "ja", prompt: "" } });
    expect(validateTranscribeFields({ requestId: "x" }).ok).toBe(false);
    expect(validateTranscribeFields({ requestId: id, language: "fr" }).ok).toBe(false);
    expect(validateTranscribeFields({ requestId: id, prompt: "あ".repeat(TRANSCRIBE_MAX_PROMPT_CHARS + 1) }).ok).toBe(false);
    const v = validateTranscribeFields({ requestId: id, language: "auto", prompt: "a\u0000b\nc" });
    expect(v.ok && v.value).toEqual({ requestId: id, language: "auto", prompt: "ab\nc" });
  });

  test("ヒント: 用語と、直前の文字起こしの末尾（200文字）をつなぐ。上限で切る", () => {
    expect(buildTranscribePrompt("", "")).toBe("");
    expect(buildTranscribePrompt(" Mr.Satto、 山田 ", "")).toBe("用語: Mr.Satto、 山田");
    const p = buildTranscribePrompt("用語", "あ".repeat(500) + "おわり");
    expect(p.startsWith("用語: 用語\n")).toBe(true);
    expect(p.endsWith("おわり")).toBe(true);
    expect(p.length).toBeLessThanOrEqual(TRANSCRIBE_MAX_PROMPT_CHARS);
  });
});

test.describe("文字起こし: 区切り方と時間の割り当て", () => {
  test("長い音声は、目安の40秒付近の静かな位置で区切る。どの区切りも58秒以下", () => {
    // 0〜37秒 声、37〜38秒 無音、38〜80秒 声、80〜81秒 無音、81〜125秒 声
    const samples = makeSamples([
      [37, true],
      [1, false],
      [42, true],
      [1, false],
      [44, true],
    ]);
    const energy = frameEnergy(samples, RATE);
    const chunks = planChunks(energy);
    expect(chunks.length).toBe(3);
    expect(chunks[0].end).toBeGreaterThan(37);
    expect(chunks[0].end).toBeLessThan(38);
    expect(chunks[1].end).toBeGreaterThan(80);
    expect(chunks[1].end).toBeLessThan(81);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(58.5);
    expect(chunks[chunks.length - 1].end).toBeCloseTo(125, 1);
  });

  test("短い音声は1つ。声のある時間を見つけ、無音だけの範囲は空になる", () => {
    const samples = makeSamples([
      [1, false],
      [2, true],
      [1, false],
      [1.5, true],
    ]);
    const energy = frameEnergy(samples, RATE);
    const chunks = planChunks(energy);
    expect(chunks).toHaveLength(1);
    const thr = speechThreshold(energy);
    const voiced = voicedRanges(energy, thr, chunks[0]);
    expect(voiced).toHaveLength(2);
    expect(voiced[0].start).toBeCloseTo(1, 1);
    expect(voiced[0].end).toBeCloseTo(3, 1);
    // 無音がほとんどない録音でも、声を無音と見なさない
    const continuous = frameEnergy(makeSamples([[10, true]]), RATE);
    expect(voicedRanges(continuous, speechThreshold(continuous), { start: 0, end: 10 })).toHaveLength(1);
    const silent = makeSamples([[5, false]]);
    const e2 = frameEnergy(silent, RATE);
    expect(voicedRanges(e2, speechThreshold(e2), { start: 0, end: 5 })).toEqual([]);
  });

  test("文の分け方: 句点・疑問符・改行で分け、長い文は読点で分ける", () => {
    expect(splitTranscriptText("こんにちは。元気ですか？\nはい")).toEqual(["こんにちは。", "元気ですか？", "はい"]);
    expect(splitTranscriptText("Hello world. It costs 3.5 dollars.")).toEqual(["Hello world.", "It costs 3.5 dollars."]);
    const long = "本日の会議では来期の予算について、各部署から出された要望を確認し、優先順位を決めていきたいと思います。";
    const parts = splitTranscriptText(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(long);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(36);
  });

  test("時間の割り当て: 声のある時間に文字数の割合で並べ、重ならず、区切りの範囲に収まる", () => {
    const segs = timeSegments("一つ目の文です。二つ目の、少し長めの文です。", { start: 40, end: 50 }, [
      { start: 1, end: 4 },
      { start: 6, end: 9 },
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBeCloseTo(41, 2);
    expect(segs[1].end).toBeCloseTo(49, 2);
    expect(segs[0].end).toBeLessThanOrEqual(segs[1].start);
    expect(timeSegments("", { start: 0, end: 5 }, [])).toEqual([]);
  });

  test("書き出し: SRT・時刻つき・時刻なし", () => {
    const segs = [
      { start: 1.5, end: 3.25, text: "こんにちは。" },
      { start: 3.25, end: 65, text: "よろしくお願いします。" },
      { start: 70, end: 72, text: "次の話です。" },
    ];
    expect(toSrt(segs.slice(0, 1))).toBe("1\n00:00:01,500 --> 00:00:03,250\nこんにちは。\n");
    expect(toTimestampedText(segs)).toBe("[00:00:01] こんにちは。\n[00:00:03] よろしくお願いします。\n[00:01:10] 次の話です。");
    expect(toPlainText(segs)).toBe("こんにちは。よろしくお願いします。\n\n次の話です。");
  });
});

test.describe("文字起こし: OpenAIの呼び出し（差し替え）", () => {
  const audio = encodeWavPcm16Mono(new Int16Array(RATE), RATE);

  test("送る項目: モデル・形式・言語（自動のときは送らない）・ヒント。APIキーはヘッダーだけ", async () => {
    const seen: { url: string; auth: string | null; form: FormData }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), form: init.body as FormData });
      return new Response(JSON.stringify({ text: "こんにちは", usage: { type: "duration", seconds: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await callOpenAiTranscribe({ apiKey: "test-key", modelId: "gpt-transcribe", audio, language: "ja", prompt: "用語: A", timeoutMs: 5000, fetchImpl });
    expect(r).toEqual({ kind: "ok", text: "こんにちは", seconds: 1 });
    expect(seen[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seen[0].auth).toBe("Bearer test-key");
    expect(seen[0].form.get("model")).toBe("gpt-transcribe");
    expect(seen[0].form.get("response_format")).toBe("json");
    expect(seen[0].form.get("language")).toBe("ja");
    expect(seen[0].form.get("prompt")).toBe("用語: A");
    expect(seen[0].form.get("file")).toBeInstanceOf(Blob);
    await callOpenAiTranscribe({ apiKey: "k", modelId: "gpt-transcribe", audio, language: "auto", prompt: "", timeoutMs: 5000, fetchImpl });
    expect(seen[1].form.has("language")).toBe(false);
    expect(seen[1].form.has("prompt")).toBe(false);
  });

  test("結果の分類: 拒否は rejected、5xx・通信断・不正な応答は unknown", async () => {
    const respond = (status: number, body = "{}") => (async () => new Response(body, { status })) as unknown as typeof fetch;
    const base = { apiKey: "k", modelId: "gpt-transcribe", audio, language: "ja", prompt: "", timeoutMs: 5000 };
    expect(await callOpenAiTranscribe({ ...base, fetchImpl: respond(429) })).toEqual({ kind: "rejected", status: 429 });
    expect(await callOpenAiTranscribe({ ...base, fetchImpl: respond(413) })).toEqual({ kind: "rejected", status: 413 });
    expect(await callOpenAiTranscribe({ ...base, fetchImpl: respond(500) })).toEqual({ kind: "unknown", reason: "server" });
    expect(await callOpenAiTranscribe({ ...base, fetchImpl: respond(200, "not json") })).toEqual({ kind: "unknown", reason: "bad-response" });
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await callOpenAiTranscribe({ ...base, fetchImpl: broken })).toEqual({ kind: "unknown", reason: "network" });
    expect(interpretTranscribeResponse({ text: "a" })).toEqual({ kind: "ok", text: "a", seconds: null });
    expect(interpretTranscribeResponse({ usage: {} })).toEqual({ kind: "unknown", reason: "bad-response" });
  });
});

test.describe("文字起こし: サーバーの流れ（権限・同意・予約・確定）", () => {
  const AVAILABLE: Availability = { available: true };
  const PREMIUM: Caller = { userId: USER_ID, plan: "premium" };

  function setup(next: OpenAiTranscribeResult = { kind: "ok", text: "こんにちは。", seconds: null }) {
    const ledger = new MemoryLedger();
    ledger.premium.add(USER_ID);
    const calls: { language: string; prompt: string; bytes: number }[] = [];
    const logs: Record<string, unknown>[] = [];
    const deps: AssistDeps = {
      ledger,
      callModel: async () => {
        throw new Error("文字起こしでは使わない");
      },
      callTranscribe: async ({ audio, language, prompt }) => {
        calls.push({ language, prompt, bytes: audio.length });
        return next;
      },
      log: (e) => logs.push(e),
    };
    return { ledger, calls, logs, deps };
  }

  const fields = (over: Record<string, unknown> = {}) => ({
    requestId: newRequestId(),
    language: "ja",
    prompt: "",
    consentAccepted: "true",
    consentVersion: TRANSCRIBE_CONSENT_VERSION,
    ...over,
  });
  const wav = (sec: number) => encodeWavPcm16Mono(new Int16Array(Math.round(RATE * sec)), RATE);

  test("Premium・同意あり: 長さで予約→呼び出し1回→長さで確定。返すのは文字とAIトークンだけ", async () => {
    const { ledger, calls, logs, deps } = setup();
    const res = await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields(), audio: wav(40) });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("こんにちは。");
    expect(res.body.durationSec).toBe(40);
    expect(calls).toHaveLength(1);
    expect(ledger.calls).toEqual(["reserve", "settle"]);
    expect(ledger.spent).toBe(3_000);
    expect(ledger.reserved).toBe(0);
    expect(JSON.stringify(res.body)).not.toMatch(/micro|usd/i);
    // ログに文字起こしの中身を残さない
    expect(JSON.stringify(logs)).not.toContain("こんにちは");
  });

  test("OpenAIが返した長さのほうが長ければ、そちらで確定する（多めに数える）", async () => {
    const { ledger, deps } = setup({ kind: "ok", text: "a", seconds: 50 });
    await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields(), audio: wav(40) });
    expect(ledger.spent).toBe(3_750);
  });

  test("Premium以外・未ログイン・同意なし・同意の版違いは、予約もAIの呼び出しもしない", async () => {
    const { ledger, calls, deps } = setup();
    expect((await handleTranscribe(deps, { userId: USER_ID, plan: "standard" }, AVAILABLE, { fields: fields(), audio: wav(5) })).status).toBe(403);
    expect((await handleTranscribe(deps, { userId: null, plan: "free" }, AVAILABLE, { fields: fields(), audio: wav(5) })).status).toBe(401);
    expect((await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields({ consentAccepted: "false" }), audio: wav(5) })).status).toBe(400);
    expect((await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields({ consentVersion: "old" }), audio: wav(5) })).status).toBe(400);
    expect((await handleTranscribe(deps, PREMIUM, { available: false, reason: "billing_off" }, { fields: fields(), audio: wav(5) })).status).toBe(503);
    expect(calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("音声の形式・長さが正しくなければ断る（予約しない）", async () => {
    const { ledger, calls, deps } = setup();
    for (const audio of [null, new Uint8Array(10), encodeWavPcm16Mono(new Int16Array(44_100), 44_100), wav(61)]) {
      const res = await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields(), audio });
      expect(res.status).toBe(400);
    }
    expect((await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields({ requestId: "bad" }), audio: wav(5) })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("拒否（429など）は予約を解放する。通信が不確かなときは、解放も確定もしない", async () => {
    const rejected = setup({ kind: "rejected", status: 429 });
    const r1 = await handleTranscribe(rejected.deps, PREMIUM, AVAILABLE, { fields: fields(), audio: wav(10) });
    expect(r1.status).toBe(502);
    expect(rejected.ledger.calls).toEqual(["reserve", "release"]);
    expect(rejected.ledger.reserved).toBe(0);

    const unknown = setup({ kind: "unknown", reason: "timeout" });
    const r2 = await handleTranscribe(unknown.deps, PREMIUM, AVAILABLE, { fields: fields(), audio: wav(10) });
    expect(r2.status).toBe(504);
    expect(unknown.ledger.calls).toEqual(["reserve"]);
    expect(unknown.ledger.reserved).toBe(transcribeReserveMicroUsd(10));
  });

  test("利用枠が足りなければ、AIを呼ばずに断る。文字起こしが設定されていなければ503", async () => {
    const { ledger, calls, deps } = setup();
    ledger.limit = 100;
    const res = await handleTranscribe(deps, PREMIUM, AVAILABLE, { fields: fields(), audio: wav(10) });
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(0);
    const noTranscribe: AssistDeps = { ...deps, callTranscribe: undefined };
    expect((await handleTranscribe(noTranscribe, PREMIUM, AVAILABLE, { fields: fields(), audio: wav(10) })).status).toBe(503);
  });
});

test.describe("文字起こし: APIの入口（開発サーバー）", () => {
  test.skip(!!process.env.OPENAI_API_KEY, "OPENAI_API_KEY が設定された環境では実行しない（実際のAIを呼ばないため）");

  test("フォーム以外は415、他サイトからは403、大きすぎる本文は413、設定が無ければ503（AIは呼ばない）", async ({ request }) => {
    const json = await request.post("/api/ai/transcribe", { headers: { "Content-Type": "application/json" }, data: "{}" });
    expect(json.status()).toBe(415);
    const foreign = await request.post("/api/ai/transcribe", { headers: { Origin: "https://evil.example" }, multipart: { requestId: newRequestId() } });
    expect(foreign.status()).toBe(403);
    const big = await request.post("/api/ai/transcribe", { multipart: { audio: { name: "a.wav", mimeType: "audio/wav", buffer: Buffer.alloc(2_200_000) } } });
    expect(big.status()).toBe(413);
    const ok = await request.post("/api/ai/transcribe", {
      multipart: {
        requestId: newRequestId(),
        consentAccepted: "true",
        consentVersion: TRANSCRIBE_CONSENT_VERSION,
        audio: { name: "a.wav", mimeType: "audio/wav", buffer: Buffer.from(encodeWavPcm16Mono(new Int16Array(RATE), RATE)) },
      },
    });
    expect(ok.status()).toBe(503);
    expect(ok.headers()["cache-control"]).toContain("no-store");
    expect(JSON.stringify(await ok.json())).not.toMatch(/sk-|api[_-]?key|OPENAI/i);
  });
});
