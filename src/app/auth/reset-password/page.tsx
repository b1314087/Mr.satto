import type { Metadata } from "next";
import Link from "next/link";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

// パスワード再設定という個人の操作画面のため検索エンジンには公開しない（account/page.tsxと同方針）。
export const metadata: Metadata = {
  title: "新しいパスワードを設定",
  description: "新しいパスワードを設定します。",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage() {
  const supabase = await getSupabaseServerClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  // /auth/reset-callback を経由した有効なセッションが無い場合
  // （リンク無効・期限切れ・使用済み・直接アクセス等）はフォームを出さない。
  if (!data.user) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
        <h1 className="mb-3 text-2xl font-bold text-ms-text">
          新しいパスワードを設定
        </h1>
        <p className="mb-6 text-sm text-ms-muted">
          このリンクは無効か、有効期限が切れています。お手数ですが、パスワード再設定をもう一度お試しください。
        </p>
        <Link
          href="/auth/forgot-password"
          className="inline-block ms-btn ms-btn-primary"
        >
          パスワード再設定をやり直す
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 sm:px-6">
      <h1 className="mb-6 text-center text-2xl font-bold text-ms-text">
        新しいパスワードを設定
      </h1>
      <div className="ms-glass p-6">
        <ResetPasswordForm />
      </div>
    </div>
  );
}
