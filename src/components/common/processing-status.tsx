"use client";

import { useEffect } from "react";
import { Spinner } from "@/components/ui/spinner";
import { announceProcessingSuccess } from "@/lib/utils/result-events";

export type ProcessingState = "idle" | "processing" | "success" | "error";

/**
 * 処理中・完了の表示（エラーは ErrorMessage が別に出す）。
 * - 処理中: スピナー＋文字。進捗率は出さない（実際に測れていない値を見せないため）。
 * - 完了: チェックマーク＋文字（色だけに頼らない）。
 * どちらも role="status" で、スクリーンリーダーに状態の変化が伝わる。
 */
export function ProcessingStatus({
  state,
  processingLabel = "処理中...",
  successLabel = "処理が完了しました",
  testId,
}: {
  state: ProcessingState;
  processingLabel?: string;
  successLabel?: string;
  /** 自動テスト用の識別子（省略可） */
  testId?: string;
}) {
  // 成功になった時に、完了ポップアップ（ResultPopup）へ知らせる。閉じてあっても、新しい結果でもう一度開く。
  useEffect(() => {
    if (state === "success") announceProcessingSuccess();
  }, [state]);

  if (state === "idle" || state === "error") return null;

  if (state === "processing") {
    return (
      <div role="status" aria-live="polite" data-testid={testId} className="ms-status text-ms-muted">
        <Spinner className="text-ms-accent dark:text-ms-focus" />
        <span>{processingLabel}</span>
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" data-testid={testId} className="ms-status text-ms-success">
      <span className="ms-status-icon" aria-hidden="true">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </span>
      <span className="font-medium">{successLabel}</span>
    </div>
  );
}
