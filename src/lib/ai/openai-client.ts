/**
 * OpenAI Responses API を呼ぶ最小のクライアント（fetchだけを使い、追加の依存は入れない）。
 * このファイルは通信の形と、結果の分類だけを扱う。APIキーは呼び出し側（サーバー）が渡す。
 *
 * 結果の分類は、利用枠の扱い（確定・解放・そのまま）を決める根拠になる:
 *   ok / refusal / incomplete / failed : OpenAIが処理した（使用量があれば課金されている）→ 確定
 *   rejected : OpenAIが入力を受け付けなかった（400/401/403/404/422/429）→ 課金されていないと言える → 解放
 *   unknown  : タイムアウト・通信断・5xx・不正な応答 → 課金されたか分からない → 解放しない
 * リクエスト本文・応答本文は、ここでもログに出さず、保存しない。
 */
import type { TokenUsage } from "./pricing";

const ENDPOINT = "https://api.openai.com/v1/responses";

/** 画像つきの入力（Responses APIの input_text / input_image）。画像は data: URL で渡す（ファイルのアップロードはしない） */
export type OpenAiInputMessage = {
  role: "user";
  content: ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" | "low" | "auto" })[];
};

/** 文字と画像（縮小したJPEG/PNGのbase64）から、画像つきの入力を作る。画像は data: URL で渡し、ファイルとしてはアップロードしない */
export function buildImageInput(text: string, images: { mediaType: string; base64: string }[]): OpenAiInputMessage[] {
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        ...images.map((im) => ({ type: "input_image" as const, image_url: `data:${im.mediaType};base64,${im.base64}`, detail: "high" as const })),
      ],
    },
  ];
}

export interface OpenAiCallInput {
  apiKey: string;
  modelId: string;
  instructions: string;
  input: string | OpenAiInputMessage[];
  maxOutputTokens: number;
  schemaName: string;
  schema: object;
  timeoutMs: number;
  /** テスト用。通常は指定しない（グローバルのfetchを使う） */
  fetchImpl?: typeof fetch;
}

export type OpenAiCallResult =
  | { kind: "ok"; text: string; usage: TokenUsage | null }
  | { kind: "refusal" | "incomplete" | "failed"; usage: TokenUsage | null }
  | { kind: "rejected"; status: number }
  | { kind: "unknown"; reason: "timeout" | "network" | "server" | "bad-response" };

/** 課金されていないと言える、OpenAI側の拒否のステータス */
const NO_CHARGE_STATUSES = new Set([400, 401, 403, 404, 422, 429]);

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** 応答の usage から使用量を取り出す。読み取れなければ null（呼び出し側は予約額で確定する） */
export function parseUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") return null;
  const details = typeof u.input_tokens_details === "object" && u.input_tokens_details !== null ? (u.input_tokens_details as Record<string, unknown>) : {};
  const inputTokens = num(u.input_tokens);
  return {
    inputTokens,
    cachedInputTokens: Math.min(num(details.cached_tokens), inputTokens),
    outputTokens: num(u.output_tokens),
  };
}

export async function callOpenAi(args: OpenAiCallInput): Promise<OpenAiCallResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let response: Response;
  try {
    response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
      body: JSON.stringify({
        model: args.modelId,
        instructions: args.instructions,
        input: args.input,
        // 応答をOpenAI側に保存させない（Responses APIの既定は保存するため、明示する）
        store: false,
        max_output_tokens: args.maxOutputTokens,
        reasoning: { effort: "low" },
        service_tier: "default",
        text: { format: { type: "json_schema", name: args.schemaName, strict: true, schema: args.schema } },
      }),
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
    return interpretResponse(data);
  } finally {
    clearTimeout(timer);
  }
}

/** 200で返ってきた応答の本体を分類する */
export function interpretResponse(data: unknown): OpenAiCallResult {
  if (typeof data !== "object" || data === null) return { kind: "unknown", reason: "bad-response" };
  const d = data as Record<string, unknown>;
  const usage = parseUsage(d.usage);
  const status = d.status;
  if (status === "failed") return { kind: "failed", usage };
  if (status === "incomplete") return { kind: "incomplete", usage };
  if (status !== "completed" && status !== undefined) return { kind: "unknown", reason: "bad-response" };

  let text: string | null = null;
  let refused = false;
  if (Array.isArray(d.output)) {
    for (const item of d.output) {
      if (typeof item !== "object" || item === null || (item as { type?: unknown }).type !== "message") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === "refusal") refused = true;
        if (p.type === "output_text" && typeof p.text === "string" && text === null) text = p.text;
      }
    }
  }
  if (refused) return { kind: "refusal", usage };
  if (text === null) return { kind: "unknown", reason: "bad-response" };
  return { kind: "ok", text, usage };
}
