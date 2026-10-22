import "server-only";

import type { Plan } from "@/lib/plans/types";
import { parseIdList, type PlanMapping } from "./subscription-sync";

/**
 * Stripe関連の設定を一元管理する（src/lib/ads/config.ts と同じ方針）。
 *
 * 秘密情報（STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET）はNEXT_PUBLIC_を
 * 付けない。このファイルは "server-only" のため、誤ってクライアント
 * コンポーネントからimportした場合はビルドエラーになる。
 *
 * 実際のPrice ID等が現在の環境に存在しない場合、これらは空文字になる。
 * 架空のIDを埋め込むことはしない（Phase 3 spec 41章）。isStripeConfigured()が
 * falseの間、Checkout関連のAPI Routeは明確なエラーメッセージを返す。
 */
/**
 * .trim()しているのは、Vercel等のダッシュボードへ環境変数の値をコピー&ペーストする際、
 * 末尾に改行や空白が混入することがあり（コピー元によっては起こりうる）、それが原因で
 * StripeへのリクエストのAuthorizationヘッダーが不正な値になり
 * "Invalid character in header content" のようなエラーで接続自体が失敗する事例が
 * 実際にあったため（Phase 3運用開始時に確認済み）。
 */
function trimmedEnv(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const stripeConfig = {
  secretKey: trimmedEnv("STRIPE_SECRET_KEY"),
  webhookSecret: trimmedEnv("STRIPE_WEBHOOK_SECRET"),
  priceIds: {
    standard: trimmedEnv("STRIPE_STANDARD_PRICE_ID"),
    premium: trimmedEnv("STRIPE_PREMIUM_PRICE_ID"),
  } satisfies Record<Exclude<Plan, "free">, string>,
  /**
   * Premiumの判定に使う追加の設定（任意）。Checkoutが使う価格は priceIds.premium の1つだけで、ここは「契約の判定」用。
   *   STRIPE_PREMIUM_PRODUCT_ID        Premium専用のProduct ID。設定すると、その商品の価格はすべてPremiumとして扱う
   *                                    （旧980円と新1,100円を同じ商品の下に置けば、価格を移行してもコード側の変更が要らない）。
   *                                    他の用途の商品を含まないことを、Stripeダッシュボードで確認してから設定すること。
   *   STRIPE_PREMIUM_LEGACY_PRICE_IDS  移行が終わるまでだけPremiumとして扱う旧価格のID（カンマ区切り）。移行後は空にする。
   */
  premiumProductIds: parseIdList(process.env.STRIPE_PREMIUM_PRODUCT_ID),
  premiumLegacyPriceIds: parseIdList(process.env.STRIPE_PREMIUM_LEGACY_PRICE_IDS),
  /**
   * Customer Portal（解約・支払い方法の変更）の設定ID（bpc_…、任意）。
   * 同じStripeアカウントを別のサービスと共有している場合、指定しないと、そのアカウントの「既定のポータル設定」が使われ、
   * 他サービスの設定（解約の扱い・表示する商品など）がMr.Sattoの利用者にも適用されてしまう。
   * scripts/create-portal-config.mjs で、Mr.Satto専用の設定を作ってそのIDを設定する。
   */
  portalConfigurationId: trimmedEnv("STRIPE_PORTAL_CONFIGURATION_ID"),
};

/** 契約の価格 → プランの判定に使う対応表 */
export function getPlanMapping(): PlanMapping {
  return {
    premiumProductIds: stripeConfig.premiumProductIds,
    premiumPriceIds: [stripeConfig.priceIds.premium, ...stripeConfig.premiumLegacyPriceIds].filter((id) => id.length > 0),
    standardPriceIds: stripeConfig.priceIds.standard ? [stripeConfig.priceIds.standard] : [],
  };
}

/** Checkout Session等、Stripe課金機能を実際に呼び出せる状態か */
export function isStripeConfigured(): boolean {
  return stripeConfig.secretKey.length > 0;
}

/** Webhookの署名検証を行える状態か */
export function isStripeWebhookConfigured(): boolean {
  return isStripeConfigured() && stripeConfig.webhookSecret.length > 0;
}

/** 指定プランのPrice IDが設定されているか */
export function hasPriceIdFor(plan: Exclude<Plan, "free">): boolean {
  return stripeConfig.priceIds[plan].length > 0;
}
