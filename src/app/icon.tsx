import { ImageResponse } from "next/og";

/**
 * ブラウザタブ用アイコン（Phase 12）。
 *
 * 専用のロゴ画像アセットが存在しないため、既存デザイン（opengraph-image.tsxと
 * 同じ配色・同じ🧰の絵文字）を流用してコードで生成する。新規npm依存関係は
 * 追加しない（next/ogは既存のopengraph-image.tsxで既に使用済み）。
 * 既存の src/app/favicon.ico は削除・変更せず、そのまま残す
 * （Next.jsはfavicon.icoとicon.tsxの両方を<head>に別々に出力でき、
 * 競合しないことをNext.js公式ドキュメントで確認済み）。
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #1d4ed8 0%, #1e293b 100%)",
          borderRadius: 6,
        }}
      >
        <span style={{ fontSize: 22 }}>🧰</span>
      </div>
    ),
    { ...size }
  );
}
