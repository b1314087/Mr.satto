import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 設定のグループ（折りたたみ式。総合改修 3-1）。
 *
 * 全ツール共通の見た目・操作：
 * - 見出しは周りの説明文より大きく、右側に下向きのシェブロン（開いているときは上向き）。
 * - 見出しを押すと、そのグループだけが開閉する（ほかのグループには影響しない）。
 * - 必要なら番号（n）を付けて、設定の順番を分かりやすくする。
 * - summary に今の値を短く書くと、閉じたままでも何が選ばれているか分かる。
 * - 閉じても中身は画面に残る（入力した値は消えず、実行するときもそのまま使われる）。
 *
 * 見た目は src/app/globals.css の .ms-section（glassmorphism のカードに合わせる）。
 */
export function SettingsSection({
  title,
  n,
  summary,
  defaultOpen = true,
  testId,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  /** 設定の順番（番号のバッジ）。順番の無いグループでは省く */
  n?: number;
  /** 閉じたときに見出しの右に出す、今の値の要約 */
  summary?: ReactNode;
  defaultOpen?: boolean;
  testId?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("ms-section", className)} open={defaultOpen || undefined} data-testid={testId}>
      <summary className="ms-section-summary">
        {n !== undefined && (
          <span className="ms-step-no" aria-hidden="true">
            {n}
          </span>
        )}
        <span className="ms-section-title">
          {n !== undefined && <span className="sr-only">{n}. </span>}
          {title}
        </span>
        {summary !== undefined && summary !== null && summary !== "" && <span className="ms-section-hint">{summary}</span>}
        <span className="ms-section-chevron" aria-hidden="true" />
      </summary>
      <div className={cn("ms-section-body", bodyClassName)}>{children}</div>
    </details>
  );
}

/** 設定グループを縦に並べる入れ物（グループ同士の間隔をそろえる） */
export function SettingsStack({ className, children, testId }: { className?: string; children: ReactNode; testId?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)} data-testid={testId}>
      {children}
    </div>
  );
}
