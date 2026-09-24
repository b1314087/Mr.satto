import "server-only";

import type { Plan } from "@/lib/plans/types";

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
export const stripeConfig = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? "",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  priceIds: {
    standard: process.env.STRIPE_STANDARD_PRICE_ID ?? "",
    premium: process.env.STRIPE_PREMIUM_PRICE_ID ?? "",
  } satisfies Record<Exclude<Plan, "free">, string>,
};

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
