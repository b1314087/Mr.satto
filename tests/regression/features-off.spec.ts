import { test, expect } from "@playwright/test";
import { uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";

/**
 * 機能スイッチ（src/lib/config/features.ts）の「広告オフ・課金オフ」状態の回帰テスト。
 *
 * 本番は両スイッチがオフ。開発サーバーでこの状態を再現するため、
 * NEXT_PUBLIC_FEATURES_OFF=1 を付けてサーバーを起動した場合にだけ実行する
 * （通常の `npm test` ではスキップされる）。実行方法:
 *
 *   npm run test:features-off
 *
 * 実際のAd Manager・AdSense・Stripe・Supabaseには一切触れない。
 */
test.describe("機能スイッチ: 広告オフ・課金オフ", () => {
  test.skip(
    process.env.NEXT_PUBLIC_FEATURES_OFF !== "1",
    "NEXT_PUBLIC_FEATURES_OFF=1 で起動した開発サーバーでのみ実行（npm run test:features-off）",
  );

  test("ヘッダーとフッターに、料金・ログイン・特商法の導線が出ない", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    const footer = page.locator("footer");

    await expect(header.getByRole("link", { name: "ツール一覧" })).toBeVisible();
    await expect(header.getByRole("link", { name: "料金プラン" })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "ログイン" })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "アカウント" })).toHaveCount(0);
    await expect(footer.getByRole("link", { name: "料金プラン" })).toHaveCount(0);
    await expect(footer.getByRole("link", { name: "特定商取引法に基づく表記" })).toHaveCount(0);
    // 残すべきリンクは残る
    await expect(footer.getByRole("link", { name: "プライバシーポリシー" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "利用規約" })).toBeVisible();
  });

  for (const path of ["/pricing", "/tokushoho", "/signup", "/account"]) {
    test(`${path} は「準備中」を表示し、検索エンジンには出さない`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId("feature-unavailable")).toBeVisible();
      if (path !== "/account") {
        // /account は元から noindex（個人ページ）。他は課金オフの間 noindex になる
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      }
    });
  }

  test("/login は管理画面などへのログイン用にページを残し、検索には出さない", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
    await expect(page.getByTestId("feature-unavailable")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("sitemap.xml に料金・ログイン・会員登録・特商法のページが含まれない", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.ok()).toBe(true);
    const xml = await res.text();
    for (const path of ["/pricing", "/login", "/signup", "/tokushoho"]) {
      expect(xml).not.toContain(`${path}</loc>`);
    }
    // ツールのページは残る
    expect(xml).toContain("/tools/image-resize</loc>");
  });

  test("決済（checkout）と決済管理（portal）のAPIは404を返す", async ({ request }) => {
    const checkout = await request.post("/api/stripe/checkout", { data: { plan: "standard" } });
    expect(checkout.status()).toBe(404);
    const portal = await request.post("/api/stripe/portal");
    expect(portal.status()).toBe(404);
  });

  test("Stripe Webhook は何も処理せず、200だけ返す（署名がなくても処理に進まない）", async ({ request }) => {
    const res = await request.post("/api/stripe/webhook", { data: "{}" });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: true });
  });

  test("ツールページに広告の枠・ダウンロード時の広告の案内が出ない", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByTestId("download-ad-notice")).toHaveCount(0);
    await expect(page.locator("[data-ad-placement]")).toHaveCount(0);
    await expect(page.locator("ins.adsbygoogle")).toHaveCount(0);
  });

  test("広告の確認画面なしで、処理済みファイルをそのままダウンロードできる", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "ダウンロード" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().length).toBeGreaterThan(0);
    await expect(page.getByTestId("download-gate-dialog")).toHaveCount(0);
  });

  test("広告スクリプトを読み込まない", async ({ page }) => {
    const adRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("googlesyndication.com") || url.includes("doubleclick.net")) adRequests.push(url);
    });
    await page.goto("/");
    await page.goto("/tools/image-resize");
    expect(adRequests).toEqual([]);
  });

  test("プライバシーポリシーと利用規約が、現在の提供内容に合った表記になる", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByText("現在、本サービスは広告を表示していません。")).toBeVisible();
    await expect(page.getByText("現在、本サービスは、会員登録・ログイン・有料プランを一般のご利用者向けには提供していません。", { exact: false })).toBeVisible();

    await page.goto("/terms");
    await expect(page.getByTestId("terms-billing-notice")).toBeVisible();
  });

  test("会員登録なしの利用案内（aboutページ）が、課金オフの内容になる", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { name: "ご利用料金について" })).toBeVisible();
    await expect(page.getByRole("link", { name: "料金プラン" })).toHaveCount(0);
  });
});
