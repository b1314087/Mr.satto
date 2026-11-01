"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { announceProcessingSuccess } from "@/lib/utils/result-events";
import { busyHoldRemaining, markBusyStart } from "@/lib/utils/busy-hold";

export type ProcessingState = "idle" | "processing" | "success" | "error";

/**
 * 処理中・完了の表示（エラーは ErrorMessage が別に出す）。
 * - 処理中: 画面全体を薄暗くし、中央のパネル（スピナー＋文字）の周りを光が周回する（全ツール共通。見た目は globals.css の .ms-busy-*）。
 *   処理中は、後ろの画面を操作できない（二重の実行や、処理中の設定の変更を防ぐ）。中止できる処理は、onCancel を渡すと、パネルに中止のボタンが出る。
 *   進捗率は、ツールが実際に測れている場合だけ、文字（processingLabel）に入れる（測れていない値を見せないため）。
 * - 完了: チェックマーク＋文字（色だけに頼らない）。
 * どちらも role="status" で、スクリーンリーダーに状態の変化が伝わる。
 */
const subscribeNothing = () => () => {};
const isClient = () => true;
const isServer = () => false;

export function ProcessingStatus({
  state: actualState,
  processingLabel = "処理中...",
  successLabel = "処理が完了しました",
  testId,
  onCancel,
  cancelLabel = "キャンセル",
  canceling = false,
  cancelTestId,
}: {
  state: ProcessingState;
  processingLabel?: string;
  successLabel?: string;
  /** 自動テスト用の識別子（省略可） */
  testId?: string;
  /** 処理を中止できるとき、中止する関数（処理中のパネルに、中止のボタンを出す） */
  onCancel?: () => void;
  cancelLabel?: string;
  /** 中止を受け付けて、止まるのを待っている間（ボタンの代わりに「キャンセルしています…」を出す） */
  canceling?: boolean;
  /** 中止のボタンの、自動テスト用の識別子（省略可） */
  cancelTestId?: string;
}) {
  // 処理中の画面は document.body に出す（ツールの枠の外に、画面全体を覆うため）。サーバーでの表示では出さない
  const mounted = useSyncExternalStore(subscribeNothing, isClient, isServer);
  // 処理が速く終わっても、最低0.6秒は「処理中」の表示を続ける（src/lib/utils/busy-hold.ts）。
  // 続けるのは、この表示自身が「処理中」になったときだけ（同じ画面の別の処理の記録で、処理していない表示まで
  // 「処理中」にしない。処理中の画面は画面全体を覆うため、関係のない表示が残ると操作できなくなる）。
  const [ownHold, setOwnHold] = useState(false);
  if (actualState === "processing" && !ownHold) setOwnHold(true);
  useEffect(() => {
    if (actualState === "processing") {
      markBusyStart();
      return;
    }
    if (!ownHold) return;
    // 残りの時間が過ぎたら、表示を実際の状態に戻す
    const timer = setTimeout(() => setOwnHold(false), busyHoldRemaining() + 5);
    return () => clearTimeout(timer);
  }, [actualState, ownHold]);
  const state: ProcessingState =
    actualState !== "processing" && ownHold && busyHoldRemaining() > 0 ? "processing" : actualState;

  // 成功になった時に、完了ポップアップ（ResultPopup）へ知らせる。閉じてあっても、新しい結果でもう一度開く。
  useEffect(() => {
    if (state === "success") announceProcessingSuccess();
  }, [state]);

  if (state === "idle" || state === "error") return null;

  if (state === "processing") {
    if (!mounted) return null;
    return createPortal(
      <div className="ms-busy-overlay" data-testid="busy-overlay">
        <div className="ms-busy-panel" data-testid="busy-panel">
          <Spinner className="ms-busy-spinner" />
          <div role="status" aria-live="polite" data-testid={testId} className="text-sm font-medium">
            {canceling ? "キャンセルしています…" : processingLabel}
          </div>
          {onCancel && !canceling && (
            <Button variant="secondary" size="sm" data-testid={cancelTestId} onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
        </div>
      </div>,
      document.body
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
