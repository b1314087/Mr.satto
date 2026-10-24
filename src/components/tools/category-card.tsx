import Link from "next/link";
import type { Category } from "@/lib/tools/types";
import { glassCardClasses } from "@/components/ui/glass-card";
import { cn } from "@/lib/utils/cn";

/**
 * カテゴリのカード（トップページのカテゴリ一覧用）。カード全体が1つのリンク。
 * リンク先は従来どおりカテゴリのページ（/tools/<カテゴリID>）。
 * ツールのカード（ToolCard）とは情報の構造（名前＋件数だけ）が違うので別部品にし、
 * ガラスの見た目だけを共通のクラス（glassCardClasses）で揃えている。
 */
export function CategoryCard({ category, toolCount }: { category: Category; toolCount: number }) {
  return (
    <Link
      href={`/tools/${category.id}`}
      className={cn(glassCardClasses({ interactive: true }), "group flex items-center gap-2.5 p-3 sm:gap-3 sm:p-4")}
    >
      <span className="text-2xl" aria-hidden="true">
        {category.icon}
      </span>
      <span className="min-w-0">
        <span className="block font-semibold text-ms-text group-hover:text-ms-accent dark:group-hover:text-ms-focus">
          {category.name}
        </span>
        <span className="block text-xs text-ms-muted">{toolCount}ツール</span>
      </span>
    </Link>
  );
}
