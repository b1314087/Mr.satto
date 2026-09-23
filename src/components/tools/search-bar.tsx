"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface SearchBarProps {
  placeholder?: string;
  initialValue?: string;
  size?: "sm" | "lg";
  onSearch?: (value: string) => void;
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
}: SearchBarProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (onSearch) {
      onSearch(value);
    } else {
      const q = value.trim();
      router.push(q ? `/tools?q=${encodeURIComponent(q)}` : "/tools");
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
        type="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onSearch?.(e.target.value);
        }}
        placeholder={placeholder}
        aria-label="ツールを検索"
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
