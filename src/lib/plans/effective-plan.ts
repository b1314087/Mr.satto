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
  plan: Exclude<Plan, "free">;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export function resolveEffectivePlan(subscription: SubscriptionSnapshot | null): Plan {
  return subscription !== null && ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) ? subscription.plan : "free";
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
