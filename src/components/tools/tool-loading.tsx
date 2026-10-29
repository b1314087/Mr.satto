import { Spinner } from "@/components/ui/spinner";

/**
 * ツール本体の部品（画面の中身）をダウンロードしている間に出す表示（next/dynamic の loading に使う）。
 * 軽いツールでは一瞬で入れ替わる。回線が遅いときだけ、しばらく見える。
 */
export function ToolLoading() {
  return (
    <div role="status" aria-live="polite" data-testid="tool-loading" className="ms-status py-6 text-ms-muted">
      <Spinner className="text-ms-accent dark:text-ms-focus" />
      <span>ツールを読み込んでいます...</span>
    </div>
  );
}
