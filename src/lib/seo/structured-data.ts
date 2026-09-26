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

/**
 * ホームページ末尾の "/" を除いたホスト名（例: "mrmatto.vercel.app"）。
 * WebSiteのalternateNameで、ブランド名(Mr.Satto)を第一候補としつつ、
 * 実際のVercelドメインも代替名として補助的に示すために使う（Phase 12）。
 */
function getSiteHost(): string {
  try {
    return new URL(siteConfig.url).host;
  } catch {
    return siteConfig.url;
  }
}

export function buildWebSite() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    // GoogleがサイトのブランドをMr.Sattoとして認識しやすくするための代替名。
    // ブランド名(Mr.Satto)を第一候補にし、現在のVercelドメインは補助的な代替名として並べる
    // (Phase 12)。架空の別名は追加しない。
    alternateName: [siteConfig.name, getSiteHost()],
    url: `${siteConfig.url}/`,
    description: siteConfig.description,
    inLanguage: "ja",
  };
}

/**
 * サイト・サービスの運営主体としてのOrganization構造化データ（Phase 12）。
 *
 * 実在しない会社名・住所・電話番号・SNSアカウント・レビュー等は一切含めない。
 * サイト上に実際に存在する情報（サービス名・公開URL）のみを記載する。
 * ロゴ画像についても、専用のロゴ画像アセットが存在しないため含めない
 * （将来、実際のロゴ画像を追加した場合にlogoフィールドを追加する）。
 */
export function buildOrganization() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: `${siteConfig.url}/`,
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
