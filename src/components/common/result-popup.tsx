"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Modal } from "@/components/ui/modal";
import { PROCESSING_STATE_EVENT } from "@/lib/utils/result-events";
import { busyHoldRemaining } from "@/lib/utils/busy-hold";

/**
 * 完了ポップアップ（全ツール共通）。
 *
 * ファイルができたこと・ダウンロードできることが、画面をスクロールしないと分からない、という問題を防ぐため、
 * 作成の結果（ダウンロードボタンなど）を、画面の中央に、影つきのポップアップで出す。
 *
 * - 結果が出た時（この部品が表示された時）に、自動で開く。
 * - 「閉じる」ボタン・Escapeキー・背景のクリックで閉じられる。閉じても結果は消えず、
 *   元の位置に「結果を表示する」ボタンが残るので、あとからダウンロードできる。
 * - 閉じたあとでもう一度作成して成功したら、また自動で開く（ProcessingStatus からの合図を受け取る）。
 * - 設定を変えて結果が消えた時は、呼び出し側が表示をやめるので、ポップアップも一緒に消える。
 *
 * 中に何を入れるか（件数・サイズ・ダウンロードボタンなど）は、呼び出し側（children）が決める。
 */
export function ResultPopup({
  children,
  title = "できあがりました",
  size = "md",
  testId,
}: {
  children: ReactNode;
  title?: string;
  /** md: 通常（28rem）、lg: プレビューや一覧が入る時（42rem） */
  size?: "md" | "lg";
  /** 中身を包む要素の data-testid（自動テスト用） */
  testId?: string;
}) {
  const [open, setOpen] = useState(true);
  // 処理が速く終わっても、ボタンの光を最低0.6秒は見せるため、その分だけ、出すのを待つ（src/lib/utils/busy-hold.ts）
  const [waiting, setWaiting] = useState(() => busyHoldRemaining() > 0);
  const titleId = useId();

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaiting(false), busyHoldRemaining());
    return () => clearTimeout(timer);
  }, [waiting]);

  useEffect(() => {
    function handleSuccess(event: Event) {
      if ((event as CustomEvent).detail === "success") setOpen(true);
    }
    window.addEventListener(PROCESSING_STATE_EVENT, handleSuccess);
    return () => window.removeEventListener(PROCESSING_STATE_EVENT, handleSuccess);
  }, []);

  const close = () => setOpen(false);

  if (waiting) return null;

  if (!open) {
    return (
      <button
        type="button"
        data-testid="result-popup-reopen"
        onClick={() => setOpen(true)}
        className="w-fit rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        結果を表示する
      </button>
    );
  }

  return (
    <Modal
      labelledBy={titleId}
      onEscape={close}
      onBackdropClick={close}
      overlayTestId="result-popup-overlay"
      panelTestId="result-popup"
      panelProps={size === "lg" ? { style: { maxWidth: "42rem" } } : undefined}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-ms-text">
          <span className="ms-status-icon text-ms-success" aria-hidden="true">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </span>
          {title}
        </h2>
        <button
          type="button"
          onClick={close}
          aria-label="閉じる"
          className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div data-testid={testId} className="flex flex-col items-start gap-3">
        {children}
      </div>
    </Modal>
  );
}
