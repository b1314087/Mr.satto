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

  return (
    <div className="flex flex-col gap-6">
      <SearchBar
        initialValue={initialQuery}
        onSearch={(value) => {
          setQuery(value);
          updateUrl(value, category);
        }}
      />

      <div className="flex flex-wrap gap-2">
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
      </div>

      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        {filtered.length}件のツール
      </p>

      <ToolGrid tools={filtered} />
    </div>
  );
}
