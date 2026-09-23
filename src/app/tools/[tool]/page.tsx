import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { tools, getToolById, getToolsByCategory } from "@/lib/tools/data";
import { getCategory } from "@/lib/tools/categories";
import { CategoryBadge } from "@/components/tools/category-badge";
import { ComingSoon } from "@/components/tools/coming-soon";
import { ToolImplementation } from "@/components/tools/tool-registry";
import { hasImplementation } from "@/lib/tools/registry";
import { ToolCard } from "@/components/tools/tool-card";

interface ToolPageProps {
  params: Promise<{ tool: string }>;
}

export function generateStaticParams() {
  return tools.map((tool) => ({ tool: tool.id }));
}

export async function generateMetadata({ params }: ToolPageProps): Promise<Metadata> {
  const { tool: toolId } = await params;
  const tool = getToolById(toolId);
  if (!tool) return {};
  return {
    title: tool.name,
    description: tool.description,
    alternates: {
      canonical: `/tools/${tool.id}`,
    },
  };
}

export default async function ToolPage({ params }: ToolPageProps) {
  const { tool: toolId } = await params;
  const tool = getToolById(toolId);
  if (!tool) notFound();

  const isAvailable = tool.status === "available" && hasImplementation(tool.id);
  const related = getToolsByCategory(tool.category)
    .filter((t) => t.id !== tool.id)
    .slice(0, 4);
  const category = getCategory(tool.category);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <nav className="mb-4 flex items-center gap-1 text-xs text-neutral-400">
        <Link href="/" className="hover:text-blue-600 dark:hover:text-blue-400">
          トップ
        </Link>
        <span>/</span>
        <Link href="/tools" className="hover:text-blue-600 dark:hover:text-blue-400">
          ツール一覧
        </Link>
        <span>/</span>
        <span className="text-neutral-500 dark:text-neutral-300">{tool.name}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-2xl" aria-hidden="true">
              {category?.icon}
            </span>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">{tool.name}</h1>
          </div>
          <p className="text-neutral-600 dark:text-neutral-300">{tool.description}</p>
        </div>
        <CategoryBadge category={tool.category} />
      </div>

      <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 sm:p-6">
        {isAvailable ? <ToolImplementation toolId={tool.id} /> : <ComingSoon tool={tool} />}
      </div>

      {related.length > 0 && (
        <div className="mt-12">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-white">
            {category?.name}の他のツール
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {related.map((t) => (
              <ToolCard key={t.id} tool={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
