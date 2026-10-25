import Link from "next/link";
import type { Category } from "@/lib/tools/types";
import type { Tool } from "@/lib/tools/types";
import { ToolCard } from "@/components/tools/tool-card";
import { categories, getCategoryToolsLabel } from "@/lib/tools/categories";
import { CategoryIcon } from "@/components/ui/category-icon";

export function CategoryLanding({
  category,
  intro,
  availableTools,
  comingSoonTools,
}: {
  category: Category;
  intro: string;
  availableTools: Tool[];
  comingSoonTools: Tool[];
}) {
  const otherCategories = categories.filter((c) => c.id !== category.id);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-center gap-3">
        <CategoryIcon id={category.id} size="lg" />
        <h1 className="text-2xl font-bold text-ms-text">{getCategoryToolsLabel(category)}一覧</h1>
      </div>

      <p className="mb-8 max-w-2xl text-sm leading-relaxed text-ms-muted">{intro}</p>

      {availableTools.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {availableTools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      {comingSoonTools.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-sm font-semibold text-ms-muted">準備中のツール</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {comingSoonTools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-12">
        <h2 className="mb-4 text-lg font-semibold text-ms-text">他のカテゴリを見る</h2>
        <div className="flex flex-wrap gap-2">
          {otherCategories.map((c) => (
            <Link
              key={c.id}
              href={`/tools/${c.id}`}
              className="ms-chip"
            >
              {c.name}
            </Link>
          ))}
        </div>
        <Link
          href="/tools"
          className="mt-4 inline-block text-sm text-ms-accent hover:underline dark:text-ms-focus"
        >
          すべてのツールを検索・一覧から探す
        </Link>
      </div>
    </div>
  );
}
