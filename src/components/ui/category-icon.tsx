import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * カテゴリのアイコン（色分けした角丸のタイル＋線画）。絵文字の代わりに、カード・メニュー・一覧で共通に使う。
 *
 * - 装飾なので aria-hidden。カテゴリ名は必ず隣に文字で出す（色やアイコンだけで区別しない）。
 * - 色は globals.css の .ms-tile[data-cat="..."]（ライト・ダーク両対応）にある。
 * - カテゴリIDが未知の場合は「その他」の見た目にする（データ側 categories.ts の icon は変更しない）。
 */
const PATHS: Record<string, ReactNode> = {
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="9.5" r="1.6" />
      <path d="m21 16-4.6-4.6a1.5 1.5 0 0 0-2.1 0L6 19.8" />
    </>
  ),
  pdf: (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5" />
      <path d="M9 14h6M9 17.5h4" />
    </>
  ),
  "csv-excel": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18M3 14.5h18M9 4v16" />
    </>
  ),
  word: (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5" />
      <path d="m8.5 12.5 1.4 5 2.1-5 2.1 5 1.4-5" />
    </>
  ),
  pptx: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M12 16v4M8.5 20h7" />
      <path d="m7.5 12.5 3-3 2.5 2 3.5-3.5" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5.5" width="13" height="13" rx="3" />
      <path d="m16 10.5 5-3v9l-5-3" />
    </>
  ),
  audio: (
    <>
      <path d="M4 14.5V12a8 8 0 0 1 16 0v2.5" />
      <rect x="3" y="14" width="4" height="6.5" rx="1.6" />
      <rect x="17" y="14" width="4" height="6.5" rx="1.6" />
    </>
  ),
  file: <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />,
  generator: (
    <>
      <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4" />
      <path d="m6.2 6.2 2.6 2.6M15.2 15.2l2.6 2.6M17.8 6.2l-2.6 2.6M8.8 15.2l-2.6 2.6" />
    </>
  ),
  other: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
};

export function CategoryIcon({
  id,
  size = "md",
  className,
}: {
  id: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const key = id in PATHS ? id : "other";
  return (
    <span
      aria-hidden="true"
      data-cat={key}
      className={cn("ms-tile", size === "sm" && "ms-tile-sm", size === "lg" && "ms-tile-lg", className)}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {PATHS[key]}
      </svg>
    </span>
  );
}
