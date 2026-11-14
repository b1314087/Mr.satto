import { resolvePlanFromItems, type PaidPlan, type PlanMapping } from "./subscription-sync";

/**
 * 予約中のプラン変更（プレミアム → スタンダードを次回の更新日から、など）を、Stripeの契約のスケジュールから読み取る純粋な処理。
 * ポータルで「次回の更新日から」の変更をすると、Stripeは契約にスケジュール（Subscription Schedule）を付け、
 * 今の期間の終わりから始まる次の段階（phase）に、新しい価格を入れる。アプリはその段階を読むだけで、何も変更しない。
 */
export interface SchedulePhaseLike {
  start_date: number;
  items: { price?: string | { id?: string | null } | null }[];
}

export interface ScheduledPlanChange {
  plan: PaidPlan;
  /** 切り替わる日時（ISO） */
  startsAt: string;
}

export function scheduledPlanFromPhases(
  phases: readonly SchedulePhaseLike[],
  currentPlan: PaidPlan | null,
  mapping: PlanMapping,
  nowSec: number,
): ScheduledPlanChange | null {
  const next = [...phases].filter((p) => p.start_date > nowSec).sort((a, b) => a.start_date - b.start_date)[0];
  if (!next) return null;
  const plan = resolvePlanFromItems(
    next.items.map((item) => ({ price: { id: typeof item.price === "string" ? item.price : (item.price?.id ?? null) } })),
    mapping,
  );
  if (!plan || plan === currentPlan) return null;
  return { plan, startsAt: new Date(next.start_date * 1000).toISOString() };
}
