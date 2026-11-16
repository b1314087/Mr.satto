"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { afterPasswordChangedAction } from "@/lib/auth/actions";
import { AUTH_LINK_MESSAGES, PASSWORD_MESSAGES, classifyAuthLinkError } from "@/lib/auth/auth-link";

const INPUT_CLASS =
  "ms-input";

const MIN_PASSWORD_LENGTH = 8;

function translateAuthError(error: { code?: string | null; name?: string | null; status?: number | null }): string {
  if (error.code === "weak_password") return PASSWORD_MESSAGES.tooShort;
  if (error.code === "same_password") return PASSWORD_MESSAGES.samePassword;
  const problem = classifyAuthLinkError(error);
  if (problem === "network") return AUTH_LINK_MESSAGES.network;
  if (error.name === "AuthSessionMissingError" || problem === "expired" || problem === "used") return AUTH_LINK_MESSAGES.session;
  return PASSWORD_MESSAGES.updateFailed;
}

/**
 * /auth/reset-password のフォーム本体。
 * このフォームが表示されている時点で、ページ側（サーバーコンポーネント）が
 * 既に有効なセッション（/auth/reset-callback経由）の存在を確認済みのため、
 * ここでは新しいパスワードの入力・確認一致チェック・更新のみを行う。
 */
export function ResetPasswordForm({ email }: { email?: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "processing") return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_MESSAGES.tooShort);
      setStatus("error");
      return;
    }
    if (password !== confirmPassword) {
      setError(PASSWORD_MESSAGES.mismatch);
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
      setError(translateAuthError(updateError));
      setStatus("error");
      return;
    }

    // 他の端末のログインと、有料プランの利用ロック・本人確認を終わらせる（失敗しても、パスワードの変更は終わっている）
    await afterPasswordChangedAction().catch(() => undefined);

    setStatus("success");
    // 更新に使ったセッションは既に有効なセッションのため、ログイン画面を
    // 挟まずそのままアカウント画面へ（会員登録のメール確認完了時と同じ方針）。
    router.push("/account");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {email && (
        // どのアカウントのパスワードを変えるのかを示す（他人から送られたリンクで、別のアカウントを操作していないか気づけるように）
        <p className="text-sm text-ms-muted" data-testid="reset-password-account">
          <span className="font-medium text-ms-text">{email}</span> のパスワードを設定します。
        </p>
      )}
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
        disabled={status === "processing"} aria-busy={status === "processing" || undefined}
        className="w-full ms-btn ms-btn-primary"
      >
        {status === "processing" ? "更新中..." : "パスワードを更新"}
      </button>

      <ProcessingStatus state={status} processingLabel="更新中..." successLabel="パスワードを更新しました" />
      {error && <ErrorMessage message={error} />}
    </form>
  );
}
