"use client";

import { useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { siteConfig } from "@/lib/config/site";

const INPUT_CLASS =
  "ms-input";

/**
 * 送信結果に関わらず表示する汎用メッセージ。
 *
 * 「そのメールアドレスは登録されていません」のような、アカウントの存在有無を
 * 外部から判別できる文言は表示しない（メールアドレス列挙攻撃の防止）。
 * Supabaseのresetpasswordforemail自体も、存在しないメールアドレスに対して
 * エラーを返さない設計になっており、この汎用表示と矛盾しない。
 */
const GENERIC_SENT_MESSAGE =
  "入力されたメールアドレス宛に、パスワード再設定用のメールを送信しました（該当するアカウントが存在する場合）。メールが届かない場合は、迷惑メールフォルダもご確認ください。";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "processing") return;

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setStatus("error");
      return;
    }

    setStatus("processing");

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteConfig.url}/auth/reset-callback`,
    });

    if (error) {
      // レート制限等、稀に発生する一時的なエラー。この場合もアカウントの
      // 有無が判別できる文言は出さず、汎用的な失敗メッセージにとどめる。
      setStatus("error");
      return;
    }

    setStatus("success");
    setSent(true);
  }

  if (sent) {
    return (
      <div className="ms-glass flex flex-col items-center gap-3 p-6 text-center text-sm text-ms-muted">
        <p>{GENERIC_SENT_MESSAGE}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        メールアドレス
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>

      <button
        type="submit"
        disabled={status === "processing"}
        className="w-full ms-btn ms-btn-primary"
      >
        {status === "processing" ? "送信中..." : "再設定メールを送信"}
      </button>

      <ProcessingStatus state={status} processingLabel="送信中..." successLabel="送信しました" />
      {status === "error" && (
        <ErrorMessage message="送信に失敗しました。しばらくしてから再度お試しください。" />
      )}
    </form>
  );
}
