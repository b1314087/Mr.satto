import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { tools, getToolById, getToolsByCategory, getMergedTools, isListedTool } from "@/lib/tools/data";
import { categories, getCategory } from "@/lib/tools/categories";
import { CategoryBadge } from "@/components/tools/category-badge";
import { CategoryIcon } from "@/components/ui/category-icon";
import { ComingSoon } from "@/components/tools/coming-soon";
import { ToolImplementation } from "@/components/tools/tool-registry";
import { ToolAccessGate } from "@/components/tools/tool-access-gate";
import { MergedToolsNav } from "@/components/tools/merged-tools-nav";
import { hasImplementation } from "@/lib/tools/registry";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { ToolCard } from "@/components/tools/tool-card";
import { AdSlot } from "@/components/ads/ad-slot";
import { getServerPlan } from "@/lib/plans/current-plan";
import { shouldShowAds } from "@/lib/plans/access";
import { CurrentPlanProvider } from "@/lib/plans/plan-context";
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
 * Phase 11: 汎用<ToolAccessGate>をバイパスし、ツール自身が専用のServer Actionsで
 * 利用可否を判定するツールID。将来同種のツールが増えた場合はここに追記する
 * （複数箇所に同じ判定を分散させないための唯一の定義箇所）。
 */
const BYPASS_ACCESS_GATE_TOOL_ID = "filled-pdf-to-excel";

