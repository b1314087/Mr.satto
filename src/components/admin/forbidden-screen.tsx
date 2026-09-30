import Link from "next/link";

/**
 * ログイン済みだが管理者ではない場合の表示。
 * 管理データは一切取得・返却しない（src/app/admin/layout.tsx がこのコンポーネントを
 * 返す時点で、配下のページのデータ取得コードは実行されない）。
 */
export function ForbiddenScreen() {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
      <h1 className="mb-3 text-2xl font-bold text-neutral-900 dark:text-white">403</h1>
      <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-300">
        このページを表示する権限がありません。
      </p>
      <Link
        href="/"
        className="inline-block rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        トップページへ戻る
      </Link>
    </div>
  );
}
