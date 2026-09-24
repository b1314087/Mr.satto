import Link from "next/link";
import type { Category } from "@/lib/tools/types";
import type { Tool } from "@/lib/tools/types";
import { ToolCard } from "@/components/tools/tool-card";
import { categories } from "@/lib/tools/categories";

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
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-center gap-2">
        <span className="text-2xl" aria-hidden="true">
          {category.icon}
        </span>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">{category.name}ツール一覧</h1>
      </div>

      <p className="mb-8 max-w-2xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{intro}</p>

      {availableTools.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {availableTools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      {comingSoonTools.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-sm font-semibold text-neutral-500 dark:text-neutral-400">準備中のツール</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {comingSoonTools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-12">
        <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-white">他のカテゴリを見る</h2>
        <div className="flex flex-wrap gap-2">
          {otherCategories.map((c) => (
            <Link
              key={c.id}
              href={`/tools/${c.id}`}
              className="rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-700 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:text-blue-400"
            >
              {c.icon} {c.name}
            </Link>
          ))}
        </div>
        <Link
          href="/tools"
          className="mt-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          すべてのツールを検索・一覧から探す
        </Link>
      </div>
    </div>
  );
}
