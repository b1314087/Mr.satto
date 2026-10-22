import type { Plan } from "./types";

/**
 * 契約情報から実効プランを決める純粋な判定（サーバー専用の読み取り処理から切り離してあり、単体テストできる）。
 * 実際の読み取りは src/lib/plans/current-plan.ts（server-only）が行う。
 *
 * 「契約有効」はStripeのSubscription statusが active / trialing のときだけ。
 * 解約手続き中でも期間の終了までは active のままなので、そのまま契約を維持できる。
 * 支払い失敗（past_due / unpaid）・解約済み（canceled）・未完了（incomplete 等）はすべて free として扱い、
 * 権限が不適切に残り続けないようにする。
 */
export const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export interface SubscriptionSnapshot {
  /** null = 続いている契約はあるが、登録していない価格（有料プランとして扱わない） */
  plan: Exclude<Plan, "free"> | null;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export function resolveEffectivePlan(subscription: SubscriptionSnapshot | null): Plan {
  return subscription !== null && subscription.plan !== null && ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) ? subscription.plan : "free";
}

/**
 * AI機能を使える契約か（費用が発生する機能のための、より厳しい判定）。
 *
 * resolveEffectivePlan は status だけで判断する。Webhook（Stripeからの通知）が届かなくなった場合、
 * 契約の期間が過ぎても status が active のまま残るため、AIの利用枠が毎月新しく付与され続けてしまう。
 * そこで、契約期間の終了から猶予（AI_PERIOD_END_GRACE_MS）を過ぎても更新が確認できない契約は、
 * AIだけ使えないものとして扱う（通常のツールの権限には影響しない）。
 * 更新の通知が少し遅れる場合に備えた猶予であり、更新が確認できれば current_period_end が先へ進み、すぐに使える。
 * 期間の終了日が不明（null・読めない値）の古い行は、判定できないので status のままにする。
 */
export const AI_PERIOD_END_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export function resolveAiPlan(plan: Plan, subscription: SubscriptionSnapshot | null, nowMs: number): Plan {
  if (plan !== "premium" || subscription === null) return plan;
  if (subscription.currentPeriodEnd === null) return plan;
  const end = Date.parse(subscription.currentPeriodEnd);
  if (!Number.isFinite(end)) return plan;
  // 解約の予約がある契約は、更新されないので、期間の終了で猶予なしに終わる（Stripeの終了通知が遅れていても使わせない）
  if (subscription.cancelAtPeriodEnd) return end < nowMs ? "free" : plan;
  return end + AI_PERIOD_END_GRACE_MS < nowMs ? "free" : plan;
}

/** すでに終わった契約（再度申し込める状態） */
const ENDED_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

/**
 * まだ続いている（または支払いの確認中の）契約があるか。
 * ある間は新しいCheckoutを作らない。契約が二重になり、二重に請求されるのを防ぐため。
 * 権限の有無（resolveEffectivePlan）とは別の判定: 支払いの遅れ（past_due）などで権限がなくても、契約は続いている。
 */
export function hasOpenSubscription(subscription: SubscriptionSnapshot | null): boolean {
  return subscription !== null && !ENDED_SUBSCRIPTION_STATUSES.has(subscription.status);
}
