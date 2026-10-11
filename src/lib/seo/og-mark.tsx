/**
 * アイコン・OGP画像（next/ogのImageResponse）用の、道具箱マーク（インラインSVG）。
 *
 * それまで各画像は絵文字（🧰など）を使っていたが、ImageResponseは絵文字の描画時に
 * 外部CDN（cdn.jsdelivr.net等）から画像データをビルド時に取得するため、CDN障害や
 * ネットワーク遮断環境でビルド全体が失敗する原因になっていた。
 * このマークはネットワークを使わず、コード内の図形だけで描画する
 * （新規npmパッケージ・新規フォント・外部アセットの追加なし）。
 *
 * Satoriで確実に描画できるよう、svg直下に基本図形（rect/path）のみを使う。
 */
interface OgMarkProps {
  size: number;
}

export function OgMark({ size }: OgMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* 持ち手 */}
      <path
        d="M22 24 V15 H42 V24"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 本体 */}
      <rect x="6" y="22" width="52" height="36" rx="7" fill="#ffffff" />
      {/* 帯 */}
      <rect x="6" y="35" width="52" height="4" fill="#1d4ed8" />
      {/* 留め具 */}
      <rect x="26" y="31" width="12" height="12" rx="3" fill="#1d4ed8" />
      <rect x="29.5" y="34.5" width="5" height="5" rx="1.5" fill="#ffffff" />
    </svg>
  );
}
