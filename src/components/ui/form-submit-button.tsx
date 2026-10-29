"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * フォームの送信ボタン。押して、サーバーの処理が終わるまでの間、
 * ボタンの周りを光が一周し（処理中の共通の見た目: aria-busy）、押せなくなる（二重送信を防ぐ）。
 *
 * <form action={サーバーの処理}> の中に置いて使う。普通の <button type="submit"> の代わり。
 * `pendingLabel` を渡すと、処理中だけ文字を差し替える（例: 「保存中...」）。
 */
export function FormSubmitButton({
  children,
  pendingLabel,
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { children: ReactNode; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
