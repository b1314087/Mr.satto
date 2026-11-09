import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { getFeaturedTools, getListedTools, getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { categorySeoContent } from "@/lib/seo/category-content";
import { categories } from "@/lib/tools/categories";
import { TOOL_HANDOFF } from "@/lib/handoff/config";

/**
 * 工程1で削除したツール(配色パレット生成・Word番号振り直し)のテスト。
 *  - ツールの一覧・おすすめ・検索・関連ツール・受け渡し設定・SEOの情報に残っていない
 *  - 旧アドレスは、関連するページへ恒久的に転送される(配色パレット生成→グラデーション生成、Word番号振り直し→Wordツールの一覧)
 *  - sitemap・カテゴリページ・Wordの他のツールに影響がない
 */

const REMOVED = [
  { id: "color-palette-generator", name: "配色パレット生成", to: "/tools/gradient-generator", words: ["配色", "パレット", "カラーパレット"] },
  { id: "word-renumber", name: "Word番号振り直し", to: "/tools/word", words: ["番号振り直し", "丸数字", "番号変換"] },
];

plainTest("削除したツールは、一覧・おすすめ・検索・関連ツール・受け渡し・SEOの情報に残っていない", () => {
  for (const r of REMOVED) {
    plainExpect(getToolById(r.id), r.id).toBeUndefined();
    plainExpect(getListedTools().some((t) => t.id === r.id), r.id).toBe(false);
    plainExpect(getFeaturedTools().some((t) => t.id === r.id), r.id).toBe(false);
    plainExpect(tools.some((t) => (t.relatedToolIds ?? []).includes(r.id)), `${r.id} を関連ツールにしているツールがある`).toBe(false);
    plainExpect((TOOL_HANDOFF as Record<string, unknown>)[r.id], r.id).toBeUndefined();
    plainExpect((toolSeoContent as Record<string, unknown>)[r.id], r.id).toBeUndefined();
    for (const q of [r.name, ...r.words]) plainExpect(searchTools(getListedTools(), q).some((t) => t.id === r.id), q).toBe(false);
  }
  // カテゴリの説明文にも、削除したツールの名前が残っていない
  const texts = [...categories.map((c) => c.description), ...Object.values(categorySeoContent).flatMap((c) => [c.metaTitle, c.metaDescription, c.intro])];
  for (const t of texts) {
    plainExpect(t).not.toContain("配色パレット");
    plainExpect(t).not.toContain("番号振り直し");
    plainExpect(t).not.toContain("振り直し");
  }
  // 専用のコードは消し、Wordの共通処理(他のWordツールが使う)は残っている
  const root = path.join(__dirname, "..", "..", "src");
  for (const f of [
    "components/tools/implementations/color-palette-tool.tsx",
    "lib/processors/browser/color.ts",
    "components/tools/implementations/word-renumber-tool.tsx",
    "lib/processors/browser/word-renumber.ts",
  ])
    plainExpect(fs.existsSync(path.join(root, f)), f).toBe(false);
  plainExpect(fs.existsSync(path.join(root, "lib/word/docx-text-ops.ts"))).toBe(true);
  plainExpect(getToolById("word-paragraph-cleanup")?.status).toBe("available");
  plainExpect(getToolById("gradient-generator")?.status).toBe("available");
});

test.describe("削除したツールの旧アドレス", () => {
  for (const r of REMOVED) {
    test(`${r.name}(/tools/${r.id})は、${r.to} へ恒久的に転送される`, async ({ page, request }) => {
      const res = await request.get(`/tools/${r.id}`, { maxRedirects: 0 });
      expect(res.status(), "恒久的な転送(308)").toBe(308);
      expect(new URL(res.headers()["location"], "http://x").pathname).toBe(r.to);
      await page.goto(`/tools/${r.id}`);
      await expect(page).toHaveURL(new RegExp(`${r.to.replace(/\//g, "\\/")}$`));
      await expect(page.locator("h1")).toHaveCount(1);
    });
  }

  test("sitemap.xml に削除したツールが無く、転送先は載っている", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    for (const r of REMOVED) expect(xml).not.toContain(`/tools/${r.id}<`);
    expect(xml).toContain("/tools/gradient-generator<");
    expect(xml).toContain("/tools/word<");
  });

  test("カテゴリページ(生成ツール・Word)に、削除したツールへのリンクが無い", async ({ page }) => {
    for (const cat of ["generator", "word"]) {
      await page.goto(`/tools/${cat}`);
      for (const r of REMOVED) await expect(page.locator(`a[href="/tools/${r.id}"]`)).toHaveCount(0);
    }
    await page.goto("/");
    for (const r of REMOVED) await expect(page.locator(`a[href="/tools/${r.id}"]`)).toHaveCount(0);
  });
});
