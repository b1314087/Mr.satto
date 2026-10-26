import { cn } from "@/lib/utils/cn";

/**
 * Mr.Satto のロゴマーク（青いガラスのタイルに白い道具箱）。ブラウザのタブのアイコン（src/app/icon.tsx）と同じ図柄。
 * ヘッダー・メニュー・フッター・ホームで共通に使う。
 *
 * - 装飾なので aria-hidden（サービス名の文字は隣に必ず置く）。
 * - 色はロゴの中で固定（青のタイル＋白い道具箱）。ライト・ダークどちらでも同じに見える。
 * - 画像ファイルではなくインラインのSVGなので、追加の通信・依存関係はない。
 */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
    >
      <defs>
        <linearGradient id="ms-brand-tile" x1="4" y1="2" x2="44" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="url(#ms-brand-tile)" stroke="rgba(255,255,255,0.55)" />
      <rect x="2.5" y="2.5" width="43" height="22" rx="12" fill="var(--ms-brand-shine)" opacity="0.4" />
      <g transform="translate(8 8) scale(0.5)">
        <path d="M22 24 V15 H42 V24" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <rect x="6" y="22" width="52" height="36" rx="7" fill="#ffffff" />
        <rect x="6" y="35" width="52" height="4" fill="#1d4ed8" />
        <rect x="26" y="31" width="12" height="12" rx="3" fill="#1d4ed8" />
        <rect x="29.5" y="34.5" width="5" height="5" rx="1.5" fill="#ffffff" />
      </g>
    </svg>
  );
}
