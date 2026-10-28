/**
 * 処理の状態が変わったことを、画面の別の部品へ知らせるための合図（ブラウザのイベント名）。
 * ProcessingStatus が「成功」になった時に送り、ResultPopup（完了ポップアップ）が、
 * いったん閉じていても、新しい結果ができたらもう一度開くために受け取る。
 */
export const PROCESSING_STATE_EVENT = "ms-processing-state";

export function announceProcessingSuccess(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROCESSING_STATE_EVENT, { detail: "success" }));
}
