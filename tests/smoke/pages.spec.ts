import { test, expect } from "@playwright/test";
import { checkBasicAccessibility, checkKeyboardFocusable } from "../helpers/a11y";

/**
 * 主要ページのSmoke test（Phase 14 優先度1位）。
 * HTTP 200であること、500エラーページになっていないことだけを確認する
 * （デザインや文言の細部までは見ない）。
 *
 * あわせて、専門的な包括監査（axe-core等）ではなく「壊れたら気づける」
 * レベルの最小限のアクセシビリティチェック（tests/helpers/a11y.ts）も
 * 主要ページに対して行う。
 */
const MAIN_PAGES = ["/", "/tools", "/pricing", "/about", "/contact", "/terms", "/privacy"];

for (const path of MAIN_PAGES) {
  test(`主要ページが200で開ける: ${path}`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response, `${path} へのナビゲーションでレスポンスが取得できませんでした`).not.toBeNull();
    expect(response!.status(), `${path} が200以外のステータスを返しました`).toBe(200);

    // Next.jsのエラーオーバーレイ／デフォルトの500ページ文言が出ていないことを確認する。
    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/Application error/i);
    expect(bodyText).not.toMatch(/Internal Server Error/i);

    await checkBasicAccessibility(page);
    await checkKeyboardFocusable(page);
  });
}

test("robots.txtが取得できる", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/robots.txt`);
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain("Sitemap:");
});

test("sitemap.xmlが取得できる", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/sitemap.xml`);
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain("<urlset");
});
