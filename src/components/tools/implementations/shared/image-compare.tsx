"use client";

import { useMemo } from "react";
import { useObjectUrl } from "@/lib/utils/use-object-url";

/**
 * 画像の変換前・変換後などを、大きく並べて見せる（PowerPoint白黒反転の、画像のプレビュー用）。
 * 小さなサムネイルでは、文字の読みやすさやにじみが分からないので、画面の幅いっぱいに縦に並べる。
 * 「大きく見る」で、別のタブに原寸で開ける。
 */
export interface CompareItem {
  label: string;
  bytes?: Uint8Array;
  mime?: string;
  /** 変換後（暗い背景）の画像。透明な部分が分かるよう、背景の色を変える */
  dark?: boolean;
}

function CompareFigure({ item }: { item: CompareItem }) {
  const blob = useMemo(() => (item.bytes ? new Blob([item.bytes as BlobPart], { type: item.mime ?? "image/png" }) : null), [item.bytes, item.mime]);
  const url = useObjectUrl(blob);
  if (!item.bytes) return null;
  return (
    <figure data-testid="image-compare-item" className="flex min-w-0 flex-col gap-1">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-neutral-800 dark:text-neutral-100">
        <span>{item.label}</span>
        {url && (
          <a href={url} target="_blank" rel="noopener" className="font-normal text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
            大きく見る
          </a>
        )}
      </figcaption>
      <div className={`flex min-h-24 items-center justify-center overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-600 ${item.dark ? "bg-neutral-600" : "bg-neutral-200"}`}>
        {url && (
          // eslint-disable-next-line @next/next/no-img-element -- 変換前後の画像（blob URL）をそのまま見せるプレビュー
          <img src={url} alt={item.label} className="block h-auto max-h-[28rem] w-auto max-w-full object-contain" />
        )}
      </div>
    </figure>
  );
}

export function ImageCompare({ items }: { items: CompareItem[] }) {
  return (
    <div className="flex w-full flex-col gap-3">
      {items.map((item) => (
        <CompareFigure key={item.label} item={item} />
      ))}
    </div>
  );
}
