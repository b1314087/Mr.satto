import "server-only";

import { PREMIUM_PRICE_YEN } from "@/lib/plans/types";
import { getStripeClient } from "./client";
import { isStripeConfigured, stripeConfig } from "./config";
import { checkPremiumPrice, type PriceCheck } from "./price-guard";

/**
 * Premiumの決済用Price IDが、画面に出している料金（月額1,100円・税込）と一致しているかを確認する。
 * 通信の失敗・未設定は「確認できない」＝決済を受け付けない側に倒す。
 * 結果は短時間だけ保持する（Stripeへの問い合わせを減らす。値を変えた直後も数分で反映される）。
 */
const OK_TTL_MS = 5 * 60_000;
const NG_TTL_MS = 30_000;

let cache: { priceId: string; at: number; result: PriceCheck | { ok: false; reason: "unavailable" } } | null = null;

export async function verifyPremiumPrice(): Promise<PriceCheck | { ok: false; reason: "unavailable" | "not_configured" }> {
  const priceId = stripeConfig.priceIds.premium;
  if (!isStripeConfigured() || !priceId) return { ok: false, reason: "not_configured" };
  const now = Date.now();
  if (cache && cache.priceId === priceId && now - cache.at < (cache.result.ok ? OK_TTL_MS : NG_TTL_MS)) return cache.result;
  let result: PriceCheck | { ok: false; reason: "unavailable" };
  try {
    const price = await getStripeClient().prices.retrieve(priceId);
    result = checkPremiumPrice(price, PREMIUM_PRICE_YEN);
  } catch {
    result = { ok: false, reason: "unavailable" };
  }
  cache = { priceId, at: now, result };
  return result;
}
