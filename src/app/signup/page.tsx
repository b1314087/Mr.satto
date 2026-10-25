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
      <h1 className="mb-6 text-center text-2xl font-bold text-ms-text">
        会員登録
      </h1>

      <div className="ms-glass p-6">
        {isSupabaseConfigured() ? (
          <SignupForm />
        ) : (
          <p className="text-center text-sm text-ms-muted">
            現在、会員登録機能は準備中です。無料でご利用いただけるツールは
            <Link href="/tools" className="text-ms-accent hover:underline dark:text-ms-focus">
              ツール一覧
            </Link>
            からログインなしでお使いいただけます。
          </p>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-ms-muted">
        会員登録が必要なのはプレミアムプランのご利用時のみです。
        <br />
        無料プランはログインなしでお使いいただけます。
      </p>
    </div>
  );
}
