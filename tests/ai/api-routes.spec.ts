import { test, expect } from "@playwright/test";

/**
 * AIのAPIルート（/api/ai/*）の入口の安全確認。開発サーバーに対して実行する。
 * OpenAIのキー・Supabaseの接続情報が無い環境では、AIは「利用できない」状態になり、外部へは何も送らない。
 */
const ENV_HAS_AI = !!process.env.OPENAI_API_KEY;

test.describe("AI API: 入口の安全確認", () => {
  test.skip(ENV_HAS_AI, "OPENAI_API_KEY が設定された環境では実行しない（実際のAIを呼ばないため）");

  test("利用状況: キー等が無いときは利用不可を返し、金額や内部情報を含まない", async ({ request }) => {
    const res = await request.get("/api/ai/usage");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
    const body = await res.json();
    expect(body).toEqual({ available: false, reason: "unavailable" });
  });

  test("読み取り: JSON以外は415、他サイトからは403、壊れたJSONは400、設定が無ければ503（AIは呼ばない）", async ({ request }) => {
    const wrongType = await request.post("/api/ai/calendar-assist", { headers: { "Content-Type": "text/plain" }, data: "x" });
    expect(wrongType.status()).toBe(415);

    const foreign = await request.post("/api/ai/calendar-assist", { headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, data: "{}" });
    expect(foreign.status()).toBe(403);

    const broken = await request.post("/api/ai/calendar-assist", { headers: { "Content-Type": "application/json" }, data: Buffer.from("{not json") });
    expect(broken.status()).toBe(400);

    const unavailable = await request.post("/api/ai/calendar-assist", { headers: { "Content-Type": "application/json" }, data: JSON.stringify({ consent: { accepted: true } }) });
    expect(unavailable.status()).toBe(503);
    const body = await unavailable.json();
    expect(body.error).toBe("unavailable");
    expect(JSON.stringify(body)).not.toMatch(/sk-|api[_-]?key|OPENAI/i);
  });

  test("読み取り: 大きすぎる本文は413", async ({ request }) => {
    const res = await request.post("/api/ai/calendar-assist", { headers: { "Content-Type": "application/json" }, data: JSON.stringify({ pad: "あ".repeat(500_000) }) });
    expect(res.status()).toBe(413);
  });
});
