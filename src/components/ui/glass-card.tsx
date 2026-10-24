import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * ガラスカード（UI刷新・第1工程）。見た目の定義は src/app/globals.css の .ms-glass 系クラスにある。
 *
 * - 既定: 半透明＋背景ぼかし＋細い境界線。ぼかしが使えない環境や、「透明度を下げる」設定では
 *   ほぼ不透明の面になるので、文字は常に読める。
 * - strong: 入力欄・ダイアログ・エラー表示・広告ゲートなど、操作上重要な面。透かさない。
 *
 * ページ移動するカード（リンク）は <Link> に glassCardClasses({ interactive: true }) を付ける
 * （「リンクを div に変える」ことはしない）。
 */
export interface GlassCardOptions {
  /** 操作上重要な面にする（透かさない） */
  strong?: boolean;
  /** クリックできるカード（ホバーで少し浮く・キーボードのフォーカス枠）。リンクなどに付ける */
  interactive?: boolean;
}

export function glassCardClasses({ strong = false, interactive = false }: GlassCardOptions = {}): string {
  return cn(strong ? "ms-glass-strong" : "ms-glass", interactive && "ms-glass-interactive");
}

export interface GlassCardProps extends HTMLAttributes<HTMLDivElement>, Pick<GlassCardOptions, "strong"> {}

export function GlassCard({ strong = false, className, children, ...rest }: GlassCardProps) {
  return (
    <div className={cn(glassCardClasses({ strong }), className)} {...rest}>
      {children}
    </div>
  );
}
