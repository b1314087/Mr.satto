import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-24 text-center">
      <span className="text-5xl" aria-hidden="true">
        🔍
      </span>
      <h1 className="text-xl font-bold text-neutral-900 dark:text-white">
        ページが見つかりませんでした
      </h1>
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        お探しのツールまたはページは存在しないか、移動した可能性があります。
      </p>
      <Link
        href="/tools"
        className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
      >
        ツール一覧へ戻る
      </Link>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-blue-600 dark:text-blue-400">
        <Link href="/" className="hover:underline">
          トップページ
        </Link>
        <Link href="/pricing" className="hover:underline">
          料金プラン
        </Link>
        <Link href="/contact" className="hover:underline">
          お問い合わせ
        </Link>
      </div>
    </div>
  );
}
