import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "パスワードを再設定",
  description: "登録したメールアドレス宛にパスワード再設定用のリンクを送信します。",
  alternates: { canonical: "/auth/forgot-password" },
};

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 sm:px-6">
      <h1 className="mb-6 text-center text-2xl font-bold text-ms-text">
        パスワードを再設定
      </h1>

      <div className="ms-glass p-6">
        {isSupabaseConfigured() ? (
          <ForgotPasswordForm />
        ) : (
          <p className="text-center text-sm text-ms-muted">
            現在、ログイン機能は準備中です。
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-sm text-ms-muted">
        <Link href="/login" className="text-ms-accent hover:underline dark:text-ms-focus">
          ログイン画面に戻る
        </Link>
      </p>
    </div>
  );
}
