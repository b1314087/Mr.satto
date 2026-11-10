import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 有料機能の印（UI・UX改善）。「プレミアム」「AI」などの表示を、サイト全体で同じ見た目にそろえる。
 * 料金・利用条件・課金の判定には関係しない（表示だけ）。
 *
 * - PremiumTag：見出しや選択肢の横に付ける小さな印。
 * - PremiumHint：「複数ファイルの一括処理は プレミアム」のような1行の案内（料金ページへのリンク付き）。
 */
export function PremiumTag({ kind = "premium", className }: { kind?: "premium" | "ai"; className?: string }) {
  return <span className={cn("ms-premium-tag", kind === "ai" && "ms-premium-tag-ai", className)}>{kind === "ai" ? "AI・プレミアム" : "プレミアム"}</span>;
}

export function PremiumHint({
  children,
  href = "/pricing",
  linkLabel = "プレミアムプラン",
  testId,
  className,
}: {
  children: ReactNode;
  href?: string | null;
  linkLabel?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <p className={cn("ms-premium-hint", className)} data-testid={testId}>
      <span>{children}</span>
      {href && (
        <Link href={href} className="ms-premium-tag hover:underline">
          {linkLabel}
        </Link>
      )}
    </p>
  );
}
