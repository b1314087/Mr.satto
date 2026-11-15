import "server-only";

import { paidPlanPriceYen, type BillingInterval, type PaidPlan } from "@/lib/plans/types";
import { getStripeClient } from "./client";
import { isStripeConfigured, priceIdFor } from "./config";
import { checkPlanPrice, type PriceCheck } from "./price-guard";

/**
 * 有料プランの決済用Price IDが、画面に出している料金（Premium 月額1,100円・Standard 月額220円、税込）と一致しているかを確認する。
 * 通信の失敗・未設定は「確認できない」＝決済を受け付けない側に倒す。
 * 結果は短時間だけ保持する（Stripeへの問い合わせを減らす。値を変えた直後も数分で反映される）。
 */
const OK_TTL_MS = 5 * 60_000;
const NG_TTL_MS = 30_000;

type VerifyResult = PriceCheck | { ok: false; reason: "unavailable" | "not_configured" };

const cache = new Map<string, { priceId: string; at: number; result: PriceCheck | { ok: false; reason: "unavailable" } }>();

/** interval は請求の周期（月額 "month"・年額 "year"。年額は 2026-11-15〜） */
export async function verifyPlanPrice(plan: PaidPlan, interval: BillingInterval = "month"): Promise<VerifyResult> {
  const priceId = priceIdFor(plan, interval);
  if (!isStripeConfigured() || !priceId) return { ok: false, reason: "not_configured" };
  const now = Date.now();
  const key = `${plan}:${interval}`;
  const hit = cache.get(key);
  if (hit && hit.priceId === priceId && now - hit.at < (hit.result.ok ? OK_TTL_MS : NG_TTL_MS)) return hit.result;
  let result: PriceCheck | { ok: false; reason: "unavailable" };
  try {
    const price = await getStripeClient().prices.retrieve(priceId);
    result = checkPlanPrice(price, paidPlanPriceYen(plan, interval), interval);
  } catch {
    result = { ok: false, reason: "unavailable" };
  }
  cache.set(key, { priceId, at: now, result });
  return result;
}

/** Premiumの価格の確認（以前からの呼び出し口） */
export function verifyPremiumPrice(): Promise<VerifyResult> {
  return verifyPlanPrice("premium");
}
