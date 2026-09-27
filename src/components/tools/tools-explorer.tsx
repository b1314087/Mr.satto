"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Tool, CategoryId } from "@/lib/tools/types";
import type { Category } from "@/lib/tools/types";
import { searchTools } from "@/lib/tools/search";
import { SearchBar } from "./search-bar";
import { ToolGrid } from "./tool-grid";
import { cn } from "@/lib/utils/cn";

interface ToolsExplorerProps {
  tools: Tool[];
  categories: Category[];
  initialQuery?: string;
  initialCategory?: CategoryId | "all";
}

export function ToolsExplorer({
  tools,
  categories,
  initialQuery = "",
  initialCategory = "all",
}: ToolsExplorerProps) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState<CategoryId | "all">(initialCategory);

  function updateUrl(nextQuery: string, nextCategory: CategoryId | "all") {
    const params = new URLSearchParams();
    if (nextQuery) params.set("q", nextQuery);
    if (nextCategory !== "all") params.set("category", nextCategory);
    const qs = params.toString();
    router.replace(qs ? `/tools?${qs}` : "/tools", { scroll: false });
  }

  const filtered = useMemo(() => {
    let result = category === "all" ? tools : tools.filter((t) => t.category === category);
    result = searchTools(result, query);
    return result;
  }, [tools, category, query]);

  // Phase 19: 準備中（coming-soon）のツールは実装済みツールの検索結果に
  // 紛れ込ませない（開発指示書10章）。カテゴリページ（CategoryLanding）で
  // 既に採用している「実装済み／準備中を別セクションに分ける」という
  // 既存パターンを、この検索・一覧ページにも合わせる。
  const availableFiltered = useMemo(
    () => filtered.filter((t) => t.status === "available"),
    [filtered]
  );
  const comingSoonFiltered = useMemo(
    () => filtered.filter((t) => t.status === "coming-soon"),
    [filtered]
  );

  const hasActiveFilter = query.trim().length > 0 || category !== "all";

  // 「絞り込みを解除」でSearchBar内部のテキストも確実に空にするための信号
  // （SearchBar側のresetSignalプロパティ。値を変えるとSearchBarが自身の表示を
  // 空文字にリセットする。他の呼び出し箇所（ヘッダー等）には影響しない）。
  const [searchBarResetSignal, setSearchBarResetSignal] = useState(0);

  function clearFilters() {
    setQuery("");
    setCategory("all");
    updateUrl("", "all");
    setSearchBarResetSignal((n) => n + 1);
  }

  return (
    <div className="flex flex-col gap-6">
      <SearchBar
        initialValue={initialQuery}
        resetSignal={searchBarResetSignal}
        onSearch={(value) => {
          setQuery(value);
          updateUrl(value, category);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setCategory("all");
            updateUrl(query, "all");
          }}
          className={cn(
            "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
            category === "all"
              ? "bg-blue-600 text-white"
              : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
          )}
        >
          すべて
        </button>
        {categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => {
              setCategory(cat.id);
              updateUrl(query, cat.id);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
              category === cat.id
                ? "bg-blue-600 text-white"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            )}
          >
            <span aria-hidden="true">{cat.icon}</span>
            {cat.name}
          </button>
        ))}
        {hasActiveFilter && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-full border border-dashed border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-700 dark:border-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            絞り込みを解除
          </button>
        )}
      </div>

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {availableFiltered.length}件のツール
      </p>

      <ToolGrid tools={availableFiltered} />

      {comingSoonFiltered.length > 0 && (
        <div className="mt-4">
          <h2 className="mb-1 text-sm font-semibold text-neutral-500 dark:text-neutral-400">
            準備中のツール（{comingSoonFiltered.length}件）
          </h2>
          <p className="mb-4 text-xs text-neutral-400 dark:text-neutral-500">
            近日公開予定のツールです。まだ利用できません。
          </p>
          <ToolGrid tools={comingSoonFiltered} />
        </div>
      )}
    </div>
  );
}
