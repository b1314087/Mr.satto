"use client";

import Link from "next/link";

/**
 * 予期しない実行時エラーが起きたときの画面（ルートの error 境界）。
 *
 * - ヘッダーとフッター（ルートのレイアウト）はそのまま表示され、ページの本文だけがこの画面に置き換わる。
 * - 利用者には、技術的な内容（エラー文・スタック・環境の情報）を見せない。Next.js は本番では、
 *   サーバー側のエラーの内容を伏せて「エラー番号（digest）」だけを渡す。その番号だけを小さく添える
 *   （運営側が、サーバーのログと突き合わせるため。個人情報やファイルの内容は含まれない）。
 * - エラーの内容を、外部へ送ったり、コンソールへ出したりはしない（ファイル名などが含まれる可能性があるため）。
 * - 「もう一度試す」は retry()。このバージョンの Next.js（16）が、再取得も含めて再表示する標準の手段。
 * - 境界で受け止められるのは、画面の表示中・読み込み時のエラー。クリックなどの操作の中で起きたエラーは、
 *   各ツールが自分で受け止めて画面に出している（ここには来ない）。
 */
export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  const rawDigest = typeof error === "object" && error !== null ? (error as { digest?: unknown }).digest : undefined;
  const digest = typeof rawDigest === "string" ? rawDigest : null;

  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-24 text-center">
      <span className="text-5xl" aria-hidden="true">
        ⚠️
      </span>
      <h1 className="text-xl font-bold text-ms-text">問題が発生しました</h1>
      <p className="text-sm text-ms-muted">
        表示中に予期しないエラーが起きました。もう一度お試しください。
      </p>
      <p className="text-sm text-ms-muted">
        解決しないときは、ページを再読み込みするか、ツール一覧から開き直してください。入力中の内容は失われている場合があります。
      </p>
      <button type="button" onClick={() => retry()} className="ms-btn ms-btn-primary">
        もう一度試す
      </button>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-ms-accent dark:text-ms-focus">
        <Link href="/tools" className="hover:underline">
          ツール一覧へ戻る
        </Link>
        <Link href="/" className="hover:underline">
          トップページ
        </Link>
      </div>
      {digest && <p className="text-xs text-ms-muted">エラー番号: {digest}</p>}
    </div>
  );
}
