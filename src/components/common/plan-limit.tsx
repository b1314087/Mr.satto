"use client";

import { useState } from "react";
import Link from "next/link";
import { PremiumHint } from "@/components/ui/premium-badge";
import { useCurrentPlan } from "@/lib/plans/plan-context";
import { featureFlags } from "@/lib/config/features";
import { PLAN_LIMITS, clampToLimit, formatLimit, getPlanLimit, type PlanLimitKey } from "@/lib/plans/tool-limits";
import { checkPlanLimitAccess } from "@/lib/plans/plan-limit-actions";

/**
 * ツールの「一度に扱える数」をプランに合わせて受け付ける（共通の部品。設定は src/lib/plans/tool-limits.ts）。
 *
 * - limit：今のプランでの上限（上限なしは Infinity）
 * - limited：プレミアムより少ない上限で使っているか（無料・スタンダード）
 * - clamp(items)：上限を超えた分を切り捨てて返し、切り捨てたときは案内（notice）を出す
 * - exceed(count)：数だけを確かめて、超えていれば案内を出して true を返す（行数・ページ数など、切り捨てられないもの向け）
 */
export function usePlanLimit(key: PlanLimitKey) {
  const plan = useCurrentPlan();
  const def = PLAN_LIMITS[key];
  // サーバーでの確認（confirmCount）で多い件数を使えないと分かったあとは、無料の上限にする（安全側）
  const [revoked, setRevoked] = useState(false);
  const limit = revoked ? def.free : getPlanLimit(key, plan);
  const premiumLimit: number = def.premium;
  const limited = limit < premiumLimit;
  const [notice, setNotice] = useState<PlanLimitNoticeState | null>(null);

  function clamp<T>(items: readonly T[]): T[] {
    const { kept, dropped } = clampToLimit(items, limit);
    setNotice(dropped > 0 ? { kind: "dropped", count: dropped } : null);
    return kept;
  }

  /** すでに currentCount 個あるところへ incoming を足すとき、上限に収まる分だけを返す */
  function clampAdd<T>(currentCount: number, incoming: readonly T[]): T[] {
    const room = Math.max(0, limit - currentCount);
    if (incoming.length <= room) {
      setNotice(null);
      return [...incoming];
    }
    setNotice({ kind: "dropped", count: incoming.length - room });
    return incoming.slice(0, room);
  }

  /** 1つ追加しようとしたとき、上限に達していれば案内を出して true を返す（追加ボタン向け） */
  function blockAdd(currentCount: number): boolean {
    if (currentCount < limit) return false;
    setNotice({ kind: "full", count: currentCount });
    return true;
  }

  function exceed(count: number): boolean {
    if (count <= limit) return false;
    setNotice({ kind: "over", count });
    return true;
  }

  /**
   * 処理を始める直前に呼ぶ。無料の上限を超える件数を処理するときは、サーバーで今のプランを確かめる
   * （画面を開いたあとにログアウト・契約終了・お試し終了があっても、多い件数を処理させない）。
   * 使えなければ案内を出し、上限を無料のものに下げて false を返す（呼び出し側は処理を始めない）。
   */
  async function confirmCount(count: number): Promise<boolean> {
    if (count > limit) {
      setNotice({ kind: "over", count });
      return false;
    }
    if (!featureFlags.billing || count <= def.free) return true;
    let ok = false;
    try {
      ok = await checkPlanLimitAccess(key, count);
    } catch {
      ok = false;
    }
    if (!ok) {
      setRevoked(true);
      setNotice({ kind: "over", count });
    }
    return ok;
  }

  /**
   * 処理を始める直前に呼ぶ（ページ数など、処理してみるまで数が分からず、上限を超えた分を切り捨てて処理するツール向け）。
   * 無料より多い上限で使っているときは、サーバーで今のプランを確かめ、使えなければ無料の上限を返す（処理は止めない）。
   */
  async function effectiveLimit(): Promise<number> {
    if (!featureFlags.billing || limit <= def.free || !Number.isFinite(def.free)) return limit;
    let ok = false;
    try {
      ok = await checkPlanLimitAccess(key, Number.isFinite(limit) ? limit : def.free + 1);
    } catch {
      ok = false;
    }
    if (ok) return limit;
    setRevoked(true);
    return def.free;
  }

  return {
    key,
    limit,
    /** 無料での上限（サーバーで確かめる必要があるかの目安） */
    free: def.free as number,
    premiumLimit,
    limited,
    unit: def.unit,
    label: def.label,
    notice,
    clearNotice: () => setNotice(null),
    clamp,
    clampAdd,
    blockAdd,
    exceed,
    confirmCount,
    effectiveLimit,
  };
}

export type PlanLimitState = ReturnType<typeof usePlanLimit>;

type PlanLimitNoticeState = { kind: "dropped" | "over" | "full"; count: number };

/** 上限を超えたときの案内（閉じるボタン付き）。超えていないときは何も出さない */
export function PlanLimitNotice({ state }: { state: PlanLimitState }) {
  const { notice, limit, premiumLimit, limited, unit, label } = state;
  if (!notice) return null;
  const showPlan = featureFlags.billing && limited;
  return (
    <div
      role="status"
      data-testid="plan-limit-notice"
      className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium">
          {showPlan ? "今のプランで" : ""}一度に扱える{label}は{formatLimit(limit, unit)}までです。
        </p>
        <p>
          {notice.kind === "dropped" && `超えた${notice.count.toLocaleString("ja-JP")}${unit}は読み込んでいません。`}
          {notice.kind === "over" && `今は${notice.count.toLocaleString("ja-JP")}${unit}あるため、このままでは処理できません。`}
          {notice.kind === "full" && "これ以上は追加できません。"}
          {showPlan && `プレミアムプランなら${formatLimit(premiumLimit, unit)}まで扱えます。`}
        </p>
        {showPlan && (
          <Link href="/pricing" className="w-fit text-sm font-medium underline underline-offset-2">
            料金プランを見る
          </Link>
        )}
      </div>
      <button
        type="button"
        onClick={state.clearNotice}
        aria-label="案内を閉じる"
        className="rounded-md px-2 text-lg leading-none text-amber-900/70 hover:text-amber-900 dark:text-amber-200/70 dark:hover:text-amber-200"
      >
        ×
      </button>
    </div>
  );
}

/** 無料・スタンダードのときだけ出す、上限の1行案内（例：「結合する画像は1回5枚まで。50枚まで扱えるのは」＋プレミアムプラン） */
export function PlanLimitHint({ state }: { state: PlanLimitState }) {
  if (!featureFlags.billing || !state.limited) return null;
  return (
    <PremiumHint testId="plan-limit-hint">
      {state.label}は{formatLimit(state.limit, state.unit)}まで。{formatLimit(state.premiumLimit, state.unit)}
      {Number.isFinite(state.premiumLimit) ? "まで" : "で"}使えるのは
    </PremiumHint>
  );
}
