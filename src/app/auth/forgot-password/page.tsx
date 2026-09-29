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
      <h1 className="mb-6 text-center text-2xl font-bold text-neutral-900 dark:text-white">
        パスワードを再設定
      </h1>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        {isSupabaseConfigured() ? (
          <ForgotPasswordForm />
        ) : (
          <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
            現在、ログイン機能は準備中です。
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <Link href="/login" className="text-blue-600 hover:underline dark:text-blue-400">
          ログイン画面に戻る
        </Link>
      </p>
    </div>
  );
}
