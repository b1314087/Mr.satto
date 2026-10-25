import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { featureFlags } from "@/lib/config/features";

export const metadata: Metadata = {
  title: "ログイン",
  description: "Mr.Sattoにログインします。",
  alternates: { canonical: "/login" },
  // 課金システムがオフの間は、リンクを出さず検索にも出さない（管理画面などへのログインのため、ページ自体は残す）
  ...(featureFlags.billing ? {} : { robots: { index: false, follow: false } }),
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 sm:px-6">
      <h1 className="mb-6 text-center text-2xl font-bold text-ms-text">
        ログイン
      </h1>

      <div className="ms-glass p-6">
        {isSupabaseConfigured() ? (
          <LoginForm nextPath={next} />
        ) : (
          <p className="text-center text-sm text-ms-muted">
            現在、ログイン機能は準備中です。無料でご利用いただけるツールは
            <Link href="/tools" className="text-ms-accent hover:underline dark:text-ms-focus">
              ツール一覧
            </Link>
            からログインなしでお使いいただけます。
          </p>
        )}
      </div>
    </div>
  );
}
