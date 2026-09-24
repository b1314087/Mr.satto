import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "@/components/auth/signup-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "会員登録",
  description: "Mr.Sattoに会員登録します。Standard・Premiumプランのご利用にはログインが必要です。",
  alternates: { canonical: "/signup" },
};

export default function SignupPage() {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 sm:px-6">
      <h1 className="mb-6 text-center text-2xl font-bold text-neutral-900 dark:text-white">
        会員登録
      </h1>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        {isSupabaseConfigured() ? (
          <SignupForm />
        ) : (
          <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
            現在、会員登録機能は準備中です。無料でご利用いただけるツールは
            <Link href="/tools" className="text-blue-600 hover:underline dark:text-blue-400">
              ツール一覧
            </Link>
            からログインなしでお使いいただけます。
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-neutral-400 dark:text-neutral-500">
        会員登録が必要なのはStandard・Premiumプランのご利用時のみです。
        <br />
        無料プランはログインなしでお使いいただけます。
      </p>
    </div>
  );
}
