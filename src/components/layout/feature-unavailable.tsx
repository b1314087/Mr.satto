import Link from "next/link";

/**
 * 機能スイッチ（src/lib/config/features.ts）でオフにしている機能のページに表示する、
 * 「現在準備中」の案内。ページ自体は残し、検索エンジンには出さない（各ページ側で noindex を設定する）。
 */
export function FeatureUnavailable({ title }: { title: string }) {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
      <h1 className="mb-3 text-2xl font-bold text-ms-text">{title}</h1>
      <p
        data-testid="feature-unavailable"
        className="mb-6 text-sm text-ms-muted"
      >
        現在、この機能は準備中です。ツールは、会員登録なしで、そのままご利用いただけます。
      </p>
      <Link
        href="/tools"
        className="ms-btn ms-btn-primary"
      >
        ツール一覧へ
      </Link>
    </div>
  );
}
