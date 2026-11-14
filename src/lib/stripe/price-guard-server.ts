import "server-only";

import { PAID_PLAN_PRICE_YEN, type PaidPlan } from "@/lib/plans/types";
import { getStripeClient } from "./client";
import { isStripeConfigured, stripeConfig } from "./config";
import { checkPlanPrice, type PriceCheck } from "./price-guard";

/**
 * 有料プランの決済用Price IDが、画面に出している料金（Premium 月額1,100円・Standard 月額220円、税込）と一致しているかを確認する。
 * 通信の失敗・未設定は「確認できない」＝決済を受け付けない側に倒す。
 * 結果は短時間だけ保持する（Stripeへの問い合わせを減らす。値を変えた直後も数分で反映される）。
 */
const OK_TTL_MS = 5 * 60_000;
const NG_TTL_MS = 30_000;

type VerifyResult = PriceCheck | { ok: false; reason: "unavailable" | "not_configured" };

const cache = new Map<PaidPlan, { priceId: string; at: number; result: PriceCheck | { ok: false; reason: "unavailable" } }>();

export async function verifyPlanPrice(plan: PaidPlan): Promise<VerifyResult> {
  const priceId = stripeConfig.priceIds[plan];
  if (!isStripeConfigured() || !priceId) return { ok: false, reason: "not_configured" };
  const now = Date.now();
  const hit = cache.get(plan);
  if (hit && hit.priceId === priceId && now - hit.at < (hit.result.ok ? OK_TTL_MS : NG_TTL_MS)) return hit.result;
  let result: PriceCheck | { ok: false; reason: "unavailable" };
  try {
    const price = await getStripeClient().prices.retrieve(priceId);
    result = checkPlanPrice(price, PAID_PLAN_PRICE_YEN[plan]);
  } catch {
    result = { ok: false, reason: "unavailable" };
  }
  cache.set(plan, { priceId, at: now, result });
  return result;
}

/** Premiumの価格の確認（以前からの呼び出し口） */
export function verifyPremiumPrice(): Promise<VerifyResult> {
  return verifyPlanPrice("premium");
}
