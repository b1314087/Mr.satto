import { test, expect } from "@playwright/test";
import { getListedTools, getToolById, tools } from "@/lib/tools/data";
import { hasImplementation } from "@/lib/tools/registry";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { CATEGORY_CROSS_LINKS, POPULAR_TOOL_IDS } from "@/lib/tools/internal-links";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { getToolSeoContent } from "@/lib/seo/tool-content";

/**
 * 内部リンク・検索導線改善の工程のテスト。
 *  1. トップページの「よく使われるツール」（文字のリンク）
 *  2. カテゴリページの「機能ごとのページ」（総合ツールにまとめた機能の個別URL）と「ほかのカテゴリにある関連ツール」
 *  3. PDF→Excel・PDF→Word・PDF編集・画像圧縮の関連ツール
 *  4. どのリンクも、普通の <a href> で、正しいURL（末尾の / なし・nofollow なし）を指し、開くと200
 *  5. PDF→Excel・PDF→Word の説明文
 */

const usableListed = (id: string) => {
  const t = getToolById(id);
  return !!t && t.status === "available" && hasImplementation(t.id) && !t.mergedInto && getListedTools().some((x) => x.id === id);
};

test.describe("トップページの「よく使われるツール」", () => {
  test("設定のツールはすべて、一覧・検索に出る使えるツールで、重複がない", () => {
    expect(POPULAR_TOOL_IDS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(POPULAR_TOOL_IDS).size).toBe(POPULAR_TOOL_IDS.length);
    for (const id of POPULAR_TOOL_IDS) expect(usableListed(id), id).toBe(true);
  });

  test("カテゴリの下に、設定どおりの順で普通のリンクとして並ぶ（カードではない）", async ({ page }) => {
    await page.goto("/");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "よく使われるツール" }) });
    await expect(section).toBeVisible();
    const links = section.locator("a");
    await expect(links).toHaveCount(POPULAR_TOOL_IDS.length);
    for (const [i, id] of POPULAR_TOOL_IDS.entries()) {
      await expect(links.nth(i)).toHaveAttribute("href", `/tools/${id}`);
      await expect(links.nth(i)).toHaveText(getToolById(id)!.name);
      await expect(links.nth(i)).not.toHaveAttribute("rel", /nofollow/);
    }
    // カテゴリ（「カテゴリから探す」）より下にある
    const categoriesBox = await page.getByRole("heading", { name: "カテゴリから探す" }).boundingBox();
    const popularBox = await section.boundingBox();
    expect(popularBox!.y).toBeGreaterThan(categoriesBox!.y);
  });

  test("リンクを押すと、そのツールのページへ移動する（PDF→Excel）", async ({ page }) => {
    await page.goto("/");
    await page.locator("section", { has: page.getByRole("heading", { name: "よく使われるツール" }) }).getByRole("link", { name: "PDF→Excel" }).click();
    await expect(page).toHaveURL(/\/tools\/pdf-to-excel$/);
    await expect(page.getByRole("heading", { level: 1, name: "PDF→Excel" })).toBeVisible();
  });

  test("スマホの幅でも横にはみ出さず、折り返して並ぶ", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "よく使われるツール" }) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const boxes = await section.locator("a").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
    expect(Math.max(...boxes)).toBeLessThanOrEqual(375);
  });
});

