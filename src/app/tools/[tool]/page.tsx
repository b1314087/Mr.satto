import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { tools, getToolById, getToolsByCategory } from "@/lib/tools/data";
import { getCategory } from "@/lib/tools/categories";
import { CategoryBadge } from "@/components/tools/category-badge";
import { ComingSoon } from "@/components/tools/coming-soon";
import { ToolImplementation } from "@/components/tools/tool-registry";
import { ToolAccessGate } from "@/components/tools/tool-access-gate";
import { hasImplementation } from "@/lib/tools/registry";
import { ToolCard } from "@/components/tools/tool-card";
import { AdSlot } from "@/components/ads/ad-slot";
import { getServerPlan } from "@/lib/plans/current-plan";

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

  // Phase 3: 権限判定はサーバー側（認証ユーザー + DB契約状態 + 署名付き
  // Temporary Accessトークン）で確定させ、その結果だけをToolAccessGateへ渡す。
  // ツールが利用不可（isAvailable === false）の場合はcookies()を読む必要がなく、
  // 準備中ページを静的なまま提供できるため呼び出さない。
  const serverPlan = isAvailable ? await getServerPlan() : null;

  // 関連ツール: 「準備中」のツールや自分自身は候補から除外する（Coming Soonのみが
  // 表示される状態を避けるため）。同カテゴリだけで4件に満たない場合は、
  // 他カテゴリの主要ツール（featured）で補う（複雑なおすすめアルゴリズムは使わない）。
  const isRecommendable = (t: (typeof tools)[number]) =>
    t.id !== tool.id && t.status === "available" && hasImplementation(t.id);
  const sameCategoryRelated = getToolsByCategory(tool.category).filter(isRecommendable);
  const related = sameCategoryRelated.slice(0, 4);
  if (related.length < 4) {
    const usedIds = new Set([tool.id, ...related.map((t) => t.id)]);
    const fallback = tools.filter(
      (t) => t.featured && isRecommendable(t) && !usedIds.has(t.id)
    );
    related.push(...fallback.slice(0, 4 - related.length));
  }
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
        {isAvailable && serverPlan ? (
          <ToolAccessGate
            toolId={tool.id}
            requiredPlan={tool.requiredPlan}
            plan={serverPlan.plan}
            isAuthenticated={serverPlan.userId !== null}
            temporaryAccessActive={serverPlan.temporaryAccessActive}
            temporaryAccessExpiresAtMs={serverPlan.temporaryAccessExpiresAtMs}
          >
            <ToolImplementation toolId={tool.id} />
          </ToolAccessGate>
        ) : (
          <ComingSoon tool={tool} />
        )}
      </div>

      <div className="mt-6">
        <AdSlot placement="tool-page" />
      </div>

      {related.length > 0 && (
        <div className="mt-12">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-white">
            {related.length <= sameCategoryRelated.length
              ? `${category?.name}の他のツール`
              : "こちらのツールもおすすめです"}
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
