"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type Ref } from "react";
import { dispatchToolsNavigate } from "@/lib/navigation/tools-navigate";

interface SearchBarProps {
  placeholder?: string;
  initialValue?: string;
  size?: "sm" | "lg";
  onSearch?: (value: string) => void;
  /**
   * Phase 19: 「絞り込みを解除」など、呼び出し側の都合で検索テキストを
   * 強制的に空にしたいときに、このプロパティの値を変える（インクリメントする等）。
   * 初回マウント時には何もしない（=既存の initialValue によるURL復元を壊さない）。
   * このプロパティを渡さない既存の呼び出し箇所（HeaderSearch等）の挙動は変えない。
   */
  resetSignal?: number;
  /** 入力欄のアクセシブルネーム。同じ画面に複数の検索欄がある時、区別したい場合だけ指定する */
  ariaLabel?: string;
  /** 入力欄へのref（メニューを開いた時にここへフォーカスを移すために使う） */
  inputRef?: Ref<HTMLInputElement>;
  /** onSearch が無い（=/tools へ移動する）場合に、移動を始めた直後に呼ばれる（メニューを閉じる等に使う） */
  onNavigate?: () => void;
}

/**
 * ツール検索欄（共通）。
 * onSearch が渡されていればその場でフィルタリング、無ければ /tools へ遷移する。
 */
export function SearchBar({
  placeholder = "ツールを検索（例: 画像 圧縮 / PDF / QR）",
  initialValue = "",
  size = "lg",
  onSearch,
  resetSignal,
  ariaLabel = "ツールを検索",
  inputRef,
  onNavigate,
}: SearchBarProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  // resetSignal が「前回から変わった時」だけ検索語を空にする。
  // （初回マウントでは何もしない。「初回かどうか」の旗で判定すると、開発モードのStrict Modeが
  //  エフェクトを2回実行するため、URLの?qから復元した初期値が消えてしまう）
  const lastResetSignal = useRef(resetSignal);

  useEffect(() => {
    if (lastResetSignal.current === resetSignal) return;
    lastResetSignal.current = resetSignal;
    setValue("");
  }, [resetSignal]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (onSearch) {
      onSearch(value);
    } else {
      const q = value.trim();
      const href = q ? `/tools?q=${encodeURIComponent(q)}` : "/tools";
      // すでに /tools を開いていても、一覧の絞り込みが検索語に追随するように知らせる
      dispatchToolsNavigate(href);
      router.push(href);
      onNavigate?.();
    }
  }

  return (
    <form onSubmit={handleSubmit} role="search" className="relative w-full">
      <svg
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
        />
      </svg>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onSearch?.(e.target.value);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={
          size === "lg"
            ? "w-full rounded-xl border border-neutral-200 bg-white py-3 pl-10 pr-4 text-base shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            : "w-full rounded-lg border border-neutral-200 bg-white py-1.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        }
      />
    </form>
  );
}

export function HeaderSearch() {
  return <SearchBar size="sm" placeholder="ツールを検索" />;
}
