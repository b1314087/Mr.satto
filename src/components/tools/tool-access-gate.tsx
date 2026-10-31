"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { Plan, RequiredPlan } from "@/lib/plans/types";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { canUseTool } from "@/lib/plans/access";
import { DownloadGateProvider } from "@/components/ads/download-gate-provider";
import { isAdFreeToolId } from "@/lib/tools/ad-free-tools";
import { isRewardedAdGateActive } from "@/lib/ads/gam-config";
import { TemporaryAccessBanner } from "@/components/tools/temporary-access-banner";
import { featureFlags } from "@/lib/config/features";

/**
 * Tool Access Gate（Phase 2-0: ツール利用前の権限制御 → Phase 3で本番判定 →
 * Phase 4でRewarded Ad本番化 → Phase 1-13で広告の表示タイミングを「ダウンロード時」へ変更）。
 *
 * Tool Page（Server Component） → getServerPlan() でサーバー側の信頼できる
 * 状態（認証ユーザー + DB上の契約状態 + 署名付きTemporary Accessトークン）を解決
 *   → その結果を plan / temporaryAccessActive としてpropsで渡す
 *   → Tool Access Gate → 利用権限判定
 *       1. Free + Standard tool                                   -> children（ツールは広告なしで開ける）
 *          ・ダウンロード時に、有効な利用権がなければ広告視聴を求める
 *            （src/components/ads/download-gate-provider.tsx）
 *          ・有効な利用権(1時間)がある間は、広告なしでダウンロードできる
 *       2. Standard + Standard tool                               -> children（広告なし）
 *       3. Standard + Premium tool                                -> Premium限定案内
 *       4. Premium + Standard tool                                -> children（広告なし）
 *       5. Premium + Premium tool                                 -> children（広告なし）
 *       6. Free + Premium tool                                    -> Premium限定案内
 *
 * 以前は、Freeユーザーが「ツールを使う前」にここで広告視聴を求めていた。
 * 現在は、ツール自体は広告なしで開けて、処理済みファイルを「ダウンロードする時」に
 * 広告視聴を求める。広告の表示・報酬の確認・利用権の付与は DownloadGateProvider が行う。
 *
 * 重要：このコンポーネント自身はplanの「判定」を行わない（canUseTool()による
 * 表示の出し分けのみ）。plan自体はサーバー側（src/lib/plans/current-plan.ts の
 * getServerPlan()）で既に確定した値をpropsとして受け取るだけであり、
 * ブラウザ側の値を信用してPremium扱いにすることはできない。
 *
 * 広告視聴後のTemporary Access付与も、実際にはサーバー側の署名付きトークン
 * （Cookie）が正式な情報源（src/lib/plans/temporary-access.ts のコメント参照）。
 *
 * Premium限定ツールには、1時間の利用権があっても適用されない
 * （Phase 4 spec 16章：1時間の無料利用権をPremiumツールへ適用しない）。
 */
export function ToolAccessGate({
  toolId,
  requiredPlan,
  plan,
  temporaryAccessActive,
  temporaryAccessExpiresAtMs,
  children,
}: {
  toolId: string;
  requiredPlan: RequiredPlan;
  /** src/lib/plans/current-plan.ts の getServerPlan() が解決した、サーバー確定のプラン */
  plan: Plan;
  /** サーバー側で検証済みの、Freeユーザーの一時利用権が現在有効かどうか */
  temporaryAccessActive: boolean;
  /** サーバー側で検証済みの、Temporary Accessの有効期限（ms epoch）。無効な場合はnull */
  temporaryAccessExpiresAtMs: number | null;
  children: ReactNode;
}) {
  const access = canUseTool(plan, requiredPlan);

  // 広告(Rewarded Ad)がまだ使えない間(GAMの広告ユニット未設定＝審査中など)は、
  // 「広告を見ないとダウンロードできない」制限をかけず、Freeでもそのまま使えるようにする。
  // 広告ユニットを設定した時点で、自動的に制限が有効になる（src/lib/ads/gam-config.ts 参照）。
  // 広告を出さないツール（src/lib/tools/ad-free-tools.ts。領収書・レシートなど）では、ダウンロード時の広告確認も求めない。
  const downloadAdRequired = !isAdFreeToolId(toolId) && isRewardedAdGateActive() && access.allowed && access.adRequired;

  // 利用不可・Premium必要（Free/Standardユーザーの前ではPremiumツールは
  // 常にこの案内になる。FreeのTemporary Accessの有無はここでは一切考慮しない。
  // Phase 4 spec 16章：1時間の無料利用権をPremiumツールへ適用しない）
  if (!access.allowed) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-amber-300 bg-amber-50 px-6 py-16 text-center dark:border-amber-800 dark:bg-amber-950/30">
        <span className="rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">
          プレミアム限定
        </span>
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100">
          {featureFlags.billing
            ? "このツールはプレミアムプランで利用できます"
            : "このツールは現在ご利用いただけません"}
        </h2>
        <p className="max-w-md text-sm text-neutral-500 dark:text-neutral-400">
          {featureFlags.billing
            ? `プレミアムプラン（月額${PLAN_DEFINITIONS.premium.priceYen.toLocaleString("ja-JP")}円・広告なし・すべてのツールが利用可能）にご加入いただくと、このツールもお使いいただけます。`
            : "このツールは現在準備中です。"}
        </p>
        {featureFlags.billing && (
          <Link
            href="/pricing"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            料金プランを見る
          </Link>
        )}
      </div>
    );
  }

  // 利用可能。Free + Temporary Access有効中は、残り時間を表示する。
  const showRemainingTimeBanner =
    plan === "free" && temporaryAccessActive && temporaryAccessExpiresAtMs !== null;
  // Freeで広告ゲートが有効、かつ有効な利用権がない間は、ダウンロード時に広告を見るという案内を出す
  const showDownloadAdNotice = downloadAdRequired && !temporaryAccessActive;

  return (
    <DownloadGateProvider toolId={toolId} adRequired={downloadAdRequired}>
      {showRemainingTimeBanner && (
        <TemporaryAccessBanner expiresAtMs={temporaryAccessExpiresAtMs as number} />
      )}
      {showDownloadAdNotice && (
        <p
          data-testid="download-ad-notice"
          className="mb-4 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
        >
          無料でご利用いただけます。ダウンロードの際に広告を1回ご覧いただくと、1時間は広告なしでご利用いただけます。
        </p>
      )}
      {children}
    </DownloadGateProvider>
  );
}
