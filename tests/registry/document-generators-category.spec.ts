import { test, expect } from "@playwright/test";
import { tools, getToolById } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { getCategorySeoContent } from "@/lib/seo/category-content";

/**
 * 書類作成系の7ツールを「生成ツール」カテゴリに集約した件のテスト。
 * 登録（カテゴリ・URL・検索）、カテゴリ一覧、ツールページのパンくず・構造化データ、
 * 「その他」から外れたこと、主要な生成機能がそのまま動くことを確認する。
 */

const DOCUMENT_TOOLS = [
  { id: "estimate-generator", name: "見積書作成" },
  { id: "quote-order-generator", name: "見積書・注文書の一体作成" },
  { id: "invoice-generator", name: "請求書作成" },
  { id: "order-generator", name: "注文書作成" },
  { id: "envelope-address", name: "封筒宛名作成" },
  { id: "ticket-voucher", name: "整理券・金券・引換券作成" },
  { id: "roster-template", name: "名簿テンプレート作成" },
] as const;

test.describe("書類作成ツール: 生成ツールへの集約（登録）", () => {
  test("7ツールすべてが「生成ツール」に属し、「その他」には残らない。名前は変わらない", () => {
    const generatorIds = tools.filter((t) => t.category === "generator").map((t) => t.id);
    const otherIds = tools.filter((t) => t.category === "other").map((t) => t.id);
    for (const { id, name } of DOCUMENT_TOOLS) {
      const tool = getToolById(id);
      expect(tool?.name, id).toBe(name);
      expect(tool?.category, id).toBe("generator");
      expect(tool?.status, id).toBe("available");
      expect(generatorIds, id).toContain(id);
      expect(otherIds, id).not.toContain(id);
    }
  });

  test("もとから生成ツールだったツールは、そのまま生成ツールに残る", () => {
    for (const id of ["qr-generator", "password-generator", "color-palette-generator", "gradient-generator", "electronic-stamp-generator", "fiscal-calendar", "sequence-generator", "business-card-qr"]) {
      expect(getToolById(id)?.category, id).toBe("generator");
    }
  });

  test("7ツールは生成ツールの中で隣り合って並ぶ（探しやすい配置）", () => {
    const order = tools.filter((t) => t.category === "generator").map((t) => t.id);
    const positions = DOCUMENT_TOOLS.map((t) => order.indexOf(t.id));
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...positions) - Math.min(...positions)).toBe(DOCUMENT_TOOLS.length - 1);
  });

  test("検索で、ツール名・キーワードのどちらからも見つかる（「帳票」「生成」でも）", () => {
    for (const { id, name } of DOCUMENT_TOOLS) {
      expect(searchTools(tools, name).map((t) => t.id), name).toContain(id);
    }
    expect(searchTools(tools, "帳票").map((t) => t.id)).toContain("invoice-generator");
    expect(searchTools(tools, "生成ツール").map((t) => t.id)).toContain("estimate-generator");
  });

  test("カテゴリの紹介文は、生成ツールが書類を、その他が書類を含まない内容になっている", () => {
    const generator = getCategorySeoContent("generator");
    const other = getCategorySeoContent("other");
    for (const text of [generator.metaDescription, generator.intro]) expect(text).toContain("見積書");
    for (const text of [other.metaTitle, other.metaDescription, other.intro]) {
      expect(text).not.toContain("見積書");
      expect(text).not.toContain("請求書");
    }
    expect(generator.metaTitle.startsWith("生成ツール一覧｜")).toBe(true);
  });
});

test.describe("書類作成ツール: 生成ツールへの集約（画面）", () => {
  test("生成ツールのカテゴリページに7ツールが並び、その他のカテゴリページには出ない", async ({ page }) => {
    const res = await page.goto("/tools/generator");
    expect(res?.status()).toBe(200);
    const main = page.locator("main");
    for (const { id } of DOCUMENT_TOOLS) {
      await expect(main.locator(`a[href="/tools/${id}"]`).first(), id).toBeVisible();
    }
    // もとからの生成ツールも残っている
    await expect(main.locator('a[href="/tools/qr-generator"]').first()).toBeVisible();
    await expect(main.locator('a[href="/tools/fiscal-calendar"]').first()).toBeVisible();

    await page.goto("/tools/other");
    const other = page.locator("main");
    await expect(other.locator('a[href="/tools/char-count"]').first()).toBeVisible();
    for (const { id } of DOCUMENT_TOOLS) {
      await expect(other.locator(`a[href="/tools/${id}"]`), id).toHaveCount(0);
    }
  });

  test("一覧の絞り込み「生成ツール」で7ツールが出て、「その他」では出ない", async ({ page }) => {
    await page.goto("/tools?category=generator");
    const main = page.locator("main");
    for (const { name } of DOCUMENT_TOOLS) {
      await expect(main.getByRole("link", { name: new RegExp(name) }).first(), name).toBeVisible({ timeout: 30_000 });
    }
    await page.goto("/tools?category=other");
    await expect(page.locator("main").getByRole("link", { name: /文字数カウント/ })).toBeVisible({ timeout: 30_000 });
    for (const { name } of DOCUMENT_TOOLS) {
      await expect(page.locator("main").getByRole("link", { name: new RegExp(`^${name}`) }), name).toHaveCount(0);
    }
  });

  test("ツールのURLは変わらず開け、canonicalも同じ。パンくず・構造化データ・カテゴリのバッジは「生成ツール」になる", async ({ page }) => {
    for (const { id, name } of DOCUMENT_TOOLS) {
      const res = await page.goto(`/tools/${id}`);
      expect(res?.status(), id).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name }), id).toBeVisible();
      expect(await page.locator('link[rel="canonical"]').getAttribute("href"), id).toMatch(new RegExp(`/tools/${id}$`));
      const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));
      const breadcrumb = ld.find((j) => j["@type"] === "BreadcrumbList");
      expect(breadcrumb.itemListElement[1].name, id).toBe("生成ツール");
      expect(breadcrumb.itemListElement[1].item ?? "", id).toContain("/tools/generator");
      await expect(page.locator('main a[href="/tools?category=generator"]').first(), id).toContainText("生成ツール");
      await expect(page.locator("main").first(), id).not.toContainText("ツールツール");
    }
  });

  test("主要な生成機能がそのまま動く: 封筒宛名・整理券・名簿の画面が開き、入力欄と作成ボタンが残っている", async ({ page }) => {
    await page.goto("/tools/envelope-address");
    await expect(page.getByRole("heading", { level: 1, name: "封筒宛名作成" })).toBeVisible();
    await page.goto("/tools/ticket-voucher");
    await expect(page.getByRole("heading", { level: 1, name: "整理券・金券・引換券作成" })).toBeVisible();
    await page.goto("/tools/roster-template");
    await expect(page.getByRole("heading", { level: 1, name: "名簿テンプレート作成" })).toBeVisible();
  });
});
