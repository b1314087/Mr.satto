import { test, expect } from "@playwright/test";
import { siteConfig } from "@/lib/config/site";
import { tools } from "@/lib/tools/data";
import { categories } from "@/lib/tools/categories";
import { AVAILABLE_TOOL_IDS, hasImplementation } from "@/lib/tools/registry";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { toolSeoContent } from "@/lib/seo/tool-content";
import sitemap from "@/app/sitemap";

/**
 * Phase 21 SEOテスト（SEO・Search Consoleデータ活用基盤強化）。
 *
 * 開発指示書32章で指定された最小限のテスト対象（メタデータ・sitemap・
 * 構造化データ・robots・内部リンク・代表ページ）を、既存のtests/seo/
 * seo-regression.spec.ts（Phase 14・ホームページ/WebSite/Organization/
 * robots/sitemap）と重複しない範囲でカバーする。
 *
 * 代表ページ: Home, /tools, 画像/PDF/CSV・Excel/動画の各カテゴリページ、
 * filled-pdf-to-excel, pdf-fill-annotate, electronic-stamp-generator, pricing。
 */

const REPRESENTATIVE_CATEGORY_PAGES = ["image", "pdf", "csv-excel", "video"] as const;
const REPRESENTATIVE_TOOL_PAGES = ["filled-pdf-to-excel", "pdf-fill-annotate", "electronic-stamp-generator"] as const;

interface JsonLdBlock {
  "@type"?: string;
  itemListElement?: { name?: string; item?: string; position?: number }[];
  mainEntity?: unknown[];
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
      // 壊れたJSON-LDは後続のassertionで検出する
    }
  }
  return blocks;
}

test.describe("Phase 21: Tool Registryとtool-content.tsの整合性", () => {
  test("利用可能な全ツールにSEOコンテンツ(tool-content.ts)が存在し、逆に余分な定義もない", () => {
    const contentIds = Object.keys(toolSeoContent).sort();
    const registryIds = [...AVAILABLE_TOOL_IDS].sort();
    expect(contentIds).toEqual(registryIds);
  });

  test("関連ツールの円環選定で、既知の1件(pomodoro-timer)を除き孤立するツールが存在しない", () => {
    const available = tools.filter((t) => t.status === "available" && hasImplementation(t.id));
    const linkedFrom = new Map<string, Set<string>>();
    for (const t of available) linkedFrom.set(t.id, new Set());

    for (const tool of available) {
      const { related } = getRelatedTools(tool);
      for (const r of related) linkedFrom.get(r.id)?.add(tool.id);
    }

    const orphans = available.filter((t) => (linkedFrom.get(t.id)?.size ?? 0) === 0).map((t) => t.id);

    // pomodoro-timer（学生向けカテゴリで唯一のツール）は、関連ツールウィジェットには
    // 出てこないが、featured:true としてホームページの「おすすめツール」から
    // 既にリンクされているため、内部リンク上は孤立していない既知の残存ケース。
    // これ以外のツールが新たに孤立した場合はこのテストが失敗する。
    // (学生向けカテゴリのツールが増えると pomodoro-timer も関連ツールとして選ばれ、孤立しなくなる)
    expect(orphans.filter((id) => id !== "pomodoro-timer")).toEqual([]);
  });
});

test.describe("Phase 21: Sitemap", () => {
  test("カテゴリページ(ハブ)のpriorityが個別ツールページ以上になっている", () => {
    const entries = sitemap();
    const categoryPriorities = entries
      .filter((e) => categories.some((c) => e.url === `${siteConfig.url}/tools/${c.id}`))
      .map((e) => e.priority ?? 0);
    const toolPriorities = entries
      .filter((e) => tools.some((t) => t.status === "available" && e.url === `${siteConfig.url}/tools/${t.id}`))
      .map((e) => e.priority ?? 0);

    expect(categoryPriorities.length).toBe(categories.length);
    expect(toolPriorities.length).toBe(AVAILABLE_TOOL_IDS.length);
    const minCategoryPriority = Math.min(...categoryPriorities);
    const maxToolPriority = Math.max(...toolPriorities);
    expect(minCategoryPriority).toBeGreaterThanOrEqual(maxToolPriority);
  });

  test("sitemapに重複URLが存在しない", () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("coming-soonツールのURLが1件も含まれない", () => {
    const entries = sitemap();
    const urls = new Set(entries.map((e) => e.url));
    const comingSoonTools = tools.filter((t) => t.status === "coming-soon");
    for (const t of comingSoonTools) {
      expect(urls.has(`${siteConfig.url}/tools/${t.id}`)).toBe(false);
    }
  });
});

test.describe("Phase 21: 代表ページのメタデータ・canonical", () => {
  const pages: { path: string; label: string }[] = [
    { path: "/", label: "Home" },
    { path: "/tools", label: "Tools" },
    ...REPRESENTATIVE_CATEGORY_PAGES.map((id) => ({ path: `/tools/${id}`, label: `category:${id}` })),
    ...REPRESENTATIVE_TOOL_PAGES.map((id) => ({ path: `/tools/${id}`, label: `tool:${id}` })),
    { path: "/pricing", label: "Pricing" },
  ];

  for (const { path, label } of pages) {
    test(`${label} (${path}): H1が1つ・descriptionあり・canonicalが自ページを指す`, async ({ page }) => {
      await page.goto(path);

      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toBeVisible();

      const description = await page.locator('meta[name="description"]').getAttribute("content");
      expect(description, `${path} の meta description が空です`).toBeTruthy();

      const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute("href");
      const expected = path === "/" ? [siteConfig.url, `${siteConfig.url}/`] : [`${siteConfig.url}${path}`];
      expect(expected).toContain(canonicalHref);

      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
    });
  }

  test("/tools?q=... でもcanonicalは素の/toolsを指す(検索クエリでの重複URL化を防止)", async ({ page }) => {
    await page.goto("/tools?q=%E7%94%BB%E5%83%8F");
    const canonicalHref = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonicalHref).toBe(`${siteConfig.url}/tools`);
  });
});

