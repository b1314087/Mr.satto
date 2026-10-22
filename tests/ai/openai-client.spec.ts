import { test, expect } from "@playwright/test";
import { callOpenAi, interpretResponse, parseUsage } from "@/lib/ai/openai-client";
import { OUTPUT_SCHEMA } from "@/lib/ai/calendar-assist";

const baseArgs = {
  apiKey: "sk-test-secret",
  modelId: "gpt-6-luna",
  instructions: "指示",
  input: '{"rows":[]}',
  maxOutputTokens: 3000,
  schemaName: "calendar_rows",
  schema: OUTPUT_SCHEMA,
  timeoutMs: 200,
};

function fakeFetch(response: () => Response | Promise<Response>, capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return response();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const completed = (text = "{}") => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 50 }, total_tokens: 1500 },
});

test.describe("OpenAI Responses API の呼び出し", () => {
  test("リクエスト: store=false・構造化出力(strict)・出力上限・推論は低・キーはヘッダーだけ", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    await callOpenAi({ ...baseArgs, fetchImpl: fakeFetch(() => json(completed()), cap) });
    expect(cap.url).toBe("https://api.openai.com/v1/responses");
    const headers = cap.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test-secret");
    const body = JSON.parse(cap.init!.body as string);
    expect(body.store).toBe(false);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.max_output_tokens).toBe(3000);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.service_tier).toBe("default");
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "calendar_rows", strict: true });
    expect(JSON.stringify(body)).not.toContain("sk-test-secret");
  });

  test("成功: 本文と使用量（キャッシュ入力を含む）を返す", async () => {
    const r = await callOpenAi({ ...baseArgs, fetchImpl: fakeFetch(() => json(completed('{"suggestions":[]}'))) });
    expect(r).toEqual({ kind: "ok", text: '{"suggestions":[]}', usage: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300 } });
  });

  test("課金されていないと言える拒否（400/401/403/404/422/429）は rejected", async () => {
    for (const status of [400, 401, 403, 404, 422, 429]) {
      const r = await callOpenAi({ ...baseArgs, fetchImpl: fakeFetch(() => json({ error: { message: "x" } }, status)) });
      expect(r, String(status)).toEqual({ kind: "rejected", status });
    }
  });

  test("5xx・その他のエラーは、課金されたか分からない（unknown）", async () => {
    for (const status of [500, 502, 503, 504, 408, 409]) {
      const r = await callOpenAi({ ...baseArgs, fetchImpl: fakeFetch(() => json({}, status)) });
      expect(r, String(status)).toEqual({ kind: "unknown", reason: "server" });
    }
  });

  test("通信エラーは unknown(network)、時間切れは unknown(timeout)", async () => {
    const net = await callOpenAi({
      ...baseArgs,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(net).toEqual({ kind: "unknown", reason: "network" });
    const slow = await callOpenAi({
      ...baseArgs,
      timeoutMs: 30,
      fetchImpl: ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as typeof fetch,
    });
    expect(slow).toEqual({ kind: "unknown", reason: "timeout" });
  });

  test("JSONでない応答は unknown(bad-response)", async () => {
    const r = await callOpenAi({ ...baseArgs, fetchImpl: fakeFetch(() => new Response("<html>", { status: 200 })) });
    expect(r).toEqual({ kind: "unknown", reason: "bad-response" });
  });
});

test.describe("200の応答の分類", () => {
  test("incomplete / failed / refusal は使用量つきで分類する", () => {
    const usage = { input_tokens: 10, output_tokens: 5 };
    expect(interpretResponse({ status: "incomplete", usage })).toEqual({ kind: "incomplete", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 } });
    expect(interpretResponse({ status: "failed", usage })).toMatchObject({ kind: "failed" });
    expect(interpretResponse({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }], usage })).toMatchObject({ kind: "refusal" });
  });

  test("本文が無い・形が違う応答は unknown(bad-response)。推論アイテムだけの応答も本文とは見なさない", () => {
    expect(interpretResponse(null)).toEqual({ kind: "unknown", reason: "bad-response" });
    expect(interpretResponse({ status: "completed", output: [{ type: "reasoning", summary: [] }] })).toEqual({ kind: "unknown", reason: "bad-response" });
    expect(interpretResponse({ status: "queued" })).toEqual({ kind: "unknown", reason: "bad-response" });
  });

  test("使用量が読めないときは usage=null（呼び出し側は予約額で確定する）", () => {
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage({ input_tokens: "x" })).toBeNull();
    expect(interpretResponse({ ...completed("{}"), usage: undefined })).toMatchObject({ kind: "ok", usage: null });
  });

  test("キャッシュ入力は入力の内数に収める。負・NaNは0", () => {
    expect(parseUsage({ input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 999 } })).toEqual({ inputTokens: 100, cachedInputTokens: 100, outputTokens: 10 });
    expect(parseUsage({ input_tokens: -5, output_tokens: Number.NaN })).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
  });
});
