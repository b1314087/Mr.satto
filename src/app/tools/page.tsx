import type { Metadata } from "next";
import { ToolsExplorer } from "@/components/tools/tools-explorer";
import { tools } from "@/lib/tools/data";
import { categories } from "@/lib/tools/categories";
import type { CategoryId } from "@/lib/tools/types";

export const metadata: Metadata = {
  title: "ツール一覧",
  description: "画像・PDF・ファイル・CSV/Excelなど、全ツールを検索・カテゴリから探せます。",
};

const CATEGORY_IDS = new Set(categories.map((c) => c.id));

interface ToolsPageProps {
  searchParams: Promise<{ q?: string; category?: string }>;
}

export default async function ToolsPage({ searchParams }: ToolsPageProps) {
  const params = await searchParams;
  const initialQuery = params.q ?? "";
  const initialCategory =
    params.category && CATEGORY_IDS.has(params.category as CategoryId)
      ? (params.category as CategoryId)
      : "all";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="mb-6 text-2xl font-bold text-neutral-900 dark:text-white">ツール一覧</h1>
      <ToolsExplorer
        tools={tools}
        categories={categories}
        initialQuery={initialQuery}
        initialCategory={initialCategory}
      />
    </div>
  );
}
