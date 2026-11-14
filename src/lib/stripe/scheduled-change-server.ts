import "server-only";

import { getStripeClient } from "./client";
import { getPlanMapping, isPlanChangeReady } from "./config";
import { scheduledPlanFromPhases, type ScheduledPlanChange, type SchedulePhaseLike } from "./scheduled-change";
import type { PaidPlan } from "./subscription-sync";

/**
 * アカウント画面に「次回の更新日からスタンダードに変わります」などを出すため、予約中のプラン変更をStripeから読む。
 * 読めない（未設定・通信の失敗・スケジュールなし）ときは null（推測して表示しない）。読み取りだけで、契約は変更しない。
 */
export async function fetchScheduledPlanChange(stripeSubscriptionId: string | null | undefined, currentPlan: PaidPlan | null): Promise<ScheduledPlanChange | null> {
  if (!stripeSubscriptionId || !isPlanChangeReady()) return null;
  try {
    const subscription = await getStripeClient().subscriptions.retrieve(stripeSubscriptionId, { expand: ["schedule"] });
    const schedule = subscription.schedule;
    if (!schedule || typeof schedule === "string") return null;
    return scheduledPlanFromPhases(schedule.phases as unknown as SchedulePhaseLike[], currentPlan, getPlanMapping(), Math.floor(Date.now() / 1000));
  } catch {
    return null;
  }
}
