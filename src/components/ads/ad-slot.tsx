"use client";

import { useEffect, useId } from "react";
import { adConfig, isAdsEnabled } from "@/lib/ads/config";

export type AdSlotPlacement =
  | "header"
  | "tool-page"
  | "footer"
  | "pre-download"
  | "post-download";

const PLACEMENT_LABEL: Record<AdSlotPlacement, string> = {
  header: "ヘッダー広告",
  "tool-page": "ツール内広告",
  footer: "フッター広告",
  "pre-download": "広告",
  "post-download": "広告",
};

const PLACEMENT_SLOT: Record<AdSlotPlacement, string> = {
  header: adConfig.slots.header,
  "tool-page": adConfig.slots.toolPage,
  footer: adConfig.slots.footer,
  "pre-download": adConfig.slots.preDownload,
  "post-download": adConfig.slots.postDownload,
};

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

/**
 * 広告を配置するための共通コンポーネント（第1段階）。
 *
 * Header広告 / Toolページ内広告 / Footer付近広告 / Download前後広告
 * のいずれの用途にも対応できるよう `placement` で見た目・スロットを切り替える。
 *
 * AdSenseの広告ID(NEXT_PUBLIC_ADSENSE_CLIENT_ID)が未設定の間は、
 * レイアウト検証用のプレースホルダーを表示するだけで、外部への通信は発生しない。
 */
export function AdSlot({
  placement,
  className,
}: {
  placement: AdSlotPlacement;
  className?: string;
}) {
  const uid = useId();
  const enabled = isAdsEnabled();

  useEffect(() => {
    if (!enabled) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // AdSenseスクリプトが未ロードの場合などは静かに無視し、UIは壊さない
    }
  }, [enabled]);

  if (!enabled) {
    return (
      <div
        role="complementary"
        aria-label={PLACEMENT_LABEL[placement]}
        data-ad-placement={placement}
        className={`flex min-h-[64px] w-full items-center justify-center rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-4 text-center text-[11px] text-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-600 ${className ?? ""}`}
      >
        {PLACEMENT_LABEL[placement]}（準備中）
      </div>
    );
  }

  return (
    <div
      data-ad-placement={placement}
      className={`w-full overflow-hidden text-center ${className ?? ""}`}
    >
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-600">
        広告
      </span>
      <ins
        key={uid}
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={adConfig.adsenseClientId}
        data-ad-slot={PLACEMENT_SLOT[placement]}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
