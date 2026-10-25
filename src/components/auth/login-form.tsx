"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { ErrorMessage } from "@/components/common/error-message";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";

const INPUT_CLASS =
  "ms-input";

/**
 * ログイン後のリダイレクト先（?next=）が、外部サイトへ誘導する
 * Open Redirectに使われないことを確認する（Phase 6.5 セキュリティ監査で追加）。
 *
 * "/" で始まっていれば安全、という単純な判定だけでは
 * "//evil.example"（プロトコル相対URL）や "/\evil.example"（一部ブラウザが
 * バックスラッシュをスラッシュとして解釈することを悪用するパターン）を
 * ブラウザ側で外部オリジンへの遷移として扱ってしまう可能性があるため、
 * それらも明示的に拒否する。相対パス内であれば従来通り許可する。
 */
function isSafeInternalPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.startsWith("/\\")) return false;
  return true;
}

function translateAuthError(message: string): string {
  if (message.includes("Invalid login credentials")) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }
  if (message.includes("Email not confirmed")) {
    return "メールアドレスの確認がまだ完了していません。届いたメール内のリンクを確認してください。";
  }
  return "ログインに失敗しました。しばらくしてから再度お試しください。";
}

export function LoginForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "processing") return;

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("現在、ログイン機能は準備中です。");
      setStatus("error");
      return;
    }

    setStatus("processing");
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(translateAuthError(signInError.message));
      setStatus("error");
      return;
    }

    setStatus("success");
    router.push(nextPath && isSafeInternalPath(nextPath) ? nextPath : "/account");
    router.refresh();
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
        パスワード
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={INPUT_CLASS}
        />
      </label>

      <div className="text-right text-xs">
        <Link href="/auth/forgot-password" className="text-ms-accent hover:underline dark:text-ms-focus">
          パスワードをお忘れの場合
        </Link>
      </div>

      <button
        type="submit"
        disabled={status === "processing"}
        className="w-full ms-btn ms-btn-primary"
      >
        {status === "processing" ? "ログイン中..." : "ログイン"}
      </button>

      <ProcessingStatus state={status} processingLabel="ログイン中..." successLabel="ログインしました" />
      {error && <ErrorMessage message={error} />}

      <p className="text-center text-xs text-ms-muted">
        アカウントをお持ちでないですか？{" "}
        <Link href="/signup" className="text-ms-accent hover:underline dark:text-ms-focus">
          会員登録
        </Link>
      </p>
    </form>
  );
}
