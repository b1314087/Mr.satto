"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { RequiredPlan } from "@/lib/plans/types";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { getCurrentPlan } from "@/lib/plans/current-plan";
import { canUseTool } from "@/lib/plans/access";
import { getRewardedAdService } from "@/lib/ads/reward-provider";
import { AdSlot } from "@/components/ads/ad-slot";

/**
 * Tool Access Gate（Phase 2-0: ツール利用前の権限制御）。
 *
 * Tool Page → Tool Access Gate → 利用権限判定
 *   ├── 利用可能・広告不要   -> children をそのまま表示
 *   ├── 利用可能・広告必要   -> 広告視聴の導線を表示し、視聴完了後に children を表示
 *   └── 利用不可・Premium必要 -> プレミアム案内を表示（決済機能はまだない）
 *
 * 既存の RewardedDownloadGate は「ダウンロード時」の制御。
 * こちらは「ツールを利用する前」の制御で、役割が異なる別コンポーネント。
 *
 * 判定ロジック自体は持たず、canUseTool() の結果に応じて表示を出し分けるだけ
 * （ツールごとに判定コードを書かないための共通化）。
 */
export function ToolAccessGate({
  toolId,
  requiredPlan,
  children,
}: {
  toolId: string;
  requiredPlan: RequiredPlan;
  children: ReactNode;
}) {
  const plan = getCurrentPlan();
  const access = canUseTool(plan, requiredPlan);
  const [adUnlocked, setAdUnlocked] = useState(false);
  const [isWatchingAd, setIsWatchingAd] = useState(false);
  const [adError, setAdError] = useState(false);

  // 状態③: 利用不可・Premium必要
  if (!access.allowed) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-amber-300 bg-amber-50 px-6 py-16 text-center dark:border-amber-800 dark:bg-amber-950/30">
        <span className="rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">
          プレミアム限定
        </span>
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
          このツールはプレミアムプランで利用できます
        </h2>
        <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">
          プレミアムプラン（月額{PLAN_DEFINITIONS.premium.priceYen}円・広告なし・すべてのツールが利用可能）にご加入いただくと、このツールもお使いいただけます。
        </p>
        <button
          type="button"
          disabled
          title="決済機能は現在準備中です"
          className="cursor-not-allowed rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
        >
          プレミアムに登録する（準備中）
        </button>
      </div>
    );
  }

  // 状態②: 利用可能・広告必要（未視聴の間はゲート画面を表示）
  if (access.adRequired && !adUnlocked) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-10 text-center dark:border-neutral-800 dark:bg-neutral-900">
        <AdSlot placement="tool-page" />
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          無料プランでは、広告を見るとこのツールをご利用いただけます。
        </p>
        <button
          type="button"
          disabled={isWatchingAd}
          onClick={async () => {
            setIsWatchingAd(true);
            setAdError(false);
            const result = await getRewardedAdService().watchAd({ toolId });
            setIsWatchingAd(false);
            if (result === "granted") {
              setAdUnlocked(true);
            } else {
              setAdError(true);
            }
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {isWatchingAd ? "広告を読み込み中..." : "広告を見て無料で使う"}
        </button>
        {adError && (
          <p className="text-xs text-red-600 dark:text-red-400">
            広告の読み込みに失敗しました。もう一度お試しください。
          </p>
        )}
      </div>
    );
  }

  // 状態①: 利用可能・広告不要
  return <>{children}</>;
}
