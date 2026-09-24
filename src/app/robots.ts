import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/config/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // アカウント情報（メールアドレス・契約状況等）を含む個人ページは
      // 検索エンジンに公開しない（ページ側でも robots: noindex を設定済み）。
      disallow: ["/account"],
    },
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
