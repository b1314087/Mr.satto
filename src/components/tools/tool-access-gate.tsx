"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Plan, RequiredPlan } from "@/lib/plans/types";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { canUseTool } from "@/lib/plans/access";
import { getRewardedAdService } from "@/lib/ads/reward-provider";
import { getTemporaryAccessService } from "@/lib/plans/temporary-access";
import { AdSlot } from "@/components/ads/ad-slot";

/**
 * Tool Access Gate（Phase 2-0: ツール利用前の権限制御 → Phase 3で本番判定に対応）。
 *
 * Tool Page（Server Component） → getServerPlan() でサーバー側の信頼できる
 * 状態（認証ユーザー + DB上の契約状態 + 署名付きTemporary Accessトークン）を解決
 *   → その結果を plan / isAuthenticated / temporaryAccessActive として
 *     このコンポーネントへpropsで渡す
 *   → Tool Access Gate → 利用権限判定
 *       ├── 利用可能・広告不要   -> children をそのまま表示
 *       ├── 利用可能・広告必要   -> 広告視聴の導線を表示し、視聴完了後に children を表示
 *       └── 利用不可・Premium必要 -> プレミアム案内を表示
 *
 * 重要：このコンポーネント自身はplanの「判定」を行わない（canUseTool()による
 * 表示の出し分けのみ）。plan自体はサーバー側（src/lib/plans/current-plan.ts の
 * getServerPlan()）で既に確定した値をpropsとして受け取るだけであり、
 * ブラウザ側の値を信用してPremium扱いにすることはできない。
 *
 * 広告視聴後のTemporary Access付与も、実際にはサーバー側の署名付きトークン
 * （Cookie）が正式な情報源。ここでの `unlockedOptimistically` はページ遷移
 * せずに即座にUIへ反映するための楽観的な表示に過ぎない
 * （src/lib/plans/temporary-access.ts のコメント参照）。
 *
 * 既存の RewardedDownloadGate は「ダウンロード時」の制御。
 * こちらは「ツールを利用する前」の制御で、役割が異なる別コンポーネント。
 */
export function ToolAccessGate({
  toolId,
  requiredPlan,
  plan,
  isAuthenticated,
  temporaryAccessActive,
  children,
}: {
  toolId: string;
  requiredPlan: RequiredPlan;
  /** src/lib/plans/current-plan.ts の getServerPlan() が解決した、サーバー確定のプラン */
  plan: Plan;
  isAuthenticated: boolean;
  /** サーバー側で検証済みの、Freeユーザーの一時利用権が現在有効かどうか */
  temporaryAccessActive: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const access = canUseTool(plan, requiredPlan);
  const [unlockedOptimistically, setUnlockedOptimistically] = useState(false);
  const [isWatchingAd, setIsWatchingAd] = useState(false);
  const [adErrorKind, setAdErrorKind] = useState<"denied" | "unavailable" | null>(null);

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
        <Link
          href="/pricing"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          料金プランを見る
        </Link>
      </div>
    );
  }

  // 状態②: 利用可能・広告必要（Temporary Accessが未取得/失効している間はゲート画面を表示）
  if (access.adRequired && !temporaryAccessActive && !unlockedOptimistically) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-10 text-center dark:border-neutral-800 dark:bg-neutral-900">
        <AdSlot placement="tool-page" />
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          無料プランでは、広告を見ると15分間このツール（スタンダード対象ツール全体）をご利用いただけます。
        </p>
        <button
          type="button"
          disabled={isWatchingAd}
          onClick={async () => {
            setIsWatchingAd(true);
            setAdErrorKind(null);
            const result = await getRewardedAdService().watchAd({ toolId });
            if (result === "granted") {
              try {
                // サーバー側で有効期限付きの署名トークンを発行し、Cookieへ保存する。
                await getTemporaryAccessService().grant();
                setUnlockedOptimistically(true);
                // サーバー側の状態（getServerPlan）を次回のツールページ表示にも
                // 反映させておく（今すぐの表示はunlockedOptimisticallyが担う）。
                router.refresh();
              } catch {
                setAdErrorKind("denied");
              }
            } else if (result === "unavailable") {
              setAdErrorKind("unavailable");
            } else {
              setAdErrorKind("denied");
            }
            setIsWatchingAd(false);
          }}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {isWatchingAd ? "広告を読み込み中..." : "広告を見て15分無料で使う"}
        </button>
        {adErrorKind === "unavailable" && (
          <p className="text-xs text-red-600 dark:text-red-400">
            現在、広告機能は準備中のためご利用いただけません。Standard・Premiumプランでは広告なしでご利用いただけます。
          </p>
        )}
        {adErrorKind === "denied" && (
          <p className="text-xs text-red-600 dark:text-red-400">
            広告の視聴が完了しませんでした。もう一度お試しください。
          </p>
        )}
        {!isAuthenticated && (
          <Link
            href="/pricing"
            className="text-xs text-neutral-400 underline-offset-2 hover:text-blue-600 hover:underline dark:text-neutral-500 dark:hover:text-blue-400"
          >
            広告なしで使いたい場合はこちら（料金プラン）
          </Link>
        )}
      </div>
    );
  }

  // 状態①: 利用可能・広告不要（Standard/Premium契約者、またはTemporary Access有効中）
  return <>{children}</>;
}
