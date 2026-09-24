/**
 * Mr.Satto の料金プラン（Phase 3: 会員登録・課金・プラン管理で確定）。
 *
 * 正式な料金体系：
 *
 * free     : 0円。ログイン不要。リワード広告視聴で15分間スタンダード対象ツールを利用可能
 * standard : 月額550円。ログイン必須。広告なしでスタンダード対象ツールを利用可能
 * premium  : 月額980円。ログイン必須。広告なしですべてのツールを利用可能
 *
 * 重要：「広告も見ない」「料金も払わない」でそのまま使える
 * 完全無料プランは、最終仕様として存在しない。
 * free ユーザーは standard 対象ツールの利用時に、Rewarded Ads の視聴によって
 * 15分間の一時利用権（Temporary Access）を得る（src/lib/plans/temporary-access.ts）。
 *
 * standard / premium の実際の契約状態は Stripe Subscription が正式な情報源であり、
 * Webhook経由でSupabase DBへ同期される（src/lib/plans/current-plan.tsのgetServerPlan）。
 */
export type Plan = "free" | "standard" | "premium";

export const PLAN_IDS: readonly Plan[] = ["free", "standard", "premium"] as const;

/**
 * ツール自体が要求する最低利用区分。
 *
 * 「free」という requiredPlan は存在しない。
 * free ユーザーは standard 対象ツールを広告視聴によって利用できるため、
 * ツール自体の最低区分は standard が下限となる
 * （= standard tool は無料でも広告視聴で利用可能 / premium tool はプレミアムのみ）。
 */
export type RequiredPlan = "standard" | "premium";

export interface PlanDefinition {
  id: Plan;
  /** 表示名（UIにハードコードせず、必ずここを参照する） */
  name: string;
  /** 月額料金（円）。0 = 無料 */
  priceYen: number;
  /** このプランで広告表示が必要か */
  adsRequired: boolean;
  /** 利用できるツールの範囲 */
  toolAccess: RequiredPlan | "all";
  /** 料金ページ等に表示する短い説明文 */
  description: string;
}

/**
 * プラン情報の唯一の情報源（Single Source of Truth）。
 * 料金・表示名・広告有無・利用範囲を各UIに直接ハードコードせず、必ずここを参照する。
 */
export const PLAN_DEFINITIONS: Record<Plan, PlanDefinition> = {
  free: {
    id: "free",
    name: "無料",
    priceYen: 0,
    adsRequired: true,
    toolAccess: "standard",
    description: "広告を見ることでスタンダード対象ツールを利用できます",
  },
  standard: {
    id: "standard",
    name: "スタンダード",
    priceYen: 550,
    adsRequired: false,
    toolAccess: "standard",
    description: "広告なしでスタンダード対象ツールを利用できます",
  },
  premium: {
    id: "premium",
    name: "プレミアム",
    priceYen: 980,
    adsRequired: false,
    toolAccess: "all",
    description: "広告なしですべてのツールを利用できます",
  },
};
