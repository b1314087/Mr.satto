import { test, expect } from "@playwright/test";
import { OFFERED_PLAN_IDS, PLAN_DEFINITIONS, PREMIUM_PRICE_YEN } from "@/lib/plans/types";
import { setDevPlanOverride } from "../helpers/dev-plan";

/**
 * pricing/usage-limit回帰テスト（Phase 14）。
 *
 * 実際のStripe/Supabaseには一切触れず、Phase 11で追加された開発専用Cookie
 * （NODE_ENV=development限定）のみを使って、料金プランの表示価格と
 * filled-pdf-to-excelの利用制限メッセージが崩れていないことを確認する。
 *
 * 重要: これはテスト環境（next dev相当の判定条件下）でのみ意味を持つ回帰テストであり、
 * 本番のStripe実課金・Supabaseの契約状態そのものを検証するものではない。
 */

test("pricing: 現行の料金は ¥0 / ¥1,100 の2つだけ。旧Standard(¥550)・旧Premium(¥980)は料金ページに出ない", async ({ page }) => {
  await page.goto("/pricing");

  expect(PLAN_DEFINITIONS.free.priceYen).toBe(0);
  expect(PLAN_DEFINITIONS.premium.priceYen).toBe(PREMIUM_PRICE_YEN);
  expect(PREMIUM_PRICE_YEN).toBe(1100);
  expect(OFFERED_PLAN_IDS).toEqual(["free", "premium"]);

  await expect(page.getByText("無料", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("0円", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("1,100円", { exact: false }).first()).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text).not.toMatch(/550|980|スタンダード/);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(3); // 無料・プレミアム・お支払い/解約
});

test("filled-pdf-to-excel: free/standard/premiumで利用制限の表示が切り替わる（dev cookie経由）", async ({
  page,
  context,
  baseURL,
}) => {
  // free: 広告視聴が必要な旨の案内が表示される
  await setDevPlanOverride(context, "free", baseURL!);
  await page.goto("/tools/filled-pdf-to-excel");
  await expect(page.getByText(/広告/).first()).toBeVisible();

  // premium: ページ数・回数の制限なく利用できる旨の案内が表示される
  await setDevPlanOverride(context, "premium", baseURL!);
  await page.reload();
  await expect(page.getByText(/制限なく/).first()).toBeVisible();
});
