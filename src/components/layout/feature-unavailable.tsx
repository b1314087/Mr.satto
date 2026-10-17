import Link from "next/link";

/**
 * 機能スイッチ（src/lib/config/features.ts）でオフにしている機能のページに表示する、
 * 「現在準備中」の案内。ページ自体は残し、検索エンジンには出さない（各ページ側で noindex を設定する）。
 */
export function FeatureUnavailable({ title }: { title: string }) {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
      <h1 className="mb-3 text-2xl font-bold text-neutral-900 dark:text-white">{title}</h1>
      <p
        data-testid="feature-unavailable"
        className="mb-6 text-sm text-neutral-600 dark:text-neutral-300"
      >
        現在、この機能は準備中です。ツールは、会員登録なしで、そのままご利用いただけます。
      </p>
      <Link
        href="/tools"
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        ツール一覧へ
      </Link>
    </div>
  );
}
