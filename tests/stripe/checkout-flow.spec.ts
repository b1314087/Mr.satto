import { test, expect } from "@playwright/test";
import {
  CHECKOUT_IDEMPOTENCY_WINDOW_MS,
  checkoutIdempotencyKey,
  runCheckoutFlow,
  type CheckoutFlowDeps,
} from "@/lib/stripe/checkout-flow";

/**
 * Checkout作成の流れ（サブスクリプションの二重作成防止）の単体テスト（工程39）。Stripeには接続しない（模擬のStripeを使う）。
 * 模擬のStripeは、実際のStripeと同じく「同じ冪等性キーのリクエストには、同じSessionを返す」。
 */
const INPUT = { customerId: "cus_1", userId: "user-1", priceId: "price_new", nowMs: 1_800_000_000_000 };

function fakeStripe(over: Partial<{ openSubscription: boolean; reusable: { url: string } | null; failCheck: boolean; failReuse: boolean; failCreate: boolean; noUrl: boolean }> = {}) {
  const sessions = new Map<string, { url: string | null }>();
  const stats = { created: 0, keys: [] as string[], checks: 0 };
  const deps: CheckoutFlowDeps = {
    async hasOpenStripeSubscription() {
      stats.checks += 1;
      if (over.failCheck) throw new Error("stripe down");
      return over.openSubscription === true;
    },
    async findReusableSession() {
      if (over.failCheck || over.failReuse) throw new Error("stripe down");
      return over.reusable ?? null;
    },
    async createSession(key) {
      stats.keys.push(key);
      if (over.failCreate) throw new Error("create failed");
      const existing = sessions.get(key);
      if (existing) return existing; // 同じキーには、同じSession
      stats.created += 1;
      const created = { url: over.noUrl ? null : `https://checkout.stripe.test/${stats.created}` };
      sessions.set(key, created);
      return created;
    },
  };
  return { deps, stats };
}

test.describe("冪等性キー", () => {
  test("同じユーザー・価格・時間枠なら同じキー。ユーザー・価格・時間枠が違えば別のキー", () => {
    const base = checkoutIdempotencyKey("user-1", "price_new", 1_800_000_000_000);
    expect(checkoutIdempotencyKey("user-1", "price_new", 1_800_000_000_000)).toBe(base);
    expect(checkoutIdempotencyKey("user-1", "price_new", 1_800_000_000_000 + 1000)).toBe(base);
    expect(checkoutIdempotencyKey("user-2", "price_new", 1_800_000_000_000)).not.toBe(base);
    expect(checkoutIdempotencyKey("user-1", "price_old", 1_800_000_000_000)).not.toBe(base);
    expect(checkoutIdempotencyKey("user-1", "price_new", 1_800_000_000_000 + CHECKOUT_IDEMPOTENCY_WINDOW_MS)).not.toBe(base);
  });

  test("キーはリクエストごとの乱数・時刻のミリ秒を含まない（重複防止の効果が消えない）", () => {
    const keys = new Set(Array.from({ length: 50 }, (_, i) => checkoutIdempotencyKey("user-1", "price_new", 1_800_000_000_000 + i)));
    expect(keys.size).toBe(1);
  });
});