test.describe("カテゴリページの追加のリンク", () => {
  test("PDFカテゴリ: 「機能ごとのページ」に、PDF編集にまとめた機能の個別ページ（PDF結合など）がすべて並ぶ", async ({ page }) => {
    const merged = tools.filter((t) => t.category === "pdf" && t.mergedInto && t.status === "available");
    expect(merged.map((t) => t.id)).toContain("pdf-merge");
    await page.goto("/tools/pdf");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "機能ごとのページ" }) });
    for (const t of merged) await expect(section.locator(`a[href="/tools/${t.id}"]`), t.id).toHaveText(t.name);
    await expect(section.locator("a")).toHaveCount(merged.length);
  });

  test("まとめた機能があるカテゴリ（画像・Excel・CSV）にも「機能ごとのページ」が出て、ないカテゴリ（Word）には出ない", async ({ page }) => {
    for (const cat of ["image", "csv-excel"]) {
      await page.goto(`/tools/${cat}`);
      await expect(page.getByRole("heading", { name: "機能ごとのページ" }), cat).toBeVisible();
    }
    await page.goto("/tools/word");
    await expect(page.getByRole("heading", { name: "機能ごとのページ" })).toHaveCount(0);
  });

  test("設定の関連ツールは、すべて使えるツールで、そのカテゴリ以外に所属している", () => {
    for (const [cat, ids] of Object.entries(CATEGORY_CROSS_LINKS)) {
      for (const id of ids ?? []) {
        expect(usableListed(id), `${cat}: ${id}`).toBe(true);
        expect(getToolById(id)!.category, `${cat}: ${id}`).not.toBe(cat);
      }
    }
  });

  test("PDFカテゴリから、PDF→Excel・PDF→Wordへリンクされる（所属は別カテゴリのまま）", async ({ page }) => {
    await page.goto("/tools/pdf");
    const section = page.locator("section", { has: page.getByRole("heading", { name: "ほかのカテゴリにあるPDF関連のツール" }) });
    const ids = CATEGORY_CROSS_LINKS.pdf!;
    await expect(section.locator("a")).toHaveCount(ids.length);
    for (const id of ids) await expect(section.locator(`a[href="/tools/${id}"]`), id).toBeVisible();
    // PDF→Excel のパンくずリスト（所属カテゴリ）は「Excel・CSV」のまま
    await section.locator('a[href="/tools/pdf-to-excel"]').click();
    await expect(page).toHaveURL(/\/tools\/pdf-to-excel$/);
    await expect(page.locator('nav[aria-label="パンくずリスト"]').getByText("Excel・CSVツール")).toBeVisible();
  });

  test("一覧のカード（aria-label付きのリンク）の数は、そのカテゴリのツール数のまま（追加のリンクはカードにしない）", async ({ page }) => {
    const pdfTools = getListedTools().filter((t) => t.category === "pdf" && t.status === "available" && hasImplementation(t.id));
    await page.goto("/tools/pdf");
    await expect(page.locator('main a[href^="/tools/"][aria-label]')).toHaveCount(pdfTools.length);
  });
});

test.describe("関連ツール", () => {
  const cases: [string, string[]][] = [
    // 工程4：OCRは PDF→テキスト（OCR対応）に統合した
    ["pdf-to-excel", ["pdf-to-word", "filled-pdf-to-excel", "pdf-to-text", "pdf-edit"]],
    ["pdf-to-word", ["pdf-to-excel", "word-to-pdf", "pdf-to-text"]],
    ["pdf-edit", ["pdf-fix", "pdf-compress", "pdf-to-word", "pdf-to-excel"]],
    // 工程3：画像リサイズは統合先そのもの（image-compress）になったため、関連ツールの指定から外した（残りの枠は自動で選ばれる）
    ["image-compress", ["image-format-convert", "image-metadata-remove", "image-crop"]],
  ];
  for (const [id, expected] of cases) {
    test(`${id}: 使う場面が近いツールが関連ツールに出る`, async ({ page }) => {
      // 指定した関連ツールが、指定した順で先頭に出る
      expect(getRelatedTools(getToolById(id)!).related.map((t) => t.id).slice(0, expected.length)).toEqual(expected);
      await page.goto(`/tools/${id}`);
      for (const r of expected) await expect(page.locator(`main a[href="/tools/${r}"][aria-label]`), r).toBeVisible();
    });
  }
});

test.describe("リンク先の確認", () => {
  test("トップ・PDFカテゴリ・PDF→Excelのページにあるサイト内リンクは、すべて末尾の / なしで、開くと200", async ({ page, request }) => {
    // 開発サーバーでは、初めて開くページの組み立てに時間がかかるため、長めに待つ
    test.setTimeout(240_000);
    const hrefs = new Set<string>();
    for (const path of ["/", "/tools/pdf", "/tools/pdf-to-excel"]) {
      await page.goto(path);
      for (const h of await page.locator('main a[href^="/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")!))) hrefs.add(h);
    }
    for (const h of hrefs) {
      expect(h === "/" || !h.endsWith("/"), h).toBe(true);
      const res = await request.get(h, { maxRedirects: 0 });
      expect(res.status(), h).toBe(200);
    }
  });
});

test.describe("説明文（PDF→Excel・PDF→Word）", () => {
  test("何ができるかが分かる説明になっている。制限の数字は入れない", () => {
    const excel = toolSeoContent["pdf-to-excel"].metaDescription;
    expect(excel).toContain("スキャンしたPDF");
    expect(excel).toContain("サーバーに送信されません");
    const word = toolSeoContent["pdf-to-word"].metaDescription;
    expect(word).toContain("書式");
    for (const d of [excel, word]) expect(d).not.toMatch(/ページまで|\d+ページ/);
  });

  test("PDF→Excelに、記入済みPDF→Excelとの違いのFAQがある（画面とFAQPageにも出る）", async ({ page }) => {
    expect(getToolSeoContent("pdf-to-excel")!.faq.map((f) => f.question)).toContain("「記入済みPDF→Excel」とはどう違いますか？");
    await page.goto("/tools/pdf-to-excel");
    await expect(page.getByText("「記入済みPDF→Excel」とはどう違いますか？")).toBeVisible();
  });
});
