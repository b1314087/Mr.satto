"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState } from "react";
import { searchTools, type SearchableTool } from "@/lib/tools/search";
import { categories, getCategory } from "@/lib/tools/categories";
import { dispatchToolsNavigate } from "@/lib/navigation/tools-navigate";
import { featureFlags } from "@/lib/config/features";
import { TOOL_TIER_LABELS } from "@/lib/plans/types";
import type { Tool } from "@/lib/tools/types";

/** トップページの検索候補に使うツールの項目（画面に渡すのは、これだけ） */
export type HomeSearchTool = SearchableTool & Pick<Tool, "requiredPlan">;

/** 検索候補の数（多すぎると選びにくいため、上位だけを出す） */
const MAX_SUGGESTIONS = 5;

/** 入力欄の下に出す、検索の例（押すとそのまま検索する） */
const EXAMPLES = ["PDFを圧縮したい", "画像の背景を消したい", "動画を短くしたい", "Excelを比較したい", "ファイル形式を変換したい"];

/**
 * トップページの検索欄（トップページの検索改善の工程）。
 *
 * - 「何をしたいですか？」の見出しと、具体的な例の入った入力欄で、作業から探せることを伝える。
 * - 入力すると、関係の深いツールを上位5件まで候補に出す（検索はブラウザ内だけ。既存の searchTools をそのまま使う）。
 *   ツールの一覧（data.ts）は、ページを開いた時点では読み込まず、検索欄に触れたときに初めて読み込む（トップページを重くしない）。
 *   候補を選ぶとそのツールへ、Enter・検索ボタンでは従来どおり一覧（/tools?q=）へ移動する。
 * - 上下キーで候補を選び、Enter で移動、Escape で候補を閉じる（WAI-ARIA の combobox の形）。
 * - 当てはまるツールがないときは、別の言葉で探すよう案内し、カテゴリへの入口を出す。
 */
