"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdSlot } from "./ad-slot";
import { getRewardedAdService, type RewardedAdState } from "@/lib/ads/reward-provider";
import { getTemporaryAccessService } from "@/lib/plans/temporary-access";

/**
 * Freeユーザー向けの「広告を見て15分無料で使う」導線（Phase 4）。
 *
 * 通常のAdSlot（display広告）とは責務を明確に分離する（Phase 4 spec 23章）：
 * このコンポーネントが表示するのはRewarded Ad専用のCTAであり、AdSlotで
 * 広告収益が発生しても、それだけでTemporary Accessが付与されることはない。
 *
 * 状態遷移（Phase 4 spec 8章）：
 *   idle -> loading -> ready -> showing -> granting -> (children表示へ切替)
 *                                        \-> unavailable
 *                                        \-> denied
 *                                        \-> error
 */
type UiPhase =
  | "idle"
  | "loading"
  | "ready"
  | "showing"
  | "granting"
  | "unavailable"
  | "denied"
  | "error";

const PHASE_LABEL: Partial<Record<UiPhase, string>> = {
  loading: "広告を準備しています...",
  ready: "広告を準備しています...",
  showing: "広告を表示しています...",
  granting: "視聴が完了しました。ツールを準備しています...",
};

export function RewardedAdCta({
  toolId,
  isAuthenticated,
  onGranted,
}: {
  toolId: string;
  isAuthenticated: boolean;
  onGranted: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<UiPhase>("idle");
  // UI層での二重クリック対策。サービス層(SingleFlightRewardedAdService)の
  // ガードと合わせた二重の防御（Phase 4 spec 8章・21章）。
  const requestInFlight = useRef(false);

  const isBusy = phase === "loading" || phase === "ready" || phase === "showing" || phase === "granting";

  async function handleWatchAd() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setPhase("loading");

    try {
      const result = await getRewardedAdService().watchAd({
        toolId,
        onStateChange: (state: RewardedAdState) => {
          switch (state.status) {
            case "loading":
              setPhase("loading");
              break;
            case "ready":
              setPhase("ready");
              break;
            case "showing":
              setPhase("showing");
              break;
            case "rewarded":
              setPhase("granting");
              break;
            case "unavailable":
              setPhase("unavailable");
              break;
            case "error":
              setPhase("error");
              break;
            case "closed":
              // "closed" 自体は個別のUI状態を持たない。granted/deniedの結果は
              // watchAd()の戻り値側で処理する。
              break;
          }
        },
      });

      if (result === "granted") {
        setPhase("granting");
        try {
          // 正式なreward event（rewardedSlotGranted）を受信できた場合のみ、
          // ここでサーバー側に署名付きトークンを発行してもらう
          // （Phase 4 spec 9章：表示開始やクローズだけでは付与しない）。
          await getTemporaryAccessService().grant();
        } catch {
          setPhase("error");
          return;
        }
        onGranted();
        // サーバー側の状態（getServerPlan）を次回のツールページ表示にも
        // 反映させておく。今すぐの表示切替はonGranted()側の楽観的更新が担う。
        router.refresh();
        return;
      }

      setPhase(result === "unavailable" ? "unavailable" : "denied");
    } catch {
      setPhase("error");
    } finally {
      requestInFlight.current = false;
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 px-6 py-10 text-center dark:border-neutral-800 dark:bg-neutral-900">
      <AdSlot placement="tool-page" />

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        無料で使うには広告をご覧ください。広告を見ると15分間、スタンダード対象ツールをまとめて利用できます。
      </p>

      <button
        type="button"
        disabled={isBusy}
        onClick={() => void handleWatchAd()}
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {isBusy ? (PHASE_LABEL[phase] ?? "広告を見て15分無料で使う") : "広告を見て15分無料で使う"}
      </button>

      {phase === "unavailable" && (
        <p className="text-xs text-red-600 dark:text-red-400">
          現在、無料利用用の広告を表示できません。しばらくしてからもう一度お試しください。Standard・Premiumプランでは広告なしでご利用いただけます。
        </p>
      )}
      {phase === "denied" && (
        <p className="text-xs text-red-600 dark:text-red-400">
          広告の視聴が完了しなかったため、無料利用は開始されませんでした。もう一度お試しください。
        </p>
      )}
      {phase === "error" && (
        <p className="text-xs text-red-600 dark:text-red-400">
          エラーが発生しました。しばらくしてからもう一度お試しください。
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
