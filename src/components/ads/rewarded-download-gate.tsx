"use client";

import { useState } from "react";
import { AdSlot } from "./ad-slot";
import { DEFAULT_DOWNLOAD_ACCESS_MODE, type DownloadAccessMode } from "@/lib/download/types";
import { useShouldShowDownloadAds } from "@/lib/plans/plan-context";

interface RewardedDownloadGateProps {
  /** 現時点では常に "free"。将来 "rewarded" / "premium" に切り替えられる */
  mode?: DownloadAccessMode;
  /** 実際のダウンロード処理（Blob生成 + 保存）を行うコールバック */
  onDownload: () => void | Promise<void>;
  label?: string;
  disabled?: boolean;
}

function DownloadTriggerButton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void | Promise<void>;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 12m0 0l4.5-4.5M12 12V3"
        />
      </svg>
      {label}
    </button>
  );
}

/**
 * Download Gate（広告収益化 第1段階）。
 *
 * Tool Processing → Processed File → [このコンポーネント] → Download
 *
 * mode によってダウンロード前の挙動を切り替える設計にしておくことで、
 * 将来 "free" → "rewarded"（リワード広告視聴後に解除）へ、
 * あるいは "premium"（広告なしで即ダウンロード）へ、
 * ツール側のコードを変更せずに切り替えられるようにする。
 *
 * 広告とダウンロードボタンは視覚的に分離し、
 * 広告をダウンロードボタンのように見せない（誤クリック防止）。
 */
export function RewardedDownloadGate({
  mode = DEFAULT_DOWNLOAD_ACCESS_MODE,
  onDownload,
  label = "ダウンロード",
  disabled,
}: RewardedDownloadGateProps) {
  const [rewardUnlocked, setRewardUnlocked] = useState(false);
  // Phase 20: Standard/Premium（広告なしプラン）のユーザーには、ダウンロード
  // ボタンの前後に通常のAdSlotを表示しない。ツール一覧・Pricing・ToolAccessGate
  // 等ですでに「広告なし」と案内している内容と、ダウンロード直前の画面が
  // 矛盾しないようにするための表示切り替えであり、ダウンロードボタン自体の
  // 表示・有効/無効には一切影響しない（広告の有無と処理成否を結び付けない）。
  const showAds = useShouldShowDownloadAds();

  // premium: 広告なしで即ダウンロード。Standard/Premiumプラン自体はPhase 3で
  // 実装済みだが、そのユーザーへの広告非表示は下のfreeモード内のshowAds判定で
  // 既に実現できているため、このmode切り替え自体は現時点では使用しない
  // （DEFAULT_DOWNLOAD_ACCESS_MODEは常に"free"。src/lib/download/types.ts参照）。
  if (mode === "premium") {
    return <DownloadTriggerButton onClick={onDownload} label={label} disabled={disabled} />;
  }

  // rewarded: リワード広告の視聴完了後にダウンロードを解除する
  // TODO(Phase 2): Googleの広告方式・利用可能なAPIが確定した時点で、
  // 実際の「視聴完了」イベントをここに接続する。それまでは未実装として扱う。
  if (mode === "rewarded" && !rewardUnlocked) {
    return (
      <div className="flex flex-col items-center gap-3">
        <AdSlot placement="pre-download" />
        <button
          type="button"
          disabled
          title="リワード広告によるダウンロードはPhase 2以降で提供予定です"
          onClick={() => setRewardUnlocked(true)}
          className="cursor-not-allowed rounded-lg border border-dashed border-neutral-300 px-4 py-2 text-sm text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
        >
          広告を見てダウンロードを解除する（準備中）
        </button>
      </div>
    );
  }

  // free（デフォルト）: 通常広告を表示しつつ、ダウンロード自体はすぐに行える。
  // ただしStandard/Premium（広告なしプラン）と分かっている場合は広告枠自体を出さない。
  return (
    <div className="flex flex-col items-center gap-3">
      {showAds && <AdSlot placement="pre-download" />}
      <DownloadTriggerButton onClick={onDownload} label={label} disabled={disabled} />
      {showAds && <AdSlot placement="post-download" />}
    </div>
  );
}
