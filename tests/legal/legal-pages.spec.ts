import { test, expect } from "@playwright/test";
import { checkBasicAccessibility } from "../helpers/a11y";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { siteConfig } from "@/lib/config/site";

/**
 * 法的ページ・料金ページの整合性テスト（Phase 1-9）。
 *
 * 確認するのは「ページが開く・主要な記載が入っている・リンクが切れていない・
 * 料金表示が PLAN_DEFINITIONS と一致している」ことまで。
 * 記載内容が法令に適合しているかを検証するものではない。
 */
const STANDARD = PLAN_DEFINITIONS.standard.priceYen;
const PREMIUM = PLAN_DEFINITIONS.premium.priceYen;

test.describe("特定商取引法に基づく表記", () => {
  test("ページが開き、料金（税込）・解約・返金・お問い合わせの記載がある", async ({ page }) => {
    const response = await page.goto("/tokushoho");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "特定商取引法に基づく表記" })).toBeVisible();
    await checkBasicAccessibility(page);

    const main = page.locator("main");
    await expect(main).toContainText(`月額${STANDARD.toLocaleString()}円（税込）`);
    await expect(main).toContainText(`月額${PREMIUM.toLocaleString()}円（税込）`);
    await expect(main).toContainText("お支払い済みの料金の返金は行いません");
    await expect(main).toContainText("契約期間の終了までは");
    await expect(main.getByRole("link", { name: "お問い合わせフォーム" })).toHaveAttribute(
      "href",
      siteConfig.contactFormUrl
    );
    await expect(main.getByRole("link", { name: siteConfig.contactEmail })).toHaveAttribute(
      "href",
      `mailto:${siteConfig.contactEmail}`
    );
  });

  test("氏名・住所・電話番号は「請求があった場合にお知らせする」表記で、具体的な値を載せていない", async ({ page }) => {
    await page.goto("/tokushoho");
    const main = page.locator("main");
    for (const label of ["販売事業者", "運営統括責任者", "所在地", "電話番号"]) {
      const row = main.locator("div", { has: page.getByText(label, { exact: true }) }).last();
      await expect(row).toContainText("請求があった場合には、遅滞なくお知らせします。");
    }
    // 電話番号らしき数字列・郵便番号が載っていない（捏造・誤公開の検知）
    const text = await main.innerText();
    expect(text).not.toMatch(/0\d{1,3}-\d{2,4}-\d{3,4}/);
    expect(text).not.toMatch(/〒|\d{3}-\d{4}/);
  });

  test("フッターから特定商取引法に基づく表記へ移動できる", async ({ page }) => {
    await page.goto("/");
    await page.locator("footer").getByRole("link", { name: "特定商取引法に基づく表記" }).click();
    await expect(page).toHaveURL(/\/tokushoho$/);
  });

  test("sitemap.xml に /tokushoho が含まれる", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/sitemap.xml`);
    expect(await res.text()).toContain("/tokushoho");
  });
});

test.describe("利用規約", () => {
  test("有料プラン・料金（税込）・自動更新・解約・返金の条項があり、旧「無料で提供」のみの記載ではない", async ({ page }) => {
    await page.goto("/terms");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "利用規約" })).toBeVisible();
    await expect(main).toContainText("第4条（料金・お支払い）");
    await expect(main).toContainText(`月額${STANDARD.toLocaleString()}円（税込）`);
    await expect(main).toContainText(`月額${PREMIUM.toLocaleString()}円（税込）`);
    await expect(main).toContainText("毎月自動で更新");
    await expect(main).toContainText("現在の契約期間の終了までは");
    await expect(main).toContainText("返金は行いません");
    await expect(main).not.toContainText("会員登録は不要です。将来的に一部機能を有料化");
    await expect(main.getByRole("link", { name: "特定商取引法に基づく表記" })).toHaveAttribute("href", "/tokushoho");
  });
});

test.describe("料金ページ", () => {
  test("税込表記・解約説明・規約と特商法へのリンクがある", async ({ page }) => {
    await page.goto("/pricing");
    const main = page.locator("main");
    await expect(main.getByText(`${STANDARD.toLocaleString()}円/月（税込）`)).toBeVisible();
    await expect(main.getByText(`${PREMIUM.toLocaleString()}円/月（税込）`)).toBeVisible();
    await expect(main.getByRole("heading", { name: "お支払い・解約について" })).toBeVisible();
    await expect(main).toContainText("毎月自動で更新されます");
    await expect(main).toContainText("返金や、日割り計算は行いません");
    await expect(main.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    await expect(main.getByRole("link", { name: "特定商取引法に基づく表記" })).toHaveAttribute("href", "/tokushoho");
  });
});

test.describe("リンク切れ", () => {
  for (const path of ["/tokushoho", "/terms", "/pricing", "/signup"]) {
    test(`${path} 内のサイト内リンクがすべて200で開く`, async ({ page, request, baseURL }) => {
      await page.goto(path);
      const hrefs = await page.$$eval("a[href]", (as) =>
        Array.from(new Set(as.map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("/") && !h.startsWith("//"))))
      );
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        const res = await request.get(`${baseURL}${href}`);
        expect(res.status(), `${path} 内のリンク ${href} が200ではありません`).toBe(200);
      }
    });
  }
});

test.describe("モバイル表示", () => {
  // Pixel 7相当のスマートフォン幅（devicesを丸ごと指定するとdescribe内ではworkerを分けられないためviewportのみ指定）
  test.use({ viewport: { width: 393, height: 851 } });

  for (const path of ["/tokushoho", "/terms", "/pricing"]) {
    test(`横はみ出しがない: ${path}`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(overflow, `${path} でモバイル横スクロールが発生しています`).toBeFalsy();
    });
  }
});
