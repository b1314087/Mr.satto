"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Tool, CategoryId } from "@/lib/tools/types";
import type { Category } from "@/lib/tools/types";
import { searchTools } from "@/lib/tools/search";
import { SearchBar } from "./search-bar";
import { ToolGrid } from "./tool-grid";
import { CategoryIcon } from "@/components/ui/category-icon";
import { TOOLS_NAVIGATE_EVENT, type ToolsNavigateDetail } from "@/lib/navigation/tools-navigate";

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

  // メニューやヘッダー検索から /tools?... へ移動した時、URLだけでなく絞り込みも合わせる。
  // （すでにこのページを開いていると、URLが変わっても画面の状態は自動では変わらないため）
  // 検索欄は key を変えて作り直し、表示を新しい検索語に揃える（この一覧の中だけの再マウント）。
  const [searchBarKey, setSearchBarKey] = useState(0);
  const [searchBarInitial, setSearchBarInitial] = useState(initialQuery);
  useEffect(() => {
    const validIds = new Set<string>(categories.map((c) => c.id));
    function handleToolsNavigate(e: Event) {
      const detail = (e as CustomEvent<ToolsNavigateDetail>).detail;
      if (!detail) return;
      setQuery(detail.query);
      setCategory(validIds.has(detail.category) ? (detail.category as CategoryId) : "all");
      setSearchBarInitial(detail.query);
      setSearchBarKey((n) => n + 1);
    }
    window.addEventListener(TOOLS_NAVIGATE_EVENT, handleToolsNavigate);
    return () => window.removeEventListener(TOOLS_NAVIGATE_EVENT, handleToolsNavigate);
  }, [categories]);

  function clearFilters() {
    setQuery("");
    setCategory("all");
    updateUrl("", "all");
    setSearchBarResetSignal((n) => n + 1);
  }

  // カテゴリごとの件数（絞り込み前の、使えるツールの数。左の列・ボタンの横に出す）
  const countByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tools) {
      if (t.status !== "available") continue;
      map.set(t.category, (map.get(t.category) ?? 0) + 1);
    }
    return map;
  }, [tools]);
  const totalAvailable = useMemo(() => tools.filter((t) => t.status === "available").length, [tools]);

  function selectCategory(next: CategoryId | "all") {
    setCategory(next);
    updateUrl(query, next);
  }

  return (
    <div className="flex flex-col gap-6">
      <SearchBar
        key={searchBarKey}
        initialValue={searchBarInitial}
        resetSignal={searchBarResetSignal}
        pill
        onSearch={(value) => {
          setQuery(value);
          updateUrl(value, category);
        }}
      />

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        {/* PC: 左のカテゴリ列（完成図どおり）。名前＋件数。選択中は青い線と太字でも示す */}
        <aside aria-label="カテゴリで絞り込む" className="ms-glass hidden p-2 lg:sticky lg:top-24 lg:block">
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                type="button"
                aria-pressed={category === "all"}
                onClick={() => selectCategory("all")}
                className="ms-side-link"
              >
                <span aria-hidden="true" className="inline-flex h-8 w-8 flex-none items-center justify-center text-ms-muted">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
                    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
                    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
                    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
                  </svg>
                </span>
                すべて
                <span aria-hidden="true" className="ms-side-count">{totalAvailable}</span>
              </button>
            </li>
            {categories.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  aria-pressed={category === cat.id}
                  onClick={() => selectCategory(cat.id)}
                  className="ms-side-link"
                >
                  <CategoryIcon id={cat.id} size="sm" />
                  {cat.name}
                  <span aria-hidden="true" className="ms-side-count">{countByCategory.get(cat.id) ?? 0}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="flex min-w-0 flex-col gap-5">
          {/* スマホ・タブレット: 横に並ぶ選択ボタン（PCでは左の列を使うので出さない） */}
          <div className="flex flex-wrap items-center gap-2 lg:hidden">
            <button type="button" aria-pressed={category === "all"} onClick={() => selectCategory("all")} className="ms-chip">
              すべて
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                aria-pressed={category === cat.id}
                onClick={() => selectCategory(cat.id)}
                className="ms-chip"
              >
                {cat.name}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ms-muted">{availableFiltered.length}件のツール</p>
            {hasActiveFilter && (
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-full border border-dashed border-ms-border-strong px-3 py-1.5 text-sm font-medium text-ms-muted transition-colors hover:text-ms-text"
              >
                絞り込みを解除
              </button>
            )}
          </div>

          <ToolGrid tools={availableFiltered} />

          {comingSoonFiltered.length > 0 && (
            <div className="mt-4">
              <h2 className="mb-1 text-sm font-semibold text-ms-muted">
                準備中のツール（{comingSoonFiltered.length}件）
              </h2>
              <p className="mb-4 text-xs text-ms-muted">
                近日公開予定のツールです。まだ利用できません。
              </p>
              <ToolGrid tools={comingSoonFiltered} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
