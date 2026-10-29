import { Spinner } from "@/components/ui/spinner";

/**
 * ツール（・カテゴリ）のページを開いている間に、すぐ出す画面。
 *
 * ツールのページは、利用できるプランをサーバーで確かめてから表示するため、
 * カードを押してから中身が届くまで少し待つことがある。その間、何も変わらないと
 * 「押せていないのでは？」と感じるので、移動した直後にこの画面を出す。
 * 見出し（h1）は置かない（本物のページの見出しが1つだけになるように）。
 */
export default function ToolsLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6" data-testid="tools-loading">
      <div role="status" aria-live="polite" className="ms-status mb-6 text-ms-muted">
        <Spinner className="text-ms-accent dark:text-ms-focus" />
        <span>ツールを読み込んでいます...</span>
      </div>
      <div aria-hidden="true" className="mb-6 flex items-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-ms-hover-tint" />
        <div className="h-7 w-56 max-w-full animate-pulse rounded-lg bg-ms-hover-tint" />
      </div>
      <div aria-hidden="true" className="ms-tool-panel space-y-3 p-4 sm:p-6">
        <div className="h-4 w-3/4 animate-pulse rounded bg-ms-hover-tint" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-ms-hover-tint" />
        <div className="h-40 animate-pulse rounded-xl bg-ms-hover-tint" />
      </div>
    </div>
  );
}
