"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { registerDownloadGate, type GatedAction } from "@/lib/download/download-gate";
import {
  getRewardedAdService,
  isFallbackEligibleReason,
  type RewardedAdState,
} from "@/lib/ads/reward-provider";
import { getTemporaryAccessService } from "@/lib/plans/temporary-access";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { TEMP_ACCESS_DURATION_MS } from "@/lib/plans/temporary-access-cookie";
import { featureFlags } from "@/lib/config/features";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";

/**
 * ダウンロード時の広告確認（Free向けの「広告を見て1時間利用する」導線）。
 *
 * Tool Processing → Processed File → Download Gate(このコンポーネント) → Download
 *
 * 動作：
 *   1. 各ツールが downloadBlob() を呼ぶと、src/lib/download/download-gate.ts の関所が
 *      ここ（登録されたコントローラー）へ問い合わせる。
 *   2. 広告視聴が不要なら（Standard/Premium、有効な利用権あり、広告ゲート無効）その場で保存する。
 *   3. 必要なら保存を保留し、広告の確認画面を表示する。保留するのはBlobへの参照だけで、
 *      広告の表示中もブラウザのメモリ上に保持される（ファイルは失われない）。
 *   4. ユーザーが「広告を見る」を明示的に押したときだけ、リワード広告を要求する
 *      （ツールを開いただけでは広告を要求しない）。
 *   5. Googleの報酬付与イベントを確認できたら、広告視聴による1時間の利用権を付与する。
 *      広告自体が配信されなかった場合（SDK読み込み失敗・在庫なし・タイムアウト等）は、
 *      暫定的に代替の1時間の利用権を付与し、広告を表示できなかったことを利用者へ伝える。
 *      広告を途中で閉じただけ（報酬付与イベントなし）の場合は、どちらも付与しない。
 *   6. 付与の後は、ユーザーが改めて「ダウンロードする」を押した時点で、保留していた
 *      保存を実行する。広告の後に自動でダウンロードを始めないのは、広告を挟んだ後の
 *      非同期処理からの自動ダウンロードが、ブラウザ（特にSafariやスマートフォン）に
 *      ブロックされる可能性があるため。ユーザー自身のクリックの中で保存するので確実に動く。
 *
 * ファイル本体・ファイル名・Blobをサーバーへ送ることはない。サーバーとやり取りするのは
 * 利用権の発行（引数なし、または広告が配信されなかった理由を表す短い文字列のみ）だけ。
 *
 * 重要：これは画面上の制御であり、ブラウザ内で完結する以上、完全な不正防止には
 * ならない（開発者ツール等で回避される可能性がある）。
 */

type Phase = "closed" | "prompt" | "busy" | "unlocked" | "denied" | "unavailable" | "error";

