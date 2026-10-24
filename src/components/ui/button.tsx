import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 共通ボタン（UI刷新・第1工程）。見た目の定義は src/app/globals.css の .ms-btn 系クラスにある。
 *
 * - primary: 青。ページ内でいちばん大事な操作（変換する・実行する 等）に使う。
 * - secondary: 白・ニュートラル。コピー・キャンセルなど、補助的な操作に使う。
 * - loading: 処理中。クリックできなくなり、前にスピナーが出る（文字はそのまま残る）。
 *
 * 普通の <button> と同じ属性（onClick・disabled・aria-* など）をそのまま渡せる。
 * 既定の type は "button"（フォーム送信にしたい時だけ type="submit" を渡す）。
 * リンク（ページ移動）には使わない。リンクは <Link> のまま、見た目だけ buttonClasses() で揃える。
 */
export type ButtonVariant = "primary" | "secondary";
export type ButtonSize = "md" | "sm";

export function buttonClasses({
  variant = "primary",
  size = "md",
}: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  return cn("ms-btn", variant === "primary" ? "ms-btn-primary" : "ms-btn-secondary", size === "sm" && "ms-btn-sm");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 処理中。true の間は押せない（二重送信を防ぐ）。 */
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonClasses({ variant, size }), className)}
      {...rest}
    >
      {children}
    </button>
  );
}
