import { test, expect } from "@playwright/test";
import { categories, getCategory } from "@/lib/tools/categories";
import { tools, getToolById } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { categorySeoContent } from "@/lib/seo/category-content";

/**
 * 「PowerPoint」カテゴリー（pptx）のテスト。
 * 登録（categories / data / SEO）の整合、一覧の絞り込み、検索、カテゴリページを確認する。
 */

test.describe("PowerPointカテゴリー: 登録", () => {
  test("独立したカテゴリーとして登録され、既存カテゴリーの並びは変わらない", () => {
    expect(getCategory("pptx")?.name).toBe("PowerPoint");
    expect(categories.map((c) => c.id)).toEqual(["image", "pdf", "csv-excel", "word", "pptx", "video", "audio", "file", "generator", "other"]);
    expect(categorySeoContent.pptx.metaTitle).toContain("PowerPoint");
  });

  test("PowerPoint白黒反転は、PowerPointカテゴリーだけに属する（その他には残らない）", () => {
    expect(getToolById("pptx-invert")?.category).toBe("pptx");
    expect(tools.filter((t) => t.category === "pptx").map((t) => t.id)).toEqual(["pptx-invert"]);
    expect(tools.filter((t) => t.category === "other").map((t) => t.id)).not.toContain("pptx-invert");
  });

  test("検索で見つかる（ツール名・カテゴリー名・キーワード）", () => {
    for (const q of ["PowerPoint", "パワーポイント", "pptx", "白黒反転"]) {
      expect(searchTools(tools, q).map((t) => t.id), q).toContain("pptx-invert");
    }
  });
});

test.describe("PowerPointカテゴリー: 画面", () => {
  test("一覧のカテゴリー絞り込みにPowerPointが出て、選ぶとそのツールだけが表示される", async ({ page }) => {
    await page.goto("/tools");
    const main = page.locator("main");
    const chip = main.getByRole("button", { name: "PowerPoint", exact: true });
    await expect(chip).toBeVisible({ timeout: 30_000 });
    // 既存のカテゴリーも残っている
    for (const name of ["画像", "PDF", "Excel・CSV", "Word", "動画", "音声", "ファイル", "生成ツール", "その他"]) {
      await expect(main.getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(async () => {
      await chip.click();
      await expect(page).toHaveURL(/category=pptx/, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(main.getByRole("link", { name: /PowerPoint白黒反転/ })).toBeVisible();
    await expect(main.getByRole("link", { name: /画像リサイズ/ })).toHaveCount(0);
    await expect(main.getByRole("link", { name: /見積書作成/ })).toHaveCount(0);
  });

  test("「その他」で絞り込んでも、PowerPoint白黒反転は出ない", async ({ page }) => {
    await page.goto("/tools?category=other");
    const main = page.locator("main");
    await expect(main.getByRole("link", { name: /文字数カウント/ })).toBeVisible({ timeout: 30_000 });
    await expect(main.getByRole("link", { name: /PowerPoint白黒反転/ })).toHaveCount(0);
  });

  test("検索（PowerPoint）でツールが見つかる", async ({ page }) => {
    await page.goto("/tools?q=PowerPoint");
    await expect(page.locator("main").getByRole("link", { name: /PowerPoint白黒反転/ })).toBeVisible({ timeout: 30_000 });
  });

  test("カテゴリーページ /tools/pptx が開き、ツールが並ぶ。ツールページのパンくず・バッジもPowerPoint", async ({ page }) => {
    const res = await page.goto("/tools/pptx");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("PowerPoint");
    await expect(page.locator("main").getByRole("link", { name: /PowerPoint白黒反転/ }).first()).toBeVisible();
    await page.goto("/tools/pptx-invert");
    await expect(page.getByRole("heading", { level: 1, name: "PowerPoint白黒反転" })).toBeVisible();
    await expect(page.locator('main a[href="/tools?category=pptx"]')).toContainText("PowerPoint");
  });
});
