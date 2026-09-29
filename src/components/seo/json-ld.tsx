/**
 * JSON-LD（構造化データ）をそのままscriptタグとして埋め込むための共通コンポーネント。
 * サーバーコンポーネントから呼び出せるよう "use client" は付けない。
 *
 * Phase 23監査で追加: JSON.stringify()は"<"をエスケープしないため、埋め込む値に
 * 万一 "</script>" という文字列が含まれていると、scriptタグが意図せず
 * 早期に閉じられ、続く内容が生のHTMLとして解釈されてしまう（Next.js公式の
 * JSON-LD実装例でも推奨されている対策）。現状このコンポーネントへ渡す値は
 * すべてサイト自身の静的なSEOコンテンツ（パンくず・FAQ・ツール名等）であり
 * ユーザー入力やアップロードされたファイルの内容が混ざることはないが、
 * 将来の変更でその前提が崩れても安全なように、コストの無い予防策として
 * "<" を "\u003c" へエスケープしておく。
 */
export function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
