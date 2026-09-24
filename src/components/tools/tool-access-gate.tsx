"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Plan, RequiredPlan } from "@/lib/plans/types";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { canUseTool } from "@/lib/plans/access";
import { getTemporaryAccessService } from "@/lib/plans/temporary-access";
import { RewardedAdCta } from "@/components/ads/rewarded-ad-cta";
import { TemporaryAccessBanner } from "@/components/tools/temporary-access-banner";

/**
 * Tool Access Gate（Phase 2-0: ツール利用前の権限制御 → Phase 3で本番判定 → Phase 4でRewarded Ad本番化）。
 *
 * Tool Page（Server Component） → getServerPlan() でサーバー側の信頼できる
 * 状態（認証ユーザー + DB上の契約状態 + 署名付きTemporary Accessトークン）を解決
 *   → その結果を plan / isAuthenticated / temporaryAccessActive としてpropsで渡す
 *   → Tool Access Gate → 利用権限判定（Phase 4 spec 15章の6状態）
 *       1. Free + Standard tool + Temporary Accessあり            -> children
 *       2. Free + Standard tool + Temporary Accessなし            -> Rewarded Ad CTA
 *       3. Standard + Standard tool                               -> children
 *       4. Standard + Premium tool                                -> Premium限定案内
 *       5. Premium + Standard tool                                -> children
 *       6. Premium + Premium tool                                 -> children
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
 * 既存の RewardedDownloadGate は「ダウンロード時」の制御（現在は常にfreeモードで
 * 未使用）。こちらは「ツールを利用する前」の制御で、役割が異なる別コンポーネント。
 */
export function ToolAccessGate({
  toolId,
  requiredPlan,
  plan,
  isAuthenticated,
  temporaryAccessActive,
  temporaryAccessExpiresAtMs,
  children,
}: {
  toolId: string;
  requiredPlan: RequiredPlan;
  /** src/lib/plans/current-plan.ts の getServerPlan() が解決した、サーバー確定のプラン */
  plan: Plan;
  isAuthenticated: boolean;
  /** サーバー側で検証済みの、Freeユーザーの一時利用権が現在有効かどうか */
  temporaryAccessActive: boolean;
  /** サーバー側で検証済みの、Temporary Accessの有効期限（ms epoch）。無効な場合はnull */
  temporaryAccessExpiresAtMs: number | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const access = canUseTool(plan, requiredPlan);
  const [unlockedOptimistically, setUnlockedOptimistically] = useState(false);

  const isGated = access.allowed && access.adRequired && !temporaryAccessActive && !unlockedOptimistically;

  // 複数タブ間の同期（Phase 4 spec 13章）。
  // 他タブでの広告視聴による付与（BroadcastChannel通知）と、タブが再びアクティブに
  // なったタイミングの両方をきっかけに、サーバー側の最新状態を再取得する。
  // Cookieはブラウザ内の全タブで共有されるため、実際の可否判定は常にサーバー側で
  // 行われる（ここでの判定はあくまで「見に行くきっかけ」に過ぎない）。
  useEffect(() => {
    if (!isGated) return;

    const unsubscribe = getTemporaryAccessService().subscribeToCrossTabGrant(() => {
      router.refresh();
    });

    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && getTemporaryAccessService().isActive()) {
        router.refresh();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isGated, router]);

  // 状態④/⑥: 利用不可・Premium必要（Free/Standardユーザーの前ではPremiumツールは
  // 常にこの案内になる。FreeのTemporary Accessの有無はここでは一切考慮しない。
  // Phase 4 spec 16章：15分の無料利用権をPremiumツールへ適用しない）
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

  // 状態②: 利用可能・広告必要（Temporary Accessが未取得/失効している間はRewarded Ad CTAを表示）
  if (isGated) {
    return (
      <RewardedAdCta
        toolId={toolId}
        isAuthenticated={isAuthenticated}
        onGranted={() => setUnlockedOptimistically(true)}
      />
    );
  }

  // 状態①③⑤: 利用可能・広告不要（Standard/Premium契約者）、
  //           または Free + Temporary Access有効中（広告視聴済み・残り時間内）
  const showRemainingTimeBanner =
    plan === "free" && (temporaryAccessActive || unlockedOptimistically) && temporaryAccessExpiresAtMs !== null;

  return (
    <>
      {showRemainingTimeBanner && (
        <TemporaryAccessBanner expiresAtMs={temporaryAccessExpiresAtMs as number} />
      )}
      {children}
    </>
  );
}
