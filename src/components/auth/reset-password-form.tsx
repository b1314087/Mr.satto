"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";

const INPUT_CLASS =
  "rounded-xl border border-neutral-300 px-4 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900";

const MIN_PASSWORD_LENGTH = 8;

function translateAuthError(message: string): string {
  if (message.includes("Password") && message.includes("least")) {
    return `パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`;
  }
  if (message.includes("session") || message.includes("Session")) {
    return "セッションの有効期限が切れました。お手数ですが、パスワード再設定をもう一度お試しください。";
  }
  return "パスワードの更新に失敗しました。しばらくしてから再度お試しください。";
}

/**
 * /auth/reset-password のフォーム本体。
 * このフォームが表示されている時点で、ページ側（サーバーコンポーネント）が
 * 既に有効なセッション（/auth/reset-callback経由）の存在を確認済みのため、
 * ここでは新しいパスワードの入力・確認一致チェック・更新のみを行う。
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "processing") return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`);
      setStatus("error");
      return;
    }
    if (password !== confirmPassword) {
      setError("新しいパスワードと確認用パスワードが一致しません。");
      setStatus("error");
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("現在、パスワード再設定機能は準備中です。");
      setStatus("error");
      return;
    }

    setStatus("processing");
    setError(null);

    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(translateAuthError(updateError.message));
      setStatus("error");
      return;
    }

    setStatus("success");
    // 更新に使ったセッションは既に有効なセッションのため、ログイン画面を
    // 挟まずそのままアカウント画面へ（会員登録のメール確認完了時と同じ方針）。
    router.push("/account");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        新しいパスワード（{MIN_PASSWORD_LENGTH}文字以上）
        <input
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        新しいパスワード（確認）
        <input
          type="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>

      <button
        type="submit"
        disabled={status === "processing"}
        className="w-full rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        {status === "processing" ? "更新中..." : "パスワードを更新"}
      </button>

      <ProcessingStatus state={status} processingLabel="更新中..." successLabel="パスワードを更新しました" />
      {error && <ErrorMessage message={error} />}
    </form>
  );
}
