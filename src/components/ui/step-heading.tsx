import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 番号付きの見出し（UI・UX改善）。操作の順番があるツール（アップロード → 設定 → 書き出し など）だけに使う。
 * 番号は丸い青のバッジで出し、読み上げでは「1. 見出し」のように読まれる。
 */
export function StepHeading({
  n,
  as: Tag = "h2",
  className,
  id,
  children,
}: {
  n: number;
  id?: string;
  as?: "h2" | "h3" | "p";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag id={id} className={cn("ms-step-heading", className)}>
      <span className="ms-step-no" aria-hidden="true">
        {n}
      </span>
      <span className="sr-only">{n}. </span>
      <span className="min-w-0">{children}</span>
    </Tag>
  );
}
