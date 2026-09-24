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
