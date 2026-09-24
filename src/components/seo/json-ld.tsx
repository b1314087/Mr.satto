/**
 * JSON-LD（構造化データ）をそのままscriptタグとして埋め込むための共通コンポーネント。
 * サーバーコンポーネントから呼び出せるよう "use client" は付けない。
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
