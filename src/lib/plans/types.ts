/**
 * Mr.Satto の料金プラン（2026-10 に料金体系を統一）。
 *
 * 現行の料金体系（2026-11 にスタンダードを月220円で再開。新規のお申し込みができるのは、この3つ）：
 *
 * free     : 0円。ログイン不要。広告がオンのときは、ダウンロードのたびにリワード広告を視聴
 * standard : 月額220円（税込）。ログイン必須。広告なしで通常ツールを利用可能（一括処理・AI・プレミアム限定の機能は含まない）
 * premium  : 月額1,100円（税込）。ログイン必須。広告なしですべてのツールと、一括処理・AIによる読み取り補助を利用可能
 *
 * 旧スタンダード（月額550円）の契約者はいない（運営者の試験のみ）ため、価格の移行は扱わない。
 * 旧Premium（月額980円）の契約も、アプリ内では premium として扱う（価格の違いでプランを分けない）。
 *
 * 重要：「広告も見ない」「料金も払わない」でそのまま使える
 * 完全無料プランは、最終仕様として存在しない。
 * free ユーザーは広告がオンのとき、ダウンロードのたびに Rewarded Ads を1回視聴する
 * （2026-11 から。視聴後に使える時間は0。src/lib/plans/temporary-access-cookie.ts の TEMP_ACCESS_DURATION_MS）。
 *
 * standard・premium の実際の契約状態は Stripe Subscription が正式な情報源であり、
 * Webhook経由でSupabase DBへ同期される（src/lib/plans/current-plan.tsのgetServerPlan）。
 */
export type Plan = "free" | "standard" | "premium";

export const PLAN_IDS: readonly Plan[] = ["free", "standard", "premium"] as const;

/** 現行の料金体系で、料金ページに表示し、新規のお申し込みを受け付けるプラン（2026-11 から standard も含める） */
export const OFFERED_PLAN_IDS = ["free", "standard", "premium"] as const satisfies readonly Plan[];

/** 有料プラン（お申し込みを受け付けるもの） */
export type PaidPlan = Exclude<Plan, "free">;

/** Premiumの月額（税込・円）。表示と、Stripeの実際の価格との照合（src/lib/stripe/price-guard.ts）の両方がこの値を使う */
export const PREMIUM_PRICE_YEN = 1100;

/** Standardの月額（税込・円）。Premiumと同じく、表示とStripeの実際の価格との照合の両方がこの値を使う */
export const STANDARD_PRICE_YEN = 220;

/** 有料プランの月額（税込・円） */
export const PAID_PLAN_PRICE_YEN: Record<PaidPlan, number> = { standard: STANDARD_PRICE_YEN, premium: PREMIUM_PRICE_YEN };

/**
 * ツールの区分の表示名（ツールのカードのバッジ）。旧プラン名の「スタンダード」とは別の、ツールの区分の名前。
 * requiredPlan が "standard" のツールは、無料プランで使える（以前の表示「通常」は、何が通常なのか伝わらなかったため変更）。
 */
export const TOOL_TIER_LABELS: Record<RequiredPlan, string> = {
  standard: "無料で使える",
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
    name: "スタンダード",
    priceYen: STANDARD_PRICE_YEN,
    adsRequired: false,
    toolAccess: "standard",
    description: "広告なしで通常ツールを利用できます",
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
