"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AdSlot } from "@/components/ads/ad-slot";
import { getRewardedAdService, type RewardedAdState } from "@/lib/ads/reward-provider";
import { grantPageCredit } from "@/lib/tools/filled-pdf-to-excel/credit-actions";
import {
  getFilledPdfToExcelUsageStatus,
  consumeFilledPdfToExcelUsage,
  type FilledPdfToExcelUsageStatus,
  type ConsumeFilledPdfToExcelResult,
} from "@/lib/tools/filled-pdf-to-excel/usage-status-actions";

/**
 * 記入済みPDF→Excelの利用制限（広告視聴ゲート・ページ数上限・1日回数上限）UI。
 *
 * Phase 11で実装された自動抽出モードの利用制限ロジック・UIをそのまま
 * テンプレートモードでも使えるよう、フック(useFilledPdfToExcelUsage)と
 * 表示コンポーネント(UsageGatePanel)として切り出したもの。
 * どちらのモードも同じServer Actions（usage-status-actions.ts/credit-actions.ts/
 * free-daily-usage-actions.ts）を呼ぶため、消費した利用回数・ページ数は
 * モード間で共有される。
 *
 * 利用制限見直し（2026）で、Standardの1日上限到達後の「広告視聴で延長できる」
 * フォールバックを廃止し（新仕様は「Standardは広告なし・1日5回で完結」）、
 * 代わりにFree（匿名）側に1日あたりの回数上限を新設した。どちらも
 * usage.dailyLimitReached で判定し、ad-watchパネルとは別の「本日は終了」
 * パネルを表示する（needsAdBeforeRunはdailyLimitReachedの場合に自動的に
 * falseになるよう、usage-status-actions.ts側のrequiresAdで制御している）。
 */

export type AdPhase = "idle" | "loading" | "ready" | "showing" | "granting" | "unavailable" | "denied" | "error";

const AD_PHASE_LABEL: Partial<Record<AdPhase, string>> = {
  loading: "広告を準備しています...",
  ready: "広告を準備しています...",
  showing: "広告を表示しています...",
  granting: "視聴が完了しました。準備しています...",
};