/**
 * このルートは「/tools/[tool]」1つで、ツール詳細ページとカテゴリ一覧ページの
 * 両方を担う（Phase 5）。Next.jsは同じ階層に異なる名前の動的セグメント
 * （例: [tool] と [category]）を共存させられないため、既存の[tool]セグメントを
 * そのまま使い、値がカテゴリIDと一致するかどうかで内部的に分岐する。
 * カテゴリIDとツールIDは重複しない（カテゴリIDは image/pdf/csv-excel/word/
 * video/file/generator/other の8種のみで、ツールIDは全て "image-resize" のような
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
    const availableTools = categoryTools.filter((t) => t.status === "available" && hasImplementation(t.id) && isListedTool(t));
    const comingSoonTools = categoryTools.filter((t) => t.status === "coming-soon");
    const breadcrumbItems = [
      { name: "トップ", path: "/" },
      { name: `${category.name}ツール`, path: `/tools/${category.id}` },
    ];

    return (
      <>
        <JsonLd data={buildBreadcrumbList(breadcrumbItems)} />
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
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
  // Phase 21: 選定ロジックは src/lib/tools/related-tools.ts に切り出し済み
  // （同カテゴリの円環選定により、宣言順で後方のツールが関連ツールに一切
  // 出てこなくなる孤立ページ問題を解消。詳細は同ファイルのコメント参照。
  // ページ側とテスト側の両方から同じロジックを参照する）。
  const { related, sameCategoryCandidateCount } = getRelatedTools(tool);
  const toolCategory = getCategory(tool.category);
  // 総合ツールとその統合済みツール（個別URLを維持している旧ツール）は、互いのページへリンクする
  const mergedHub = tool.mergedInto ? getToolById(tool.mergedInto) : getMergedTools(tool.id).length > 0 ? tool : undefined;
  const mergedMembers = mergedHub ? getMergedTools(mergedHub.id) : [];
  const seo = isAvailable ? getToolSeoContent(tool.id) : undefined;

  const breadcrumbItems = [
    { name: "トップ", path: "/" },
    ...(toolCategory ? [{ name: `${toolCategory.name}ツール`, path: `/tools/${toolCategory.id}` }] : []),
    { name: tool.name, path: `/tools/${tool.id}` },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:has-[[data-preview-split]]:max-w-6xl">
      <JsonLd data={buildBreadcrumbList(breadcrumbItems)} />
      {seo && seo.faq.length > 0 && <JsonLd data={buildFaqPage(seo.faq)} />}

      <Breadcrumb items={breadcrumbItems} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-2 flex items-center gap-3">
            <CategoryIcon id={tool.category} size="lg" />
            <h1 className="text-2xl font-bold text-ms-text">{tool.name}</h1>
          </div>
          <p className="text-ms-muted">{seo?.lead ?? tool.description}</p>
        </div>
        <CategoryBadge category={tool.category} />
      </div>

      <div className="ms-tool-panel p-4 sm:p-6">
        {isAvailable && serverPlan && tool.id === BYPASS_ACCESS_GATE_TOOL_ID ? (
          // Phase 11: 記入済みPDF→Excelは、Free「1ページごとに広告視聴必須・
          // 利用回数無制限」/Standard「広告なし・1回1ページ・利用回数無制限」/
          // Premium「ページ数・回数とも無制限」という、ツール専用・ページ数ベースの
          // 利用制限を持ち、既存の汎用<ToolAccessGate>（Standard対象ツール全体・
          // 1時間の広告ゲート）とは条件が根本的に異なる（2026年改訂で日次回数上限は
          // Free・Standardとも撤廃済み。詳細は src/lib/tools/filled-pdf-to-excel/
          // usage-status-actions.ts 参照）。
          // そのためこのツールIDのみゲートをバイパスし、ツール自身が
          // src/lib/tools/filled-pdf-to-excel/ 配下のServer Actionsを直接呼び出して
          // 利用可否を判定する（詳細は同ディレクトリ内の各ファイルのコメント参照）。
          // （serverPlanは isAvailable のときのみ非nullだが、TypeScriptの型上は
          //   ここで明示的にチェックしておく必要がある）
          <CurrentPlanProvider plan={serverPlan.plan}>
            <ToolImplementation toolId={tool.id} />
          </CurrentPlanProvider>
        ) : isAvailable && serverPlan ? (
          <CurrentPlanProvider plan={serverPlan.plan}>
            <ToolAccessGate
              toolId={tool.id}
              requiredPlan={tool.requiredPlan}
              plan={serverPlan.plan}
              temporaryAccessActive={serverPlan.temporaryAccessActive}
              temporaryAccessExpiresAtMs={serverPlan.temporaryAccessExpiresAtMs}
            >
              <ToolImplementation toolId={tool.id} />
            </ToolAccessGate>
          </CurrentPlanProvider>
        ) : (
          <ComingSoon tool={tool} />
        )}
      </div>

      {isAvailable && mergedHub && <MergedToolsNav hub={mergedHub} members={mergedMembers} currentId={tool.id} />}

      {isAvailable && (
        <p className="mt-3 text-xs text-ms-muted">
          お問い合わせ、不具合の報告、機能改善のご提案は
          <a
            href={siteConfig.contactFormUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mx-1 text-ms-accent hover:underline dark:text-ms-focus"
          >
            お問い合わせフォーム
            <span aria-hidden="true"> ↗</span>
            <span className="sr-only">（Googleフォーム・新しいタブで開きます）</span>
          </a>
          から送信できます。
        </p>
      )}

      {/* Phase 20: Standard/Premium（広告なし）と分かっている場合は、ツール本体の
          下の通常広告枠も出さない。「広告なし」の説明とページ内の実際の表示が
          矛盾しないようにするため（開発指示書2章・10章）。プラン不明（準備中
          ツールなどでgetServerPlan()を呼んでいない場合）は従来どおり表示する。 */}
      {(serverPlan === null || shouldShowAds(serverPlan.plan)) && (
        <div className="mt-6">
          <AdSlot placement="tool-page" />
        </div>
      )}

      {seo && <ToolHowTo steps={seo.howTo} />}
      {seo && <ToolFaq items={seo.faq} />}

      {related.length > 0 && (
        <div className="mt-12">
          <h2 className="mb-4 text-lg font-semibold text-ms-text">
            {related.length <= sameCategoryCandidateCount
              ? `${toolCategory?.name}の他のツール`
              : "こちらのツールもおすすめです"}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((t) => (
              <ToolCard key={t.id} tool={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
