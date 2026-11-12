import Link from "next/link";
import type { Category } from "@/lib/tools/types";
import type { Tool } from "@/lib/tools/types";
import { ToolCard } from "@/components/tools/tool-card";
import { categories, getCategoryToolsLabel } from "@/lib/tools/categories";
import { CategoryIcon } from "@/components/ui/category-icon";
import { getToolById, tools } from "@/lib/tools/data";
import { hasImplementation } from "@/lib/tools/registry";
import { CATEGORY_CROSS_LINKS } from "@/lib/tools/internal-links";

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
  const isUsable = (t: Tool) => t.status === "available" && hasImplementation(t.id);
  // 総合ツール（例：PDF編集）にまとめた機能の、個別のページ（例：PDF結合）。一覧のカードには出さないため、ここでリンクする
  const featurePages = tools.filter((t) => t.category === category.id && t.mergedInto && isUsable(t));
  // ほかのカテゴリに所属しているが、このカテゴリでも探されやすいツール（設定は src/lib/tools/internal-links.ts）
  const crossLinked = (CATEGORY_CROSS_LINKS[category.id] ?? [])
    .map((id) => getToolById(id))
    .filter((t): t is Tool => t !== undefined && t.category !== category.id && isUsable(t) && !t.mergedInto);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      {/* 見出しの右隣に説明文を置く（広い画面）。狭い画面では、見出しの下に回り込む。 */}
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:gap-8">
        <div className="flex shrink-0 items-center gap-3">
          <CategoryIcon id={category.id} size="lg" />
          <h1 className="text-2xl font-bold text-ms-text">{getCategoryToolsLabel(category)}一覧</h1>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-ms-muted">{intro}</p>
      </div>

      {availableTools.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {availableTools.map((tool) => (
            <ToolCard key={tool.id} tool={tool} compact headingLevel="h2" />
          ))}
        </div>
      )}

      {featurePages.length > 0 && (
        <section className="mt-8" aria-labelledby="feature-pages-heading">
          <h2 id="feature-pages-heading" className="mb-1 text-base font-semibold text-ms-text">
            機能ごとのページ
          </h2>
          <p className="mb-3 text-sm text-ms-muted">上のツールの中にある機能を、機能ごとのページから直接開けます。</p>
          <div className="flex flex-wrap gap-2">
            {featurePages.map((t) => (
              <Link key={t.id} href={`/tools/${t.id}`} className="ms-chip">
                {t.name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {crossLinked.length > 0 && (
        <section className="mt-8" aria-labelledby="cross-links-heading">
          <h2 id="cross-links-heading" className="mb-1 text-base font-semibold text-ms-text">
            ほかのカテゴリにある{category.name}関連のツール
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {crossLinked.map((t) => (
              <Link key={t.id} href={`/tools/${t.id}`} className="ms-chip">
                {t.name}
              </Link>
            ))}
          </div>
        </section>
      )}

      {comingSoonTools.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-4 text-sm font-semibold text-ms-muted">準備中のツール</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {comingSoonTools.map((tool) => (
              <ToolCard key={tool.id} tool={tool} compact />
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
