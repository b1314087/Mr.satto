import { test, expect } from "@playwright/test";
import { PREMIUM_PRICE_YEN } from "@/lib/plans/types";

/**
 * AI有料プランの公開時の構成（課金オン・広告オフ）の回帰テスト。
 *
 * 公開時の本番は、課金だけをオンにし、広告はオフのままにする想定。
 * 開発サーバーでこの状態を再現するため、NEXT_PUBLIC_FEATURES_OFF=ads を付けて起動した場合にだけ実行する
 * （通常の `npm test` ではスキップされる）。実行方法:
 *
 *   npm run test:launch-config
 *
 * 実際のStripe・Supabase・OpenAIには一切触れない（環境変数は未設定のまま）。
 */
test.describe("公開時の構成: 課金オン・広告オフ", () => {
  test.skip(
    process.env.NEXT_PUBLIC_FEATURES_OFF !== "ads",
    "NEXT_PUBLIC_FEATURES_OFF=ads で起動した開発サーバーでのみ実行（npm run test:launch-config）",
  );

  test("料金ページ: プレミアム月額1,100円（税込）を案内し、広告視聴・旧Standardの文言を出さない", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByTestId("feature-unavailable")).toHaveCount(0);
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    expect(text).toContain(`${PREMIUM_PRICE_YEN.toLocaleString("ja-JP")}円`);
    expect(text).not.toContain("広告視聴あり");
    expect(text).not.toContain("Standard");
    expect(text).not.toContain("550円");
    expect(text).not.toContain("有効になった後"); // 将来の広告の予定を、現行の説明に出さない
  });

  test("トップページ・サイトの紹介・会員登録: 広告を見る前提の文言が出ない", async ({ page }) => {
    for (const path of ["/", "/about", "/signup"]) {
      await page.goto(path);
      const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      expect(text, path).not.toContain("広告を見れば");
      expect(text, path).not.toContain("Standard");
    }
    await page.goto("/signup");
    await expect(page.locator("main")).toContainText("プレミアムプラン");
  });

  test("通常のツールは、ログインも広告もなしで使える（無料のまま）", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByTestId("download-ad-notice")).toHaveCount(0);
    await expect(page.locator("[data-ad-placement]")).toHaveCount(0);
    await expect(page.locator("ins.adsbygoogle")).toHaveCount(0);
  });

  test("ログイン済みでない場合、AI補助とその利用状況のAPIは利用できない", async ({ request }) => {
    const usage = await request.get("/api/ai/usage");
    // 使用量は「使えない」と返す（200）。使用量の数値は返さない
    expect(usage.status()).toBe(200);
    const usageBody = await usage.json();
    expect(usageBody.available).toBe(false);
    expect(usageBody.usage).toBeUndefined();
    const assist = await request.post("/api/ai/calendar-assist", {
      data: { consent: true },
      headers: { origin: "http://localhost:3101" },
    });
    expect([400, 401, 403, 503]).toContain(assist.status());
    const body = await assist.text();
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(body).not.toMatch(/stack|at .*\(.*:\d+:\d+\)/);
  });

  test("Stripeの決済・管理APIは、ログインなしでは処理されない（課金オンでも）", async ({ request }) => {
    const checkout = await request.post("/api/stripe/checkout", { data: { plan: "premium" } });
    expect([400, 401, 403, 500, 503]).toContain(checkout.status());
    const portal = await request.post("/api/stripe/portal");
    expect([400, 401, 403, 500, 503]).toContain(portal.status());
  });

  test("Stripe Webhook: 署名がない呼び出しは受け付けない", async ({ request }) => {
    const res = await request.post("/api/stripe/webhook", { data: "{}" });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
