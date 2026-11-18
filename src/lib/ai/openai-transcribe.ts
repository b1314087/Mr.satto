/**
 * OpenAI の文字起こし API（/v1/audio/transcriptions）を呼ぶ最小のクライアント（fetchだけを使う）。
 * 結果の分類は openai-client.ts と同じ考え方（利用枠の確定・解放・そのままを決める根拠）:
 *   ok       : 処理された → 確定
 *   rejected : 400/401/403/404/413/415/422/429 → 処理されていない → 解放
 *   unknown  : タイムアウト・通信断・5xx・不正な応答 → 課金されたか分からない → そのまま
 * 音声・文字起こしの結果は、ここでもログに出さず、保存しない。APIキーは呼び出し側（サーバー）が渡す。
 */

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

/** 処理されていない（課金されていない）と言える、OpenAI側の拒否のステータス */
const NO_CHARGE_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

export interface OpenAiTranscribeInput {
  apiKey: string;
  modelId: string;
  /** 16kHz・モノラル・16bitのWAV */
  audio: Uint8Array;
  /** "auto" のときは送らない（AIが判断する） */
  language: string;
  prompt: string;
  timeoutMs: number;
  /** テスト用。通常は指定しない */
  fetchImpl?: typeof fetch;
}

export type OpenAiTranscribeResult =
  | { kind: "ok"; text: string; /** 応答に音声の長さ（秒）があれば */ seconds: number | null }
  | { kind: "rejected"; status: number }
  | { kind: "unknown"; reason: "timeout" | "network" | "server" | "bad-response" };

/** 200で返ってきた応答の本体を分類する */
export function interpretTranscribeResponse(data: unknown): OpenAiTranscribeResult {
  if (typeof data !== "object" || data === null) return { kind: "unknown", reason: "bad-response" };
  const d = data as Record<string, unknown>;
  if (typeof d.text !== "string") return { kind: "unknown", reason: "bad-response" };
  let seconds: number | null = null;
  const usage = d.usage;
  if (typeof usage === "object" && usage !== null) {
    const u = usage as Record<string, unknown>;
    if (u.type === "duration" && typeof u.seconds === "number" && Number.isFinite(u.seconds) && u.seconds >= 0) seconds = u.seconds;
  }
  return { kind: "ok", text: d.text, seconds };
}

export async function callOpenAiTranscribe(args: OpenAiTranscribeInput): Promise<OpenAiTranscribeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const form = new FormData();
  // Uint8Array をそのままコピーして渡す（SharedArrayBuffer などの型の違いを避ける）
  form.append("file", new Blob([args.audio.slice()], { type: "audio/wav" }), "audio.wav");
  form.append("model", args.modelId);
  form.append("response_format", "json");
  if (args.language !== "auto") form.append("language", args.language);
  if (args.prompt) form.append("prompt", args.prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let response: Response;
  try {
    response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    return { kind: "unknown", reason: aborted ? "timeout" : "network" };
  }
  try {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (NO_CHARGE_STATUSES.has(response.status)) return { kind: "rejected", status: response.status };
      return { kind: "unknown", reason: "server" };
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return { kind: "unknown", reason: aborted ? "timeout" : "bad-response" };
    }
    return interpretTranscribeResponse(data);
  } finally {
    clearTimeout(timer);
  }
}
