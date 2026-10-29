import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * リンク・ボタンを押したときの「読み込み中」の表示のテスト。
 * - サイト内のリンクを押すと、画面の上端にバーが出て、押したリンクに印が付く。移動が終わると消える。
 * - 移動しない押し方（別タブ・同じページ内・外部サイト）では出さない。
 * サーバーの応答が遅い状況は、移動先への通信を2秒遅らせて再現する。
 */
test.describe("リンクを押したときの読み込み表示（サイト全体）", () => {
  test("ヘッダーのリンクを押すと、待っている間バーが出て、届いたら消える", async ({ page }) => {
    await page.goto("/");
    const bar = page.getByTestId("nav-progress");
    await expect(bar).toHaveAttribute("data-pending", "false");
    await expect(bar).toHaveCSS("opacity", "0");

    await page.route(
      (url) => url.pathname === "/pricing",
      async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
      }
    );
    const link = page.locator('header a[href="/pricing"]').first();
    await link.click();

    await expect(bar).toHaveAttribute("data-pending", "true", { timeout: 1500 });
    await expect(bar).toHaveCSS("opacity", "1");
    await expect(link).toHaveAttribute("data-nav-pending", "true");

    await expect(page).toHaveURL(/\/pricing$/, { timeout: 15_000 });
    await expect(bar).toHaveAttribute("data-pending", "false", { timeout: 5000 });
    await expect(page.locator("[data-nav-pending]")).toHaveCount(0);
  });

  test("同じページ・ページ内リンク・新しいタブで開くリンクでは、出さない", async ({ page }) => {
    await page.goto("/pricing");
    const bar = page.getByTestId("nav-progress");
    await page.evaluate(() => {
      const make = (href: string, id: string, target?: string) => {
        const a = document.createElement("a");
        a.href = href;
        a.id = id;
        a.textContent = id;
        if (target) a.target = target;
        a.addEventListener("click", (e) => e.preventDefault());
        document.body.prepend(a);
      };
      make("/pricing", "same-page");
      make("/pricing#top", "hash-link");
      make("/terms", "new-tab", "_blank");
      make("https://example.com/", "external");
    });
    for (const id of ["same-page", "hash-link", "new-tab", "external"]) {
      await page.locator(`#${id}`).click();
      await expect(bar, id).toHaveAttribute("data-pending", "false");
      await expect(page.locator(`#${id}`), id).not.toHaveAttribute("data-nav-pending", "true");
    }
  });

  test("Ctrl（⌘）を押しながらのクリックでは、出さない", async ({ page }) => {
    await page.goto("/");
    const link = page.locator('header a[href="/pricing"]').first();
    await link.evaluate((el) => el.addEventListener("click", (e) => e.preventDefault()));
    await link.click({ modifiers: ["Control"] });
    await expect(page.getByTestId("nav-progress")).toHaveAttribute("data-pending", "false");
  });
});

test.describe("実装の静的確認", () => {
  test("全ページ共通のレイアウトに、移動の読み込み表示が入っている", () => {
    expect(readFileSync("src/app/layout.tsx", "utf8")).toContain("<NavigationFeedback />");
  });

  test("サーバーの処理を呼ぶフォームの送信ボタンは、処理中の表示つきの共通ボタンを使っている", () => {
    for (const file of [
      "src/components/admin/member-status-form.tsx",
      "src/components/pricing/trial-card.tsx",
      "src/app/account/page.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), file).toContain("<FormSubmitButton");
    }
  });

  test("会員一覧の「詳細」ボタンと見出しは、文字が折り返さない（枠からはみ出さない）", () => {
    const list = readFileSync("src/app/admin/members/page.tsx", "utf8");
    expect(list).toMatch(/data-testid="member-detail-link"\s+className="[^"]*whitespace-nowrap/);
    expect(list).not.toMatch(/<th className="px-4/);
  });
});
