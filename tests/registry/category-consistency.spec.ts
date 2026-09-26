import { test, expect } from "@playwright/test";
import { categories, getCategory } from "@/lib/tools/categories";
import { tools } from "@/lib/tools/data";
import { categorySeoContent } from "@/lib/seo/category-content";

/**
 * カテゴリ整合性テスト（Phase 14）。
 * categories.ts / data.ts / category-content.ts の3つが矛盾していないことを
 * データ駆動で確認する。
 */

test.describe("カテゴリ整合性", () => {
  test("重複するcategory IDが存在しない", () => {
    const ids = categories.map((c) => c.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  for (const category of categories) {
    test(`[${category.id}] 必須メタデータが揃っている`, () => {
      expect(category.name, `${category.id}: nameが空`).toBeTruthy();
      expect(category.description, `${category.id}: descriptionが空`).toBeTruthy();
      expect(category.icon, `${category.id}: iconが空`).toBeTruthy();
    });

    test(`[${category.id}] getCategory()で取得できる`, () => {
      expect(getCategory(category.id)).toEqual(category);
    });

    test(`[${category.id}] SEOコンテンツが存在する`, () => {
      expect(categorySeoContent[category.id]).toBeTruthy();
    });

    test(`[${category.id}] カテゴリページが200で開ける`, async ({ page }) => {
      const response = await page.goto(`/tools/${category.id}`);
      expect(response?.status()).toBe(200);
    });
  }

  test("すべてのツールのcategoryが実在するカテゴリを指している", () => {
    const validIds = new Set(categories.map((c) => c.id));
    const invalid = tools.filter((t) => !validIds.has(t.category));
    expect(invalid.map((t) => `${t.id}:${t.category}`)).toEqual([]);
  });
});
