import { siteConfig } from "@/lib/config/site";
import type { ToolFaqItem } from "@/lib/seo/tool-content";

/**
 * JSON-LD（構造化データ）の組み立て（Phase 5）。
 *
 * Googleの現行のガイドラインに沿って、過剰・無関係なスキーマは付けない
 * （実際にページ上に表示されている内容とだけ一致させる）。
 * パンくずリストは、画面に表示しているパンくずUIと必ず同じitemsから
 * 生成し、表示と構造化データがズレないようにする。
 */

export interface BreadcrumbItem {
  name: string;
  path: string; // "/" から始まる相対パス
}

export function buildBreadcrumbList(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${siteConfig.url}${item.path}`,
    })),
  };
}

export function buildFaqPage(items: ToolFaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

export function buildWebSite() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.description,
    inLanguage: "ja",
  };
}

export function buildWebApplication() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.description,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "JPY",
      description: "広告視聴による15分間の無料利用、またはStandard/Premiumプランへの加入で利用できます。",
    },
    inLanguage: "ja",
  };
}
