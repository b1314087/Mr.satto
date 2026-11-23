import { test as plainTest, expect } from "@playwright/test";
import { test } from "../fixtures/premium-test";
import { articleCharCount, articles, articlesForTool, getArticle, tableOfContents, toolsInArticle } from "@/lib/articles";
import { getToolById } from "@/lib/tools/data";

/** 使い方ガイド（記事）のテスト（2026-11-23） */

plainTest.describe("使い方ガイド：記事のデータ", () => {
  plainTest("記事は20本以上。URL・見出しの目印は重ならず、形が正しい", () => {
    expect(articles.length).toBeGreaterThanOrEqual(20);
    const slugs = articles.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const a of articles) {
      expect(a.slug, a.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const ids = tableOfContents(a).map((t) => t.id);
      expect(new Set(ids).size, a.slug).toBe(ids.length);
      for (const id of ids) expect(id, `${a.slug} ${id}`).toMatch(/^[a-z0-9-]+$/);
      expect(a.publishedAt, a.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.updatedAt >= a.publishedAt, a.slug).toBe(true);
    }
  });

  plainTest("どの記事も、読み物として十分な分量（2,000字以上）と、見出し4つ以上がある", () => {
    for (const a of articles) {
      expect(articleCharCount(a), a.slug).toBeGreaterThanOrEqual(2000);
      expect(tableOfContents(a).length, a.slug).toBeGreaterThanOrEqual(4);
      expect(a.description.length, a.slug).toBeGreaterThanOrEqual(60);
      expect(a.description.length, a.slug).toBeLessThanOrEqual(160);
    }
  });

  plainTest("記事で案内するツールは、すべて実在して公開中。ほかの記事への案内も実在する", () => {
    for (const a of articles) {
      for (const id of toolsInArticle(a)) {
        const tool = getToolById(id);
        expect(tool, `${a.slug} → ${id}`).toBeTruthy();
        expect(tool?.status, `${a.slug} → ${id}`).toBe("available");
      }
      for (const b of a.blocks) if (b.t === "guide") expect(getArticle(b.slug), `${a.slug} → ${b.slug}`).toBeTruthy();
    }
    expect(articlesForTool("cover-letter").map((a) => a.slug)).toContain("cover-letter-how-to-write");
  });

  plainTest("記事の中に、HTMLのタグや、作りかけの印（TODO・未定）が混ざっていない", () => {
    for (const a of articles) {
      const text = JSON.stringify(a);
      expect(text, a.slug).not.toMatch(/<[a-z][^>]*>/i);
      expect(text, a.slug).not.toMatch(/TODO|TBD|未定|ダミー/);
    }
  });
});

test.describe("使い方ガイド：画面", () => {
  test("一覧：すべての記事が並び、分野ごとの見出しがある", async ({ page }) => {
    await page.goto("/guides");
    await expect(page.getByRole("heading", { level: 1, name: "使い方ガイド" })).toBeVisible();
    await expect(page.getByTestId("guide-card")).toHaveCount(articles.length);
    await expect(page.getByRole("heading", { level: 2, name: "PDF" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "動画・音声" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "安全・プライバシー" })).toBeVisible();
  });

  test("記事：見出し・目次・本文・ツールへの案内・構造化データがあり、ツールのページへ進める", async ({ page }) => {
    const a = getArticle("cover-letter-how-to-write")!;
    await page.goto(`/guides/${a.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(a.title);
    await expect(page.getByTestId("guide-toc").getByRole("link")).toHaveCount(tableOfContents(a).length);
    await expect(page.getByTestId("article-body")).toContainText("「様」と「御中」の使い分け");
    // 例文が、改行どおりに見える
    await expect(page.locator("pre").first()).toContainText("書類送付のご案内");
    // 構造化データ（Article）
    const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(jsonLd.some((t) => t.includes('"@type":"Article"') && t.includes(a.title))).toBe(true);
    // 目次から、その見出しへ移れる
    await page.getByTestId("guide-toc").getByRole("link", { name: "例文：FAX送付状" }).click();
    await expect(page).toHaveURL(/#example-fax$/);
    // ツールの案内カードから、ツールのページへ進める
    await page.locator('[data-testid="article-tool-card"][data-tool-id="cover-letter"]').first().click();
    await expect(page).toHaveURL(/\/tools\/cover-letter$/);
  });

  test("ないアドレスは「見つかりません」", async ({ page }) => {
    const res = await page.goto("/guides/no-such-article");
    expect(res?.status()).toBe(404);
  });

  test("ツールのページに「関連する使い方ガイド」が出て、記事へ進める", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const box = page.getByTestId("tool-related-guides");
    await expect(box).toBeVisible();
    await box.getByRole("link", { name: /PDFが重いときに容量を小さくする方法/ }).click();
    await expect(page).toHaveURL(/\/guides\/pdf-compress-tips$/);
  });

  test("トップ・フッター・サイトマップ・運営者情報から、ガイドにたどり着ける", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.getByTestId("home-guides").getByRole("link")).toHaveCount(5); // 記事4つ＋「すべてのガイド」
    await expect(page.locator("footer").getByRole("link", { name: "使い方ガイド" })).toBeVisible();
    const sitemap = await (await request.get("/sitemap.xml")).text();
    expect(sitemap).toContain("/guides</loc>");
    for (const a of articles) expect(sitemap).toContain(`/guides/${a.slug}</loc>`);
    await page.goto("/about");
    await expect(page.getByTestId("about-operator")).toContainText("運営事務局");
    await expect(page.getByTestId("about-operator")).toContainText("お問い合わせ");
  });
});