export function DownloadGateProvider({
  toolId,
  adRequired,
  children,
}: {
  toolId: string;
  /** この利用者にダウンロード時の広告視聴が必要か（Freeかつ広告ゲートが有効な場合のみ true） */
  adRequired: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("closed");
  const [busyLabel, setBusyLabel] = useState("広告を準備しています...");
  const [unlockKind, setUnlockKind] = useState<"ad" | "fallback" | null>(null);
  const [itemLabels, setItemLabels] = useState<string[]>([]);

  const adRequiredRef = useRef(adRequired);
  const queueRef = useRef<GatedAction[]>([]);
  // 広告視聴・代替付与の直後、Cookieの反映より先にこの時刻まで「利用権あり」とみなす
  const unlockedUntilMsRef = useRef(0);
  // 二重クリック対策（サービス層のSingleFlightと合わせた二重の防御）
  const requestInFlightRef = useRef(false);
  // 広告の報酬付与は確認できたが、利用権の発行(Server Action)に失敗した場合、
  // 次の再試行では広告を見せ直さず、発行だけをやり直す
  const rewardEarnedRef = useRef(false);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    adRequiredRef.current = adRequired;
  }, [adRequired]);

  const hasAccess = useCallback((): boolean => {
    return Date.now() < unlockedUntilMsRef.current || getTemporaryAccessService().isActive();
  }, []);

  // 関所への登録（アンマウント時に解除する）
  useEffect(() => {
    return registerDownloadGate({
      intercept(action: GatedAction): boolean {
        if (!adRequiredRef.current) return false;
        if (hasAccess()) return false;

        const queue = queueRef.current;
        // 同じ操作（同じBlob）の二重登録を防ぐ
        if (!queue.some((queued) => queued.key === action.key)) queue.push(action);
        setItemLabels(queue.map((queued) => queued.label));
        setPhase((current) => (current === "closed" ? "prompt" : current));
        return true;
      },
    });
  }, [hasAccess]);

  // 他タブで広告視聴による付与があった場合、このタブのサーバー側の表示（残り時間バナー等）を更新する
  useEffect(() => {
    if (!adRequired) return;
    return getTemporaryAccessService().subscribeToCrossTabGrant(() => {
      router.refresh();
    });
  }, [adRequired, router]);

  // 画面が開いたら主要ボタンへフォーカスを移す
  useEffect(() => {
    if (phase !== "closed" && phase !== "busy") primaryButtonRef.current?.focus();
  }, [phase]);

  const close = useCallback(() => {
    queueRef.current = [];
    setItemLabels([]);
    setPhase("closed");
  }, []);

  function applyUnlocked(kind: "ad" | "fallback", expiresAtMs: number | null) {
    unlockedUntilMsRef.current = expiresAtMs ?? Date.now() + TEMP_ACCESS_DURATION_MS;
    rewardEarnedRef.current = false;
    setUnlockKind(kind);
    setPhase("unlocked");
    // サーバー側の状態（残り時間バナー等）を最新にする。ツールの入力・処理結果は
    // クライアントの状態として保持されたままなので、失われない。
    router.refresh();
  }

  async function grantAfterReward() {
    const snapshot = await getTemporaryAccessService().grant();
    applyUnlocked("ad", snapshot.expiresAtMs);
  }

  async function handleWatchAd() {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setPhase("busy");

    try {
      // 報酬の確認は済んでいるが、前回、利用権の発行に失敗していた場合は、広告を見せ直さない
      if (rewardEarnedRef.current) {
        setBusyLabel("利用権を準備しています...");
        await grantAfterReward();
        return;
      }

      setBusyLabel("広告を準備しています...");
      const outcome = await getRewardedAdService().watchAdWithOutcome({
        toolId,
        onStateChange: (state: RewardedAdState) => {
          switch (state.status) {
            case "loading":
            case "ready":
              setBusyLabel("広告を準備しています...");
              break;
            case "showing":
              setBusyLabel("広告を表示しています...");
              break;
            case "rewarded":
              setBusyLabel("視聴が完了しました。準備しています...");
              break;
            default:
              break;
          }
        },
      });

      if (outcome.result === "granted") {
        // 正式なreward event（rewardedSlotGranted）を受信できた場合のみ、
        // サーバーへ「広告視聴による付与」を依頼する（表示やクローズだけでは付与しない）。
        rewardEarnedRef.current = true;
        setBusyLabel("視聴が完了しました。準備しています...");
        await grantAfterReward();
        return;
      }

      if (outcome.result === "denied") {
        // 広告は配信されたが、報酬付与イベントなしで閉じられた。付与しない。
        setPhase("denied");
        return;
      }

      // outcome.result === "unavailable"：広告自体が配信されなかった
      if (!isFallbackEligibleReason(outcome.reason)) {
        setPhase("unavailable");
        return;
      }

      setBusyLabel("広告を表示できませんでした。利用権を準備しています...");
      const fallback = await getTemporaryAccessService().grantFallback(outcome.reason);
      if (!fallback.granted) {
        setPhase("unavailable");
        return;
      }
      // 広告は視聴されていない。種別は "fallback" として扱い、画面でもその旨を伝える。
      applyUnlocked("fallback", fallback.snapshot.expiresAtMs);
    } catch {
      setPhase("error");
    } finally {
      requestInFlightRef.current = false;
    }
  }

  function handleDownload() {
    // 保留していた操作を取り出して実行する。取り出した時点でキューは空になるので、
    // ボタンを二重に押しても二重にダウンロードされない。
    const actions = queueRef.current.splice(0);
    setItemLabels([]);
    setPhase("closed");
    for (const action of actions) action.run();
  }

  const isOpen = phase !== "closed";
  const countLabel = itemLabels.length > 1 ? `（${itemLabels.length}件）` : "";

  return (
    <>
      {children}
      {isOpen && (
        // 見た目・フォーカス管理・Tabの閉じ込め・背景スクロール停止・Escapeは共通のModalが担当する。
        // Escで閉じるのは広告の処理中以外（処理中は閉じない）。背景のクリックでは閉じない（誤タップ防止）。
        <Modal
          labelledBy="download-gate-title"
          onEscape={phase === "busy" ? undefined : close}
          overlayTestId="download-gate-overlay"
          panelTestId="download-gate-dialog"
          panelProps={{ "data-phase": phase }}
        >
            {phase === "prompt" && (
              <>
                <h2 id="download-gate-title" className="text-lg font-semibold text-ms-text">
                  ダウンロードの前に広告をご覧ください
                </h2>
                <p className="text-sm text-ms-muted">
                  無料でご利用の場合、広告を1回見ていただくと、1時間は他のツールを含めて広告なしでダウンロードできます。
                </p>
                <p className="text-xs text-ms-muted">
                  ファイルはお使いのブラウザの中で処理されており、広告の視聴でサーバーへ送信されることはありません。
                </p>
                <DownloadTargets labels={itemLabels} />
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    ref={primaryButtonRef}
                    data-modal-initial-focus
                    onClick={() => void handleWatchAd()}
                  >
                    広告を見てダウンロード
                  </Button>
                  <Button variant="secondary" onClick={close}>
                    キャンセル
                  </Button>
                </div>
                <PlanHint />
              </>
            )}

            {phase === "busy" && (
              <>
                <h2 id="download-gate-title" className="text-lg font-semibold text-ms-text">
                  しばらくお待ちください
                </h2>
                <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-ms-muted">
                  <Spinner />
                  {busyLabel}
                </p>
              </>
            )}

            {phase === "unlocked" && (
              <>
                <h2 id="download-gate-title" className="text-lg font-semibold text-ms-text">
                  {unlockKind === "fallback" ? "今回は広告なしでご利用いただけます" : "ありがとうございました"}
                </h2>
                {unlockKind === "fallback" ? (
                  <p className="text-sm text-ms-muted">
                    広告を表示できませんでした。ご不便をおかけしたため、今回は特別に1時間、広告なしでご利用いただけるようにしました。
                  </p>
                ) : (
                  <p className="text-sm text-ms-muted">
                    広告の視聴が完了しました。これから1時間は、他のツールを含めて広告なしでダウンロードできます。
                  </p>
                )}
                <DownloadTargets labels={itemLabels} />
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    ref={primaryButtonRef}
                    data-modal-initial-focus
                    onClick={handleDownload}
                  >
                    ダウンロードする{countLabel}
                  </Button>
                  <Button variant="secondary" onClick={close}>
                    閉じる
                  </Button>
                </div>
              </>
            )}

            {(phase === "denied" || phase === "unavailable" || phase === "error") && (
              <>
                <h2 id="download-gate-title" className="text-lg font-semibold text-ms-text">
                  {phase === "denied" ? "広告の視聴が完了しませんでした" : "広告を表示できませんでした"}
                </h2>
                <p className="text-sm text-ms-danger">
                  {phase === "denied" &&
                    "広告を最後まで視聴できなかったため、利用権は付与されませんでした。もう一度お試しください。処理済みのファイルはそのまま残っています。"}
                  {phase === "unavailable" &&
                    "現在、広告を表示できません。しばらくしてからもう一度お試しください。処理済みのファイルはそのまま残っています。"}
                  {phase === "error" &&
                    "エラーが発生しました。しばらくしてからもう一度お試しください。処理済みのファイルはそのまま残っています。"}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    ref={primaryButtonRef}
                    data-modal-initial-focus
                    onClick={() => void handleWatchAd()}
                  >
                    もう一度試す
                  </Button>
                  <Button variant="secondary" onClick={close}>
                    閉じる
                  </Button>
                </div>
                <PlanHint />
              </>
            )}
        </Modal>
      )}
    </>
  );
}

function DownloadTargets({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="max-h-24 overflow-y-auto rounded-ms-control bg-ms-hover-tint px-3 py-2 text-xs text-ms-muted">
      {labels.map((label, index) => (
        <li key={`${label}-${index}`} className="truncate">
          {label}
        </li>
      ))}
    </ul>
  );
}

function PlanHint() {
  // 課金システムがオフの間は、有料プランの案内を出さない（src/lib/config/features.ts）
  if (!featureFlags.billing) return null;
  return (
    <p className="text-xs text-ms-muted">
      Premium（月額{PLAN_DEFINITIONS.premium.priceYen.toLocaleString("ja-JP")}円・税込）に加入すると、広告なしでご利用いただけます。{" "}
      <Link href="/pricing" className="underline underline-offset-2 hover:text-ms-accent dark:hover:text-ms-focus">
        料金プランを見る
      </Link>
    </p>
  );
}
