import { test, expect } from "@playwright/test";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
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

test("pricing: ¥0 / ¥550 / ¥980 の料金表示が崩れていない", async ({ page }) => {
  await page.goto("/pricing");

  expect(PLAN_DEFINITIONS.free.priceYen).toBe(0);
  expect(PLAN_DEFINITIONS.standard.priceYen).toBe(550);
  expect(PLAN_DEFINITIONS.premium.priceYen).toBe(980);

  await expect(page.getByText("無料", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("0円", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("550", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("980", { exact: false }).first()).toBeVisible();
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
