import type { BrowserContext } from "@playwright/test";

/**
 * Phase 11で追加された開発専用Cookie（NODE_ENV=development限定）を使い、
 * 本物のStripe/Supabaseに一切触れずにプラン状態・広告視聴結果を切り替えるヘルパー。
 *
 * 注意: これらのCookieは本番ビルド（NODE_ENV=production）では効果を持たない
 * ガードが本体コード側に入っている前提（Phase 11で確認済み）。
 * pricing/plan回帰テストは、このヘルパー経由のみで状態を作り、
 * 実際の課金・DB更新は一切発生させない。
 */

export type DevPlanOverride = "free" | "standard" | "premium";
export type DevAdOutcome = "granted" | "granted-twice" | "denied" | "unavailable";

export async function setDevPlanOverride(context: BrowserContext, plan: DevPlanOverride, baseUrl: string) {
  await context.addCookies([
    {
      name: "mrsatto-dev-plan-override",
      value: plan,
      url: baseUrl,
    },
  ]);
}

export async function setDevAdOutcome(context: BrowserContext, outcome: DevAdOutcome, baseUrl: string) {
  await context.addCookies([
    {
      name: "mrsatto-dev-ad-outcome",
      value: outcome,
      url: baseUrl,
    },
  ]);
}

export async function clearDevOverrides(context: BrowserContext) {
  await context.clearCookies({ name: "mrsatto-dev-plan-override" });
  await context.clearCookies({ name: "mrsatto-dev-ad-outcome" });
}
