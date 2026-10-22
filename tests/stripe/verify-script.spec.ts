import { test, expect } from "@playwright/test";
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * scripts/verify-stripe-live.mjs（本番Stripeの読み取り専用の確認）の安全性。
 * 実際のStripeには接続しない（自分のPC上の模擬サーバーだけを使う）。
 */
const SCRIPT = path.join(process.cwd(), "scripts/verify-stripe-live.mjs");
const FAKE_KEY = "rk_live_FAKEKEY_DO_NOT_PRINT_123456";
/** 実際の環境変数（本物のキーなど）を子プロセスへ渡さない。必要な値だけを渡す */
const envOf = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", ...extra }) as unknown as NodeJS.ProcessEnv;

test.describe("Stripe確認スクリプト", () => {
  test("読み取り専用: GET以外のリクエストを送らず、顧客のメールアドレス等を出力する処理がない", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/method\s*:/);
    expect(src).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b\s*[,"']/);
    expect(src).not.toMatch(/\.email|customer_email|receipt_email/);
    expect(src).not.toMatch(/\$\{key\}.*console|console.*\$\{key\}/);
  });

  test("接続先の上書きは localhost のときだけ（キーを別のサーバーへ送らない）", async () => {
    const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        "node",
        [SCRIPT],
        { env: envOf({ STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_PREMIUM_PRICE_ID: "price_x", STRIPE_API_BASE_FOR_TESTS: "https://evil.example.com/v1" }) },
        (err, _stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
      );
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("localhost");
  });

  test("模擬のStripeに対して動作する: GETだけを送り、キーを出力せず、不一致を「要対応」と示す", async () => {
    const methods: string[] = [];
    const server = http.createServer((req, res) => {
      methods.push(req.method ?? "");
      const json = (o: unknown, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      const u = req.url ?? "";
      if (u.startsWith("/v1/prices/")) return json({ livemode: true, active: true, currency: "jpy", unit_amount: 980, type: "recurring", recurring: { interval: "month", interval_count: 1 }, product: "prod_1" });
      if (u.startsWith("/v1/webhook_endpoints")) return json({ data: [{ url: "https://mrsatto.com/api/stripe/webhook", status: "enabled", livemode: true, enabled_events: ["invoice.paid"] }] });
      if (u.startsWith("/v1/billing_portal")) return json({ error: { message: "permission" } }, 403);
      if (u.startsWith("/v1/subscriptions")) return json({ data: [{ status: "active", customer: "cus_SECRET", items: { data: [{ price: { id: "price_old", unit_amount: 980, currency: "jpy" } }] } }], has_more: false });
      json({}, 404);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        execFile(
          "node",
          [SCRIPT],
          { env: envOf({ STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_PREMIUM_PRICE_ID: "price_new", STRIPE_API_BASE_FOR_TESTS: `http://127.0.0.1:${port}/v1` }) },
          (err, stdout) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
        );
      });
      expect(out.code).toBe(2); // 要対応あり
      expect(out.stdout).toContain("金額が違います");
      expect(out.stdout).toContain("購読していないイベント");
      expect(out.stdout).toContain("確認できず"); // ポータルの権限不足は「確認できず」で、判定しない
      expect(out.stdout).toContain("STRIPE_PREMIUM_LEGACY_PRICE_IDS");
      expect(out.stdout).not.toContain(FAKE_KEY);
      expect(out.stdout).not.toContain("cus_SECRET");
      expect(new Set(methods)).toEqual(new Set(["GET"]));
    } finally {
      server.close();
    }
  });
});