test.describe("Checkout作成の流れ", () => {
  test("契約が無ければ、新しいCheckoutを1つ作る", async () => {
    const { deps, stats } = fakeStripe();
    const result = await runCheckoutFlow(INPUT, deps);
    expect(result).toEqual({ status: "ok", url: "https://checkout.stripe.test/1", reused: false });
    expect(stats.created).toBe(1);
  });

  test("連続クリック（同じ時間枠の逐次リクエスト）は、同じCheckoutに収まる（作成は1つ）", async () => {
    const { deps, stats } = fakeStripe();
    const first = await runCheckoutFlow(INPUT, deps);
    const second = await runCheckoutFlow({ ...INPUT, nowMs: INPUT.nowMs + 2000 }, deps);
    expect(first).toEqual(second);
    expect(stats.created).toBe(1);
  });

  test("複数タブ・同時リクエスト（20件を同時に）でも、作成されるCheckoutは1つだけ", async () => {
    const { deps, stats } = fakeStripe();
    const results = await Promise.all(Array.from({ length: 20 }, () => runCheckoutFlow(INPUT, deps)));
    expect(stats.created).toBe(1);
    expect(new Set(results.map((r) => (r.status === "ok" ? r.url : r.status))).size).toBe(1);
  });

  test("すでに開いているCheckoutがあれば、新しく作らずに、そのURLを返す", async () => {
    const { deps, stats } = fakeStripe({ reusable: { url: "https://checkout.stripe.test/existing" } });
    const result = await runCheckoutFlow(INPUT, deps);
    expect(result).toEqual({ status: "ok", url: "https://checkout.stripe.test/existing", reused: true });
    expect(stats.created).toBe(0);
  });

  test("Stripe上で契約が続いているなら（データベースの反映が遅れていても）、作らずに already-subscribed", async () => {
    const { deps, stats } = fakeStripe({ openSubscription: true });
    expect(await runCheckoutFlow(INPUT, deps)).toEqual({ status: "already-subscribed" });
    expect(stats.created).toBe(0);
  });

  test("Stripeの契約の確認に失敗したら、作らない（二重請求のおそれがあるので安全側）", async () => {
    const { deps, stats } = fakeStripe({ failCheck: true });
    expect(await runCheckoutFlow(INPUT, deps)).toEqual({ status: "error", kind: "stripe-check" });
    expect(stats.created).toBe(0);
    expect(stats.keys).toEqual([]);
  });

  test("開いているCheckoutを探すのに失敗しても、申し込みは止めず、冪等性キーつきで作成に進む", async () => {
    const { deps, stats } = fakeStripe({ failReuse: true });
    expect(await runCheckoutFlow(INPUT, deps)).toMatchObject({ status: "ok", reused: false });
    expect(stats.created).toBe(1);
    // 探すのに失敗していても、同時リクエストは1つにまとまる
    const again = await Promise.all(Array.from({ length: 10 }, () => runCheckoutFlow(INPUT, deps)));
    expect(stats.created).toBe(1);
    expect(again.every((r) => r.status === "ok")).toBe(true);
  });

  test("Checkoutの作成に失敗したら、エラーを返す（何も作られない）", async () => {
    const { deps, stats } = fakeStripe({ failCreate: true });
    expect(await runCheckoutFlow(INPUT, deps)).toEqual({ status: "error", kind: "create" });
    expect(stats.created).toBe(0);
  });

  test("URLが返らなかったときは、エラーとして扱う", async () => {
    const { deps } = fakeStripe({ noUrl: true });
    expect(await runCheckoutFlow(INPUT, deps)).toEqual({ status: "error", kind: "no-url" });
  });

  test("失敗のあとの再試行は、同じ時間枠でも作成できる（失敗がキーに残らない）", async () => {
    let fail = true;
    const { deps } = fakeStripe();
    const original = deps.createSession;
    deps.createSession = async (key) => {
      if (fail) {
        fail = false;
        throw new Error("transient");
      }
      return original(key);
    };
    expect(await runCheckoutFlow(INPUT, deps)).toMatchObject({ status: "error", kind: "create" });
    expect(await runCheckoutFlow(INPUT, deps)).toMatchObject({ status: "ok", reused: false });
  });

  test("別のユーザーは、互いに影響しない（別々のCheckoutが作られる）", async () => {
    const { deps, stats } = fakeStripe();
    const a = await runCheckoutFlow(INPUT, deps);
    const b = await runCheckoutFlow({ ...INPUT, userId: "user-2", customerId: "cus_2" }, deps);
    expect(a).not.toEqual(b);
    expect(stats.created).toBe(2);
  });
});

test.describe("実装の静的確認", () => {
  test("チェックアウトのAPIは、冪等性キーつきで作成し、Customerの作成にも固定のキーを付けている", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/stripe/checkout/route.ts", "utf8");
    expect(route).toContain("runCheckoutFlow");
    expect(route).toMatch(/idempotencyKey/);
    const customer = readFileSync("src/lib/stripe/customer.ts", "utf8");
    expect(customer).toMatch(/idempotencyKey: `supabase-customer:\$\{userId\}`/);
    // 冪等性キーを、乱数や現在時刻のミリ秒から作っていない
    expect(route).not.toMatch(/idempotencyKey:\s*(crypto|randomUUID|Math\.random|Date\.now)/);
  });
});