test.describe("Phase 21: 構造化データ(BreadcrumbList / FAQPage)が画面表示と一致する", () => {
  for (const categoryId of REPRESENTATIVE_CATEGORY_PAGES) {
    test(`カテゴリページ /tools/${categoryId}: BreadcrumbListが画面のパンくずと一致する`, async ({ page }) => {
      await page.goto(`/tools/${categoryId}`);
      const html = await page.content();
      const breadcrumbList = getJsonLdBlocks(html).find((b) => b["@type"] === "BreadcrumbList");
      expect(breadcrumbList, "BreadcrumbListのJSON-LDが見つかりません").toBeTruthy();

      const visibleCrumbs = await page.locator('nav[aria-label="パンくずリスト"] >> :scope').innerText();
      const jsonLdNames = (breadcrumbList!.itemListElement ?? []).map((i) => i.name);
      for (const name of jsonLdNames) {
        expect(visibleCrumbs).toContain(name as string);
      }
    });
  }

  for (const toolId of REPRESENTATIVE_TOOL_PAGES) {
    test(`ツールページ /tools/${toolId}: BreadcrumbList・FAQPage(存在する場合)が画面表示と一致する`, async ({
      page,
    }) => {
      await page.goto(`/tools/${toolId}`);
      const html = await page.content();
      const blocks = getJsonLdBlocks(html);

      const breadcrumbList = blocks.find((b) => b["@type"] === "BreadcrumbList");
      expect(breadcrumbList, "BreadcrumbListのJSON-LDが見つかりません").toBeTruthy();
      const visibleCrumbs = await page.locator('nav[aria-label="パンくずリスト"] >> :scope').innerText();
      for (const item of breadcrumbList!.itemListElement ?? []) {
        expect(visibleCrumbs).toContain(item.name as string);
      }

      const seo = toolSeoContent[toolId as keyof typeof toolSeoContent];
      const faqPage = blocks.find((b) => b["@type"] === "FAQPage");
      if (seo && seo.faq.length > 0) {
        expect(faqPage, `${toolId} はFAQを持つはずですが、FAQPageのJSON-LDが見つかりません`).toBeTruthy();
        await expect(page.getByRole("heading", { name: "よくある質問" })).toBeVisible();
      } else {
        expect(faqPage).toBeFalsy();
      }
    });
  }
});

test.describe("Phase 21: 内部リンク(関連ツール・カテゴリ導線)", () => {
  for (const toolId of REPRESENTATIVE_TOOL_PAGES) {
    test(`/tools/${toolId}: 関連ツールセクションが表示され、別ツールへのリンクを含む`, async ({ page }) => {
      await page.goto(`/tools/${toolId}`);
      const relatedHeading = page.getByRole("heading", { name: /他のツール|おすすめです/ });
      await expect(relatedHeading).toBeVisible();

      const relatedLinks = page.locator('main a[href^="/tools/"]');
      expect(await relatedLinks.count()).toBeGreaterThan(0);
    });
  }

  test("pdf-fill-annotate(以前は関連ツールに一切出てこなかったツール)が、実際にいずれかのPDFツールページからリンクされる", async ({
    page,
  }) => {
    // Phase 21で修正した円環選定ロジックを使い、pdf-fill-annotateを関連ツールとして
    // 表示するはずのツールを実データから特定し、実際にブラウザで確認する
    // （ハードコードした特定のツールIDに依存せず、データが変わっても追従する）。
    const available = tools.filter((t) => t.status === "available" && hasImplementation(t.id));
    const host = available.find((t) => getRelatedTools(t).related.some((r) => r.id === "pdf-fill-annotate"));
    expect(host, "pdf-fill-annotateを関連ツールに含むツールが見つかりません").toBeTruthy();

    await page.goto(`/tools/${host!.id}`);
    await expect(page.locator('a[href="/tools/pdf-fill-annotate"]')).toBeVisible();
  });

  for (const categoryId of REPRESENTATIVE_CATEGORY_PAGES) {
    test(`カテゴリページ /tools/${categoryId} から、掲載されている利用可能なツールへ実際に遷移できる`, async ({
      page,
    }) => {
      await page.goto(`/tools/${categoryId}`);
      const firstToolLink = page.locator('main a[href^="/tools/"]').first();
      await expect(firstToolLink).toBeVisible();
      const href = await firstToolLink.getAttribute("href");
      expect(href).toBeTruthy();
    });
  }
});

test.describe("Phase 21: OGP画像(ページ固有の動的生成)", () => {
  const ogPages = [
    { path: "/", label: "Home" },
    { path: "/tools/pdf", label: "category:pdf" },
    { path: "/tools/pdf-fill-annotate", label: "tool:pdf-fill-annotate" },
  ];

  for (const { path, label } of ogPages) {
    test(`${label}: og:imageが実際に画像として取得できる`, async ({ page, request }) => {
      await page.goto(path);
      const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
      expect(ogImage, `${path} にog:imageがありません`).toBeTruthy();

      const res = await request.get(ogImage!);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("image/png");
    });
  }
});
