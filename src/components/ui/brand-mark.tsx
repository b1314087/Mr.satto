import { cn } from "@/lib/utils/cn";

/**
 * Mr.Satto のロゴマーク（ガラスのタイルに青い「S」）。ヘッダー・メニュー・ホームで共通に使う。
 *
 * - 装飾なので aria-hidden（サービス名の文字は隣に必ず置く）。
 * - 青のグラデーションはロゴの中だけ。タイルの面は共通のデザイントークンを使い、ライト・ダークに追従する。
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
        <linearGradient id="ms-brand-s" x1="10" y1="8" x2="38" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7cb2ff" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="var(--ms-surface-strong)" stroke="var(--ms-border)" />
      <rect x="2.5" y="2.5" width="43" height="22" rx="12" fill="var(--ms-brand-shine)" />
      <path
        d="M32.5 15.5c-2.6-2-5.6-2.9-8.9-2.6-4.6.4-7.3 3.3-6.2 6.6 1 3 4.6 3.9 8 4.7 3.9.9 6.9 2.3 6.5 5.8-.4 3.5-4.2 5.4-8.6 5.1-2.9-.2-5.4-1.3-7.3-3"
        fill="none"
        stroke="url(#ms-brand-s)"
        strokeWidth="5.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
