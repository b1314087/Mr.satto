"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { siteConfig } from "@/lib/config/site";
import { getSignupConsentError } from "@/lib/auth/signup-consent";

const INPUT_CLASS =
  "ms-input";

const MIN_PASSWORD_LENGTH = 8;

function translateAuthError(message: string): string {
  if (message.includes("already registered") || message.includes("already exists")) {
    return "このメールアドレスは既に登録されています。ログインをお試しください。";
  }
  if (message.includes("Password") && message.includes("least")) {
    return `パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`;
  }
  return "会員登録に失敗しました。しばらくしてから再度お試しください。";
}

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "processing") return;

    // 利用規約・プライバシーポリシーに同意していない場合は、登録を進めない。
    const consentError = getSignupConsentError(termsAccepted);
    if (consentError) {
      setError(consentError);
      setStatus("error");
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`パスワードは${MIN_PASSWORD_LENGTH}文字以上で入力してください。`);
      setStatus("error");
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("現在、会員登録機能は準備中です。");
      setStatus("error");
      return;
    }

    setStatus("processing");
    setError(null);

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${siteConfig.url}/auth/callback` },
    });

    if (signUpError) {
      setError(translateAuthError(signUpError.message));
      setStatus("error");
      return;
    }

    setStatus("success");

    if (data.session) {
      // プロジェクト設定でメール確認が不要な場合は、この時点で既にログイン済み。
      router.push("/account");
      router.refresh();
    } else {
      // メール確認が必要な場合、セッションはまだ発行されない。
      setNeedsEmailConfirmation(true);
    }
  }

  if (needsEmailConfirmation) {
    return (
      <div className="ms-glass flex flex-col items-center gap-3 p-6 text-center text-sm text-ms-muted">
        <p>確認メールを送信しました。メール内のリンクを開いて登録を完了してください。</p>
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
      <label className="flex flex-col gap-1.5 text-sm">
        パスワード（{MIN_PASSWORD_LENGTH}文字以上）
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

      <label className="flex items-start gap-2 text-xs leading-relaxed text-ms-muted">
        <input
          type="checkbox"
          required
          checked={termsAccepted}
          onChange={(e) => setTermsAccepted(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded accent-[var(--ms-accent)]"
        />
        <span>
          <Link
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ms-accent hover:underline dark:text-ms-focus"
          >
            利用規約
          </Link>
          と
          <Link
            href="/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ms-accent hover:underline dark:text-ms-focus"
          >
            プライバシーポリシー
          </Link>
          （どちらも新しいタブで開きます）を確認し、同意します。
        </span>
      </label>

      <button
        type="submit"
        disabled={status === "processing" || !termsAccepted}
        className="w-full ms-btn ms-btn-primary"
      >
        {status === "processing" ? "登録中..." : "会員登録"}
      </button>

      <ProcessingStatus state={status} processingLabel="登録中..." successLabel="登録が完了しました" />
      {error && <ErrorMessage message={error} />}

      <p className="text-center text-xs text-ms-muted">
        既にアカウントをお持ちですか？{" "}
        <Link href="/login" className="text-ms-accent hover:underline dark:text-ms-focus">
          ログイン
        </Link>
      </p>
    </form>
  );
}
