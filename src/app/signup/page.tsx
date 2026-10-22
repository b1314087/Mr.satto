import type { Metadata } from "next";
import Link from "next/link";
import { SignupForm } from "@/components/auth/signup-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { featureFlags } from "@/lib/config/features";
import { FeatureUnavailable } from "@/components/layout/feature-unavailable";

export const metadata: Metadata = {
  title: "会員登録",
  description: "Mr.Sattoに会員登録します。プレミアムプランのご利用にはログインが必要です。",
  alternates: { canonical: "/signup" },
  ...(featureFlags.billing ? {} : { robots: { index: false, follow: false } }),
};

export default function SignupPage() {
  // 課金システムがオフの間は、新規の会員登録を受け付けない（src/lib/config/features.ts）
  if (!featureFlags.billing) return <FeatureUnavailable title="会員登録" />;

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
        会員登録が必要なのはプレミアムプランのご利用時のみです。
        <br />
        無料プランはログインなしでお使いいただけます。
      </p>
    </div>
  );
}