export function useFilledPdfToExcelUsage() {
  const [usage, setUsage] = useState<FilledPdfToExcelUsageStatus | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [adPhase, setAdPhase] = useState<AdPhase>("idle");
  const adRequestInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getFilledPdfToExcelUsageStatus()
      .then((s) => {
        if (!cancelled) setUsage(s);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshUsage() {
    const s = await getFilledPdfToExcelUsageStatus();
    setUsage(s);
    return s;
  }

  async function handleWatchAd() {
    if (adRequestInFlight.current) return;
    adRequestInFlight.current = true;
    setAdPhase("loading");

    try {
      const result = await getRewardedAdService().watchAd({
        toolId: "filled-pdf-to-excel",
        onStateChange: (state: RewardedAdState) => {
          switch (state.status) {
            case "loading":
              setAdPhase("loading");
              break;
            case "ready":
              setAdPhase("ready");
              break;
            case "showing":
              setAdPhase("showing");
              break;
            case "rewarded":
              setAdPhase("granting");
              break;
            case "unavailable":
              setAdPhase("unavailable");
              break;
            case "error":
              setAdPhase("error");
              break;
            case "closed":
              break;
          }
        },
      });

      if (result === "granted") {
        setAdPhase("granting");
        try {
          await grantPageCredit();
        } catch {
          setAdPhase("error");
          return;
        }
        await refreshUsage();
        setAdPhase("idle");
        return;
      }

      setAdPhase(result === "unavailable" ? "unavailable" : "denied");
    } catch {
      setAdPhase("error");
    } finally {
      adRequestInFlight.current = false;
    }
  }

  async function consumeUsage(pageCount: number): Promise<ConsumeFilledPdfToExcelResult> {
    const result = await consumeFilledPdfToExcelUsage(pageCount);
    await refreshUsage();
    return result;
  }

  const isAdBusy = adPhase === "loading" || adPhase === "ready" || adPhase === "showing" || adPhase === "granting";
  const needsAdBeforeRun = !usageLoading && usage !== null && usage.requiresAd;

  return { usage, usageLoading, adPhase, isAdBusy, needsAdBeforeRun, handleWatchAd, refreshUsage, consumeUsage };
}

/**
 * consumeFilledPdfToExcelUsage() が allowed:false を返した理由を、
 * ユーザー向けの日本語メッセージに変換する（tool.tsx / template-panel.tsx の
 * 両方から共通で使い、文言の重複・食い違いを避ける）。
 */
export function describeConsumeFailure(
  result: Extract<ConsumeFilledPdfToExcelResult, { allowed: false }>
): string {
  switch (result.reason) {
    case "page-limit-exceeded":
      return `Free・Standardプランでは、1回につき最大${result.maxPages}ページまで処理できます。ページ数を減らすか、Premiumプランをご利用ください。`;
    case "daily-limit-exceeded":
      return "本日のご利用回数の上限に達しました。明日またお試しいただくか、Premiumプランもご検討ください。";
    case "ad-required":
      return "広告の視聴が必要です。下の「広告を見て利用する」ボタンからお試しください。";
  }
}

export function UsageGatePanel({
  usage,
  usageLoading,
  totalPages,
  adPhase,
  isAdBusy,
  onWatchAd,
}: {
  usage: FilledPdfToExcelUsageStatus | null;
  usageLoading: boolean;
  totalPages: number | null;
  adPhase: AdPhase;
  isAdBusy: boolean;
  onWatchAd: () => void;
}) {
  const needsAdBeforeRun = !usageLoading && usage !== null && usage.requiresAd;
  // Standardは新仕様で上限到達後も広告を提示しない（usage.requiresAdが常にfalseのため
  // needsAdBeforeRunは発生しない）。Freeは上限到達後、同じ理由でneedsAdBeforeRunが
  // falseになる代わりにこちらが表示される。
  const dailyLimitReached = !usageLoading && usage !== null && usage.dailyLimitReached;
  const overPageLimit = totalPages !== null && usage?.maxPagesPerUse != null && totalPages > usage.maxPagesPerUse;

  return (
    <>
      {totalPages !== null && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          合計ページ数: {totalPages}ページ
          {usage?.maxPagesPerUse != null && `（今回処理できる上限: ${usage.maxPagesPerUse}ページ）`}
        </p>
      )}

      {overPageLimit && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          Free・Standardプランでは、1回につき最大{usage?.maxPagesPerUse}ページまで処理できます（選択したファイルの合計は
          {totalPages}ページです）。ページ数を減らすか、Premiumプランをご利用ください。
        </div>
      )}

      {!usageLoading && usage && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300">
          {usage.plan === "premium" && <p>Premiumプランのため、ページ数・回数の制限なくご利用いただけます。</p>}
          {usage.plan === "standard" && usage.dailyUsed !== null && usage.dailyLimit !== null && (
            <p>
              Standardプラン（広告なし）: 本日は{usage.dailyLimit}回中 {usage.dailyUsed}回 利用済みです（1回あたり最大
              {usage.maxPagesPerUse}ページ）。
            </p>
          )}
          {usage.plan === "free" && usage.dailyUsed !== null && usage.dailyLimit !== null && (
            <p>
              無料プラン: 本日は{usage.dailyLimit}回中 {usage.dailyUsed}回 利用済みです。広告を見ると1回・最大
              {usage.maxPagesPerUse}ページまで処理できます。
            </p>
          )}
          {usage.creditActive && <p className="text-green-700 dark:text-green-400">広告視聴による利用権が有効です。</p>}
        </div>
      )}

      {dailyLimitReached && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            本日のご利用回数（{usage?.dailyLimit}回）の上限に達しました。明日また{usage?.plan === "free" ? "広告の視聴で" : ""}
            ご利用いただけます。
          </p>
          <Link
            href="/pricing"
            className="text-xs text-neutral-400 underline-offset-2 hover:text-blue-600 hover:underline dark:text-neutral-500 dark:hover:text-blue-400"
          >
            回数・ページ数の制限なく使いたい場合はこちら（料金プラン）
          </Link>
        </div>
      )}

      {needsAdBeforeRun && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-8 text-center dark:border-neutral-800 dark:bg-neutral-900">
          <AdSlot placement="tool-page" />
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            無料で使うには広告をご覧ください。広告を見ると1回・最大3ページまで処理できます。
          </p>
          <button
            type="button"
            disabled={isAdBusy}
            onClick={onWatchAd}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isAdBusy ? (AD_PHASE_LABEL[adPhase] ?? "広告を見て利用する") : "広告を見て利用する"}
          </button>
          {adPhase === "unavailable" && (
            <p className="text-xs text-red-600 dark:text-red-400">
              現在、広告を表示できません。しばらくしてからもう一度お試しください。Standard・Premiumプランでは広告なしでご利用いただけます。
            </p>
          )}
          {adPhase === "denied" && (
            <p className="text-xs text-red-600 dark:text-red-400">
              広告の視聴が完了しなかったため、利用権は付与されませんでした。もう一度お試しください。
            </p>
          )}
          {adPhase === "error" && (
            <p className="text-xs text-red-600 dark:text-red-400">エラーが発生しました。しばらくしてからもう一度お試しください。</p>
          )}
          <Link
            href="/pricing"
            className="text-xs text-neutral-400 underline-offset-2 hover:text-blue-600 hover:underline dark:text-neutral-500 dark:hover:text-blue-400"
          >
            広告なしで使いたい場合はこちら（料金プラン）
          </Link>
        </div>
      )}
    </>
  );
}
