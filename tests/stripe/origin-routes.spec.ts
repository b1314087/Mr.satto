import { test, expect } from "@playwright/test";

/**
 * Stripe関連のPOST（決済ページの作成・契約管理ページの作成）の Origin 確認（工程39）の、実際のAPIでのテスト。
 * 開発サーバーに対して、リクエストを送る。Stripeには接続しない（Origin確認は、Stripeの設定や認証より前に行う）。
 * Webhook は、Stripeのサーバーからの通知（署名で検証）なので、Origin の確認の対象外であることも確認する。
 */
for (const path of ["/api/stripe/checkout", "/api/stripe/portal"]) {
  test.describe(`${path} の Origin 確認`, () => {
    test("外部のサイトからのリクエストは 403", async ({ request }) => {
      const res = await request.post(path, { data: { plan: "premium" }, headers: { origin: "https://evil.example" } });
      expect(res.status()).toBe(403);
      expect(await res.json()).toEqual({ error: "このリクエストは受け付けられません。" });
    });

    test("似たドメイン・不正な Origin（null など）は 403", async ({ request }) => {
      for (const origin of ["https://mrsatto.com.evil.example", "null", "garbage"]) {
        const res = await request.post(path, { data: { plan: "premium" }, headers: { origin } });
        expect(res.status(), origin).toBe(403);
      }
    });

    test("Origin が無い（ブラウザ以外からの）リクエストは 403", async ({ request }) => {
      const res = await request.post(path, { data: { plan: "premium" } });
      expect(res.status()).toBe(403);
    });

    test("Sec-Fetch-Site が cross-site で Origin が無い場合も 403", async ({ request }) => {
      const res = await request.post(path, { data: { plan: "premium" }, headers: { "sec-fetch-site": "cross-site" } });
      expect(res.status()).toBe(403);
    });

    test("正規の送信元（開発サーバー自身）からのリクエストは、Origin では断られず、次の確認（認証・設定）へ進む", async ({ request, baseURL }) => {
      const origin = new URL(baseURL ?? "http://localhost:3000").origin;
      const res = await request.post(path, { data: { plan: "premium" }, headers: { origin } });
      // Stripe未設定なら503、設定済みで未ログインなら401。Origin の拒否（403）ではない
      expect([401, 503]).toContain(res.status());
    });

    test("Sec-Fetch-Site が same-origin なら、Origin が無くても次の確認へ進む", async ({ request }) => {
      const res = await request.post(path, { data: { plan: "premium" }, headers: { "sec-fetch-site": "same-origin" } });
      expect([401, 503]).toContain(res.status());
    });
  });
}

test("Stripe Webhook は Origin の確認の対象外（Origin が無くても、署名の確認で断られる）", async ({ request }) => {
  const res = await request.post("/api/stripe/webhook", { data: "{}" });
  // 署名ヘッダーが無いので 400 か、未設定の 503。Origin 由来の 403 ではない
  expect([400, 503]).toContain(res.status());
});
