"use client";

import Link from "next/link";
import { PremiumHint, PremiumTag } from "@/components/ui/premium-badge";
import { featureFlags } from "@/lib/config/features";
import type { BatchNotice } from "./use-batch-selection";

/**
 * 一括処理（複数ファイルをまとめて処理する機能）についての短い案内。
 * ファイル選択欄のすぐ下に出す。広告のように目立たせず、ほかの補足説明と同じ控えめな見た目にする。
 *
 * - プレミアム：一度に選べるファイル数の上限を知らせる。
 * - 無料・旧スタンダード：一括処理はプレミアムの機能で、1ファイルずつなら使えることを知らせる。
 * - 課金の機能スイッチがオフの間は、プランの話をしない（上限だけを知らせる）。
 */
export function BatchPlanHint({ batchAllowed, limit, unit = "ファイル" }: { batchAllowed: boolean; limit: number; unit?: string }) {
  // 1行の小さな案内にする（UI・UX改善）。有料機能の印は PremiumTag / PremiumHint と同じ見た目
  if (batchAllowed) {
    return (
      <p className="ms-premium-hint" data-testid="batch-hint">
        <span>
          一度に{limit}
          {unit}まで、まとめて処理できます
        </span>
        {featureFlags.billing && <PremiumTag />}
      </p>
    );
  }
  return (
    <PremiumHint testId="batch-hint">
      複数の{unit === "枚" ? "画像" : "ファイル"}の一括処理（最大{limit}
      {unit}）は
    </PremiumHint>
  );
}

/** ファイルを減らしたとき・プランを確認できなかったときの案内（閉じるボタン付き） */
export function BatchNoticeMessage({ notice, onClose }: { notice: BatchNotice | null; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="batch-notice"
      className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {notice.kind === "premium" && (
          <>
            <p className="font-medium">一度に処理できるのは1ファイルです。</p>
            <p>
              「{notice.keptName}」を読み込みました。複数のファイルをまとめて処理する一括処理は、プレミアムプランの機能です。
              1ファイルずつなら、これまでどおりご利用いただけます。
            </p>
          </>
        )}
        {notice.kind === "limit" && (
          <p>
            一度に処理できるのは{notice.limit}ファイルまでです。超えた{notice.dropped}ファイルは読み込んでいません。
            残りは、この処理が終わったあとに、もう一度選んでください。
          </p>
        )}
        {notice.kind === "revoked" && (
          <>
            <p className="font-medium">プレミアムプランを確認できなかったため、一括処理を開始できませんでした。</p>
            <p>
              ログインの状態や契約の状態が変わった可能性があります。ファイルを1つにすると、そのまま処理できます。
            </p>
          </>
        )}
        {notice.kind !== "limit" && featureFlags.billing && (
          <Link href="/pricing" className="w-fit text-sm font-medium underline underline-offset-2">
            料金プランを見る
          </Link>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="案内を閉じる"
        className="rounded-md px-2 text-lg leading-none text-amber-900/70 hover:text-amber-900 dark:text-amber-200/70 dark:hover:text-amber-200"
      >
        ×
      </button>
    </div>
  );
}
