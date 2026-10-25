import Link from "next/link";
import type { Category } from "@/lib/tools/types";
import { glassCardClasses } from "@/components/ui/glass-card";
import { CategoryIcon } from "@/components/ui/category-icon";
import { cn } from "@/lib/utils/cn";

/**
 * カテゴリのカード（トップページのカテゴリ一覧用）。カード全体が1つのリンク。
 * リンク先は従来どおりカテゴリのページ（/tools/<カテゴリID>）。
 * ツールのカード（ToolCard）とは情報の構造（名前＋件数だけ）が違うので別部品にし、
 * ガラスの見た目だけを共通のクラス（glassCardClasses）で揃えている。
 * アイコンは色分けしたタイル（CategoryIcon）。名前と件数は必ず文字で出す。
 */
export function CategoryCard({ category, toolCount }: { category: Category; toolCount: number }) {
  return (
    <Link
      href={`/tools/${category.id}`}
      className={cn(glassCardClasses({ interactive: true }), "group flex flex-col gap-3 p-4 sm:p-5")}
    >
      <CategoryIcon id={category.id} size="md" />
      <span className="flex min-w-0 items-end justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-semibold text-ms-text group-hover:text-ms-accent dark:group-hover:text-ms-focus">
            {category.name}
          </span>
          <span className="block text-xs text-ms-muted">{toolCount}ツール</span>
        </span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="mb-0.5 h-4 w-4 flex-none text-ms-muted transition-transform group-hover:translate-x-0.5"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
    </Link>
  );
}
