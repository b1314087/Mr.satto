import type { PaidPlan } from "./types";
import { ACTIVE_SUBSCRIPTION_STATUSES, type SubscriptionSnapshot } from "./effective-plan";

/**
 * スタンダード ↔ プレミアムのプラン変更（2026-11 総合改修）。
 *
 * 変更そのものは、Stripeのカスタマーポータル（プラン変更の画面）で行う（自前で金額の計算・請求をしない）。
 *   スタンダード → プレミアム：すぐに切り替わる。差額はStripeが日割りで計算して、その場で請求する
 *   プレミアム → スタンダード：次回の更新日から切り替わる。それまではプレミアムのまま
 *   有料 → 無料（解約）：契約期間の終了時に無料になる（解約の予約。すぐには解約しない）
 * この動きは、ポータルの設定（scripts/create-portal-config.mjs）で決まる。
 * アプリのプランは、これまでどおりStripeからの通知（Webhook）で契約の価格が変わった時点で切り替わる
 * （通知が届くまでは、変更前のプランのまま。表示とサーバーの判定がずれないよう、画面ではプランを先回りして変えない）。
 *
 * ここは「どの変更ボタンを出すか」だけを決める純粋な判定（通信しない）。
 */
export type PlanChange = "upgrade" | "downgrade";

export function planChangeFor(subscription: SubscriptionSnapshot | null, target: PaidPlan): PlanChange | null {
  if (!subscription || subscription.plan === null) return null;
  if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) return null;
  // 解約を予約している契約は、先にポータルで解約の取り消しをしてもらう（予約中の変更を重ねない）
  if (subscription.cancelAtPeriodEnd) return null;
  if (subscription.plan === "standard" && target === "premium") return "upgrade";
  if (subscription.plan === "premium" && target === "standard") return "downgrade";
  return null;
}

export const PLAN_CHANGE_LABEL: Record<PlanChange, string> = {
  upgrade: "プレミアムに変更する（すぐに切り替わります）",
  downgrade: "スタンダードに変更する（次回の更新日から）",
};
