/**
 * Mr.Satto の料金プラン（2026-10 に料金体系を統一）。
 *
 * 現行の料金体系（新規のお申し込みができるのは、この2つだけ）：
 *
 * free     : 0円。ログイン不要。リワード広告視聴で1時間、通常ツールを利用可能
 * premium  : 月額1,100円（税込）。ログイン必須。広告なしですべてのツールと、AIによる読み取り補助を利用可能
 *
 * standard は旧プラン（月額550円）。新規の申し込みはできず、料金ページにも表示しない。
 * すでに契約中の人の権限（広告なしで通常ツールを利用）を、移行が終わるまで失わないために、型と判定だけを残している。
 * 旧Premium（月額980円）の契約も、アプリ内では premium として扱う（価格の違いでプランを分けない）。
 *
 * 重要：「広告も見ない」「料金も払わない」でそのまま使える
 * 完全無料プランは、最終仕様として存在しない。
 * free ユーザーは通常ツールの利用時に、Rewarded Ads の視聴によって
 * 1時間の一時利用権（Temporary Access）を得る（src/lib/plans/temporary-access.ts）。
 *
 * premium（および旧 standard）の実際の契約状態は Stripe Subscription が正式な情報源であり、
 * Webhook経由でSupabase DBへ同期される（src/lib/plans/current-plan.tsのgetServerPlan）。
 */
export type Plan = "free" | "standard" | "premium";

export const PLAN_IDS: readonly Plan[] = ["free", "standard", "premium"] as const;

/** 現行の料金体系で、料金ページに表示し、新規のお申し込みを受け付けるプラン（standard は含めない） */
export const OFFERED_PLAN_IDS = ["free", "premium"] as const satisfies readonly Plan[];

/** Premiumの月額（税込・円）。表示と、Stripeの実際の価格との照合（src/lib/stripe/price-guard.ts）の両方がこの値を使う */
export const PREMIUM_PRICE_YEN = 1100;

/** 通常ツール（requiredPlan が "standard" のツール）の表示名。旧プラン名の「スタンダード」とは別の、ツールの区分の名前 */
export const TOOL_TIER_LABELS: Record<RequiredPlan, string> = {
  standard: "通常",
  premium: "プレミアム",
};

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
    description: "広告を見ることで通常ツールを利用できます",
  },
  standard: {
    id: "standard",
    name: "スタンダード（旧プラン）",
    // 旧プランの月額。新規のお申し込みはできず、表示もしない。契約中の人の記録のためだけに残している
    priceYen: 550,
    adsRequired: false,
    toolAccess: "standard",
    description: "広告なしで通常ツールを利用できます（旧プラン・新規のお申し込みはできません）",
  },
  premium: {
    id: "premium",
    name: "プレミアム",
    priceYen: PREMIUM_PRICE_YEN,
    adsRequired: false,
    toolAccess: "all",
    description: "広告なしですべてのツールと、AIによる読み取り補助を利用できます",
  },
};