export function HomeSearch({ total }: { total: number }) {
  const router = useRouter();
  const [tools, setTools] = useState<HomeSearchTool[] | null>(null);
  const loadingRef = useRef(false);
  /** ツールの一覧を読み込む（1回だけ。検索欄に触れたとき） */
  function ensureTools() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    void import("@/lib/tools/data").then(
      (m) => setTools(m.getListedTools().filter((t) => t.status === "available")),
      () => {
        loadingRef.current = false;
      }
    );
  }
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const query = value.trim();
  // 入力が変わったときだけ検索する（候補の数え直しで、ページ全体を描き直さない）
  const results = useMemo(() => (query && tools ? searchTools(tools, query) : []), [tools, query]);
  const suggestions = results.slice(0, MAX_SUGGESTIONS);
  const showPanel = open && query.length > 0;
  // 候補の最後に「すべての結果を見る」を置く（候補がないときは置かない）
  const optionCount = suggestions.length > 0 ? suggestions.length + 1 : 0;

  function goList(q: string) {
    const href = q ? `/tools?q=${encodeURIComponent(q)}` : "/tools";
    dispatchToolsNavigate(href);
    router.push(href);
    setOpen(false);
  }

  function goTool(id: string) {
    setOpen(false);
    router.push(`/tools/${id}`);
  }

  function choose(index: number) {
    if (index >= 0 && index < suggestions.length) goTool(suggestions[index].id);
    else goList(query);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (!query) return;
      e.preventDefault();
      setOpen(true);
      if (optionCount > 0) setActive((a) => (a + 1) % optionCount);
    } else if (e.key === "ArrowUp") {
      if (!query) return;
      e.preventDefault();
      setOpen(true);
      if (optionCount > 0) setActive((a) => (a <= 0 ? optionCount - 1 : a - 1));
    } else if (e.key === "Escape") {
      if (showPanel) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // 候補を選んでいれば、そのツールへ。選んでいなければ、一覧で検索結果をすべて見る
    if (showPanel && active >= 0 && active < optionCount) choose(active);
    else goList(query);
  }

  function runExample(text: string) {
    setValue(text);
    goList(text);
  }

  return (
    <div className="flex w-full flex-col gap-2" data-testid="home-search">
      <label htmlFor={`${listId}-input`} className="text-base font-semibold text-ms-text sm:text-lg">
        何をしたいですか？
      </label>
      <form
        role="search"
        onSubmit={onSubmit}
        className="relative w-full"
        onBlur={(e) => {
          // 候補を押すあいだは閉じない（フォームの外へフォーカスが移ったときだけ閉じる）
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <svg className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-ms-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          value={value}
          onChange={(e) => {
            ensureTools();
            setValue(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => {
            ensureTools();
            setOpen(true);
          }}
          onPointerEnter={ensureTools}
          onKeyDown={onKeyDown}
          placeholder="例：PDFを圧縮したい"
          autoComplete="off"
          enterKeyHint="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={`${listId}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showPanel && active >= 0 && active < optionCount ? optionId(active) : undefined}
          aria-describedby={`${listId}-help`}
          className="ms-input ms-input-soft ms-input-pill [&::-webkit-search-cancel-button]:hidden"
          style={{ paddingRight: value ? "6.25rem" : undefined }}
          data-testid="home-search-input"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              setValue("");
              setActive(-1);
              inputRef.current?.focus();
            }}
            className="ms-focus-ring absolute right-14 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-ms-muted hover:bg-ms-hover-tint hover:text-ms-text"
            aria-label="入力を消す"
            data-testid="home-search-clear"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true" className="h-4 w-4">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        )}
        <button type="submit" aria-label="検索する" className="ms-search-go" data-testid="home-search-submit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>

        {showPanel && (
          <div
            className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-ms-card border border-ms-border bg-ms-strong shadow-[var(--ms-shadow-lift)]"
            data-testid="home-search-panel"
          >
            {tools === null ? (
              <p className="px-4 py-3 text-sm text-ms-muted" role="status">
                候補を探しています…
              </p>
            ) : suggestions.length > 0 ? (
              <ul id={`${listId}-list`} role="listbox" aria-label="検索候補" className="max-h-[60vh] overflow-y-auto py-1">
                {suggestions.map((tool, i) => {
                  const category = getCategory(tool.category);
                  const premium = featureFlags.billing && tool.requiredPlan === "premium";
                  return (
                    <li
                      key={tool.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={active === i}
                      tabIndex={-1}
                      // マウスで押したときに入力欄のフォーカスが外れて候補が閉じないよう、押した時点では何もしない
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => goTool(tool.id)}
                      onMouseEnter={() => setActive(i)}
                      className={`flex cursor-pointer flex-col gap-0.5 px-4 py-2.5 ${active === i ? "bg-blue-50 dark:bg-blue-950/40" : ""}`}
                      data-testid="home-search-option"
                      data-tool-id={tool.id}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-ms-text">{tool.name}</span>
                        {category && <span className="text-[11px] text-ms-muted">{category.name}</span>}
                        {premium && (
                          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                            {TOOL_TIER_LABELS.premium}
                          </span>
                        )}
                      </span>
                      <span className="line-clamp-2 text-xs text-ms-muted">{tool.description}</span>
                    </li>
                  );
                })}
                <li
                  id={optionId(suggestions.length)}
                  role="option"
                  aria-selected={active === suggestions.length}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => goList(query)}
                  onMouseEnter={() => setActive(suggestions.length)}
                  className={`cursor-pointer border-t border-ms-border px-4 py-2.5 text-sm text-ms-accent dark:text-ms-focus ${active === suggestions.length ? "bg-blue-50 dark:bg-blue-950/40" : ""}`}
                  data-testid="home-search-all"
                >
                  「{query}」の検索結果をすべて見る（{results.length}件）→
                </li>
              </ul>
            ) : (
              <div className="flex flex-col gap-2 px-4 py-3 text-sm" role="status" data-testid="home-search-empty">
                <p className="text-ms-text">該当するツールが見つかりませんでした。別の言葉でも検索してみてください。</p>
                <p className="text-xs text-ms-muted">カテゴリから探すこともできます：</p>
                <div className="flex flex-wrap gap-1.5">
                  {categories.map((c) => (
                    <Link key={c.id} href={`/tools/${c.id}`} className="ms-chip text-xs" onMouseDown={(e) => e.preventDefault()}>
                      {c.name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </form>
      <p id={`${listId}-help`} className="text-xs text-ms-muted">
        ツール名を知らなくても、やりたい作業やファイルの形式で探せます ・ 全 {total} ツール
      </p>
      <div className="flex flex-wrap gap-1.5" aria-label="検索の例">
        {EXAMPLES.map((text) => (
          <button key={text} type="button" onClick={() => runExample(text)} className="ms-chip text-xs" data-testid="home-search-example">
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
