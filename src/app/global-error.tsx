"use client";

/**
 * ルートのレイアウト（ヘッダー・フッター・テーマなど）そのものでエラーが起きたときの、最後の受け皿。
 *
 * このファイルが使われるときは、ルートのレイアウトが使えない。そのため自分で <html> と <body> を持ち、
 * サイトのスタイル（globals.css）にも頼らず、この中だけで完結する（サイト内リンクの仕組みも使わず、普通のリンクにする）。
 * 通常のページ内のエラーは、ここではなく error.tsx が受け止める。
 * 利用者には技術的な内容を見せず、エラーの内容を外部へ送ったり、コンソールへ出したりもしない。
 */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="ja">
      <head>
        <title>問題が発生しました</title>
        <style>{`
          :root { color-scheme: light dark; }
          body { margin: 0; font-family: system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; background: #eaf2fc; color: #0f1f38; }
          .ms-ge { max-width: 32rem; margin: 0 auto; padding: 6rem 1rem; text-align: center; }
          .ms-ge h1 { font-size: 1.25rem; font-weight: 700; margin: 1rem 0 0.75rem; }
          .ms-ge p { font-size: 0.875rem; line-height: 1.7; margin: 0.5rem 0; }
          .ms-ge button { margin-top: 1rem; padding: 0.625rem 1.25rem; border: 0; border-radius: 0.75rem; background: #1d4ed8; color: #fff; font-size: 0.875rem; font-weight: 600; cursor: pointer; }
          .ms-ge a { display: inline-block; margin-top: 1rem; color: #1d4ed8; font-size: 0.875rem; }
          @media (prefers-color-scheme: dark) {
            body { background: #060c1a; color: #e8eefb; }
            .ms-ge button { background: #3b82f6; }
            .ms-ge a { color: #93c5fd; }
          }
        `}</style>
      </head>
      <body>
        <div role="alert" className="ms-ge">
          <h1>問題が発生しました</h1>
          <p>ページを表示できませんでした。もう一度お試しください。</p>
          <p>解決しないときは、ページを再読み込みしてください。入力中の内容は失われている場合があります。</p>
          <button type="button" onClick={() => retry()}>
            もう一度試す
          </button>
          <div>
            {/* ルートのレイアウトが壊れている場面なので、サイト内リンクの仕組み（next/link）には頼らず、普通のリンクで移動する */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/">トップページへ戻る</a>
          </div>
        </div>
      </body>
    </html>
  );
}
