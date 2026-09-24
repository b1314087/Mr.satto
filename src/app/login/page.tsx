import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "ログイン",
  description: "Mr.Sattoにログインします。",
  alternates: { canonical: "/login" },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 sm:px-6">
      <h1 className="mb-6 text-center text-2xl font-bold text-neutral-900 dark:text-white">
        ログイン
      </h1>

      <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        {isSupabaseConfigured() ? (
          <LoginForm nextPath={next} />
        ) : (
          <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
            現在、ログイン機能は準備中です。無料でご利用いただけるツールは
            <Link href="/tools" className="text-blue-600 hover:underline dark:text-blue-400">
              ツール一覧
            </Link>
            からログインなしでお使いいただけます。
          </p>
        )}
      </div>
    </div>
  );
}
