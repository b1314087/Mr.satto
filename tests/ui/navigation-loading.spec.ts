import { test, expect } from "@playwright/test";

/**
 * ツールのカードを押してから、ページが開くまでの間の「読み込み中」の表示のテスト。
 * 以前は、押してから中身が届くまで画面が何も変わらず、押せたのか分からなかった。
 *
 * サーバーの応答が遅い状況を、ツールのページへの通信を2秒遅らせて再現する。
 *  1. 押した直後に、そのカードの上に「読み込み中」が出る
 *  2. 待っている間、ページ全体の読み込み画面（見出しなし）が出る
 *  3. 届いたら、読み込み表示は消えて、本物のページ（見出し1つ）になる
 */
const TOOL = "/tools/char-count";

test.describe("ツールを選んだときの読み込み表示", () => {
  test("カードを押すと、待っている間「読み込み中」が出て、届いたら消える", async ({ page }) => {
    await page.goto("/tools");
    // ツールのページへの通信だけを遅らせる（一覧ページの通信は遅らせない）
    await page.route(
      (url) => url.pathname === TOOL,
      async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
      }
    );

    const card = page.locator(`a[href="${TOOL}"]`).first();
    await card.scrollIntoViewIfNeeded();
    await card.click();

    // 1) カードの上の「読み込み中」、または 2) ページ全体の読み込み画面のどちらかが、待っている間に見える
    const overlay = card.getByTestId("link-pending");
    const pageLoading = page.getByTestId("tools-loading");
    await expect(overlay.or(pageLoading).first()).toBeVisible({ timeout: 1500 });
    await expect(page.getByText("読み込み中...").or(page.getByText("ツールを読み込んでいます...")).first()).toBeVisible();

    // 3) 届いたら本物のページになり、読み込み画面は消える
    await expect(page).toHaveURL(new RegExp(`${TOOL}$`), { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1, { timeout: 15_000 });
    await expect(pageLoading).toHaveCount(0);
  });

  test("カードの「読み込み中」は、待っていないときは見えず、配置を動かさない", async ({ page }) => {
    await page.goto("/tools");
    const card = page.locator(`a[href="${TOOL}"]`).first();
    const overlay = card.getByTestId("link-pending");
    await expect(overlay).toHaveAttribute("data-pending", "false");
    await expect(overlay).toHaveCSS("opacity", "0");
    await expect(overlay).toHaveAttribute("aria-hidden", "true");
    const before = await card.boundingBox();
    await card.hover();
    const after = await card.boundingBox();
    // ホバーで少し浮くが、膜があるせいで大きさが変わることはない
    expect(Math.abs((before?.width ?? 0) - (after?.width ?? 0))).toBeLessThan(1);
    expect(Math.abs((before?.height ?? 0) - (after?.height ?? 0))).toBeLessThan(1);
  });

  test("ホームのカテゴリのカードにも、同じ「読み込み中」の膜がある", async ({ page }) => {
    await page.goto("/");
    const catCard = page.locator('a[href^="/tools/"]:has([data-testid="link-pending"])').first();
    await expect(catCard).toBeVisible();
    await expect(catCard.getByTestId("link-pending")).toHaveAttribute("data-pending", "false");
  });

  test("存在しないツールのURLは、読み込み画面があっても、正しく404を返す（ソフト404にならない）", async ({ page }) => {
    const res = await page.goto("/tools/this-tool-does-not-exist");
    expect(res?.status()).toBe(404);
    const known = await page.goto(TOOL);
    expect(known?.status()).toBe(200);
  });
});
