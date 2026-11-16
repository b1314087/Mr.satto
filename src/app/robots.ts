import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/config/site";

export default function robots(): MetadataRoute.Robots {
  // プレビュー（Vercelの確認用のアドレス）は、検索エンジンに一切載せない（本番は mrsatto.com だけを載せる）
  if (process.env.VERCEL_ENV === "preview") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // アカウント情報（メールアドレス・契約状況等）を含む個人ページと、
      // ページとして提供していないAPIルート（Stripe連携等）は
      // 検索エンジンに公開しない（/accountはページ側でも robots: noindex を設定済み）。
      disallow: ["/account", "/api"],
    },
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
