import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 詳細設定（UI・UX改善）。めったに変えない設定・補助的な設定を、ふだんは閉じておく折りたたみ。
 *
 * - 閉じていても中身は画面に残る（入力した値は消えず、実行するときもそのまま使われる）。
 * - summary に今の値を短く書くと、閉じたままでも何が選ばれているかが分かる（例：「MP4・元の解像度」）。
 * - よく使う設定には使わない（最初から見えている方が早い）。
 * 見た目は src/app/globals.css の .ms-adv。
 */
export function AdvancedSettings({
  title = "詳細設定",
  summary,
  defaultOpen = false,
  testId,
  className,
  children,
}: {
  title?: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("ms-adv", className)} open={defaultOpen || undefined} data-testid={testId}>
      <summary>
        <span className="ms-adv-title">{title}</span>
        {summary && <span className="ms-adv-summary">{summary}</span>}
      </summary>
      <div className="ms-adv-body">{children}</div>
    </details>
  );
}
