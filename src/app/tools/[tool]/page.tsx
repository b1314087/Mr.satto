import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { tools, getToolById, getToolsByCategory } from "@/lib/tools/data";
import { categories, getCategory } from "@/lib/tools/categories";
import { CategoryBadge } from "@/components/tools/category-badge";
import { ComingSoon } from "@/components/tools/coming-soon";
import { ToolImplementation } from "@/components/tools/tool-registry";
import { ToolAccessGate } from "@/components/tools/tool-access-gate";
import { hasImplementation } from "@/lib/tools/registry";
import { ToolCard } from "@/components/tools/tool-card";
import { AdSlot } from "@/components/ads/ad-slot";
import { getServerPlan } from "@/lib/plans/current-plan";
import { Breadcrumb } from "@/components/tools/breadcrumb";
import { CategoryLanding } from "@/components/tools/category-landing";
import { ToolHowTo } from "@/components/tools/tool-how-to";
import { ToolFaq } from "@/components/tools/tool-faq";
import { JsonLd } from "@/components/seo/json-ld";
import { buildBreadcrumbList, buildFaqPage } from "@/lib/seo/structured-data";
import { getToolSeoContent } from "@/lib/seo/tool-content";
import { getCategorySeoContent } from "@/lib/seo/category-content";
import { siteConfig } from "@/lib/config/site";

interface ToolPageProps {
  params: Promise<{ tool: string }>;
}

/**
 * このルートは「/tools/[tool]」1つで、ツール詳細ページとカテゴリ一覧ページの
 * 両方を担う（Phase 5）。Next.jsは同じ階層に異なる名前の動的セグメント
 * （例: [tool] と [category]）を共存させられないため、既存の[tool]セグメントを
 * そのまま使い、値がカテゴリIDと一致するかどうかで内部的に分岐する。
 * カテゴリIDとツールIDは重複しない（カテゴリIDは image/pdf/file/csv-excel/
 * student/work/creator/other の8種のみで、ツールIDは全て "image-resize" のような
 * 複合語のため衝突しない）。
 */
function findCategoryByParam(param: string) {
  return categories.find((c) => c.id === param);
}

export function generateStaticParams() {
  return [...categories.map((c) => ({ tool: c.id })), ...tools.map((tool) => ({ tool: tool.id }))];
}

export async function generateMetadata({ params }: ToolPageProps): Promise<Metadata> {
  const { tool: param } = await params;

  const category = findCategoryByParam(param);
  if (category) {
    const content = getCategorySeoContent(category.id);
    return {
      title: content.metaTitle,
      description: content.metaDescription,
      alternates: {
        canonical: `/tools/${category.id}`,
      },
      openGraph: {
        type: "website",
        locale: siteConfig.locale,
        siteName: siteConfig.name,
        title: `${content.metaTitle}｜${siteConfig.name}`,
        description: content.metaDescription,
      },
      twitter: {
        card: "summary_large_image",
        title: `${content.metaTitle}｜${siteConfig.name}`,
        description: content.metaDescription,
      },
    };
  }

  const tool = getToolById(param);
  if (!tool) return {};

  const seo = getToolSeoContent(tool.id);
  const title = seo?.metaTitle ?? tool.name;
  const description = seo?.metaDescription ?? tool.description;

  return {
    title,
    description,
    alternates: {
      canonical: `/tools/${tool.id}`,
    },
    openGraph: {
      type: "website",
      locale: siteConfig.locale,
      siteName: siteConfig.name,
      title: `${title}｜${siteConfig.name}`,
      description,
    },
    twitter: {
      card: "summary_large_image",
      title: `${title}｜${siteConfig.name}`,
      description,
    },
    // 準備中のツールは内容が薄い仮ページのため、検索結果には出さない
    // （sitemapからも除外済み。ページ自体は404にはしない）。
    ...(tool.status === "coming-soon" ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function ToolPage({ params }: ToolPageProps) {
  const { tool: param } = await params;

  const category = findCategoryByParam(param);
  if (category) {
    const content = getCategorySeoContent(category.id);
    const categoryTools = getToolsByCategory(category.id);
    const availableTools = categoryTools.filter((t) => t.status === "available" && hasImplementation(t.id));
    const comingSoonTools = categoryTools.filter((t) => t.status === "coming-soon");
    const breadcrumbItems = [
      { name: "トップ", path: "/" },
      { name: `${category.name}ツール`, path: `/tools/${category.id}` },
    ];

    return (
      <>
        <JsonLd data={buildBreadcrumbList(breadcrumbItems)} />
        <div className="mx-auto w-full max-w-4xl px-4 pt-6 sm:px-6">
          <Breadcrumb items={breadcrumbItems} />
        </div>
        <CategoryLanding
          category={category}
          intro={content.intro}
          availableTools={availableTools}
          comingSoonTools={comingSoonTools}
        />
      </>
    );
  }

  const tool = getToolById(param);
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
  const toolCategory = getCategory(tool.category);
  const seo = isAvailable ? getToolSeoContent(tool.id) : undefined;

  const breadcrumbItems = [
    { name: "トップ", path: "/" },
    ...(toolCategory ? [{ name: `${toolCategory.name}ツール`, path: `/tools/${toolCategory.id}` }] : []),
    { name: tool.name, path: `/tools/${tool.id}` },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
      <JsonLd data={buildBreadcrumbList(breadcrumbItems)} />
      {seo && seo.faq.length > 0 && <JsonLd data={buildFaqPage(seo.faq)} />}

      <Breadcrumb items={breadcrumbItems} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-2xl" aria-hidden="true">
              {toolCategory?.icon}
            </span>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">{tool.name}</h1>
          </div>
          <p className="text-neutral-600 dark:text-neutral-300">{seo?.lead ?? tool.description}</p>
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

      {seo && <ToolHowTo steps={seo.howTo} />}
      {seo && <ToolFaq items={seo.faq} />}

      {related.length > 0 && (
        <div className="mt-12">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900 dark:text-white">
            {related.length <= sameCategoryRelated.length
              ? `${toolCategory?.name}の他のツール`
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
