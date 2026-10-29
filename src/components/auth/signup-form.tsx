"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { ErrorMessage } from "@/components/common/error-message";
import { signUpAction, type SignupActionState } from "@/lib/auth/signup-action";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/signup-flow";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_RULE_HINT } from "@/lib/auth/username";

const INPUT_CLASS =
  "ms-input";

const INITIAL_STATE: SignupActionState = { status: "idle" };

/**
 * 会員登録フォーム。送信はサーバー（Server Action）で処理し、利用規約・プライバシーポリシーへの同意の確認と記録も
 * サーバー側で行う（工程38。src/lib/auth/signup-action.ts）。ここでの「同意しないと押せない」は、操作を分かりやすくするためで、
 * 強制はサーバー側で行う。
 */
export function SignupForm() {
  const [state, formAction, pending] = useActionState(signUpAction, INITIAL_STATE);
  const [termsAccepted, setTermsAccepted] = useState(false);

  if (state.status === "confirm-email") {
    return (
      <div className="ms-glass flex flex-col items-center gap-3 p-6 text-center text-sm text-ms-muted">
        <p>確認メールを送信しました。メール内のリンクを開いて登録を完了してください。</p>
      </div>
    );
  }

  return (
    <form action={formAction} onReset={() => setTermsAccepted(false)} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        メールアドレス
        <input
          type="email"
          name="email"
          defaultValue={state.email ?? ""}
          required
          autoComplete="email"
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        ユーザー名
        <input
          type="text"
          name="username"
          data-testid="signup-username"
          defaultValue={state.username ?? ""}
          required
          minLength={USERNAME_MIN_LENGTH}
          maxLength={USERNAME_MAX_LENGTH}
          autoComplete="username"
          className={INPUT_CLASS}
        />
        <span className="text-xs text-ms-muted">{USERNAME_RULE_HINT}</span>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        パスワード（{MIN_PASSWORD_LENGTH}文字以上）
        <input
          type="password"
          name="password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          className={INPUT_CLASS}
        />
      </label>

      <label className="flex items-start gap-2 text-xs leading-relaxed text-ms-muted">
        <input
          type="checkbox"
          name="consent"
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
        disabled={pending || !termsAccepted}
        aria-busy={pending || undefined}
        className="w-full ms-btn ms-btn-primary"
      >
        {pending ? "登録中..." : "会員登録"}
      </button>

      {state.status === "error" && state.message && <ErrorMessage message={state.message} />}

      <p className="text-center text-xs text-ms-muted">
        既にアカウントをお持ちですか？{" "}
        <Link href="/login" className="text-ms-accent hover:underline dark:text-ms-focus">
          ログイン
        </Link>
      </p>
    </form>
  );
}
