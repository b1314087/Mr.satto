import { test, expect } from "@playwright/test";
import { siteConfig } from "@/lib/config/site";
import { tools } from "@/lib/tools/data";

/**
 * SEO回帰テスト（Phase 14）。
 *
 * Phase 12（Mr.Sattoブランドシグナル強化）で追加したWebSite/Organization構造化データや
 * ブランド名の一貫性が、以後の変更で壊れていないことを検知するためのテスト。
 * 検索順位や掲載可否そのものは保証できないため、ここでは
 * 「意図した構造化データ・メタ情報がレンダリングされ続けているか」のみを確認する。
 */

interface JsonLdBlock {
  "@type"?: string;
  name?: string;
  url?: string;
  alternateName?: string[];
  [key: string]: unknown;
}

function getJsonLdBlocks(html: string): JsonLdBlock[] {
  const blocks: JsonLdBlock[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch {
      // 壊れたJSON-LDはテスト側で無視せず、後続のassertionで検出されるようにする。
    }
  }
  return blocks;
}

test.describe("ホームページ SEO回帰", () => {
  test("title / H1 / description / canonical / og:site_nameが期待どおり", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(new RegExp(siteConfig.name));

    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible();

    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description).toBeTruthy();

    const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonicalHref === siteConfig.url || canonicalHref === `${siteConfig.url}/`).toBeTruthy();

    const ogSiteName = await page.locator('meta[property="og:site_name"]').getAttribute("content");
    expect(ogSiteName).toBe(siteConfig.name);
  });

  test("WebSite構造化データにMr.Sattoのブランド情報が含まれる（Phase 12）", async ({ page }) => {
    await page.goto("/");
    const html = await page.content();
    const blocks = getJsonLdBlocks(html);

    const website = blocks.find((b) => b["@type"] === "WebSite");
    expect(website, "WebSiteのJSON-LDが見つかりません").toBeTruthy();
    expect(website!.name).toBe(siteConfig.name);
    expect(website!.url === siteConfig.url || website!.url === `${siteConfig.url}/`).toBeTruthy();
    expect(Array.isArray(website!.alternateName)).toBe(true);
    expect(website!.alternateName).toContain(siteConfig.name);
  });

  test("Organization構造化データが存在する（Phase 12）", async ({ page }) => {
    await page.goto("/");
    const html = await page.content();
    const blocks = getJsonLdBlocks(html);

    const org = blocks.find((b) => b["@type"] === "Organization");
    expect(org, "OrganizationのJSON-LDが見つかりません").toBeTruthy();
    expect(org!.name).toBe(siteConfig.name);
    expect(org!.url === siteConfig.url || org!.url === `${siteConfig.url}/`).toBeTruthy();
  });
});

test.describe("robots.txt / sitemap.xml 回帰", () => {
  test("robots.txtがsitemapを参照し、/api と /account を除外している", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/robots.txt`);
    const body = await res.text();
    expect(body).toContain(`Sitemap: ${siteConfig.url}/sitemap.xml`);
    expect(body).toMatch(/Disallow:\s*\/api/);
    expect(body).toMatch(/Disallow:\s*\/account/);
  });

  test("sitemap.xmlに利用可能なツールのURLが含まれ、coming-soonツールは除外されている", async ({
    request,
    baseURL,
  }) => {
    const res = await request.get(`${baseURL}/sitemap.xml`);
    const body = await res.text();

    const availableTool = tools.find((t) => t.status === "available");
    expect(availableTool, "status=availableなツールが1件も存在しません").toBeTruthy();
    if (availableTool) {
      expect(body).toContain(`${siteConfig.url}/tools/${availableTool.id}`);
    }

    const comingSoonTool = tools.find((t) => t.status === "coming-soon");
    if (comingSoonTool) {
      expect(body).not.toContain(`${siteConfig.url}/tools/${comingSoonTool.id}<`);
    }
  });
});
