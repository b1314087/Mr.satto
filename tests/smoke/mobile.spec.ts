import { test, expect, devices } from "@playwright/test";

/**
 * モバイル表示のSmoke test（Phase 14）。
 * 代表的なページがモバイルビューポートでも崩れずに開けることだけを確認する
 * （デザインの詳細比較やレイアウト回帰の網羅的検出は範囲外）。
 */
test.use({ ...devices["Pixel 7"] });

const REPRESENTATIVE_PAGES = ["/", "/tools", "/tools/image", "/tools/pdf-merge", "/pricing"];

for (const path of REPRESENTATIVE_PAGES) {
  test(`モバイル表示で開ける: ${path}`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    // 横スクロールが発生していない（＝致命的なレイアウト崩れがない）ことの簡易チェック。
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(hasHorizontalOverflow, `${path} でモバイル横スクロールが発生しています`).toBeFalsy();
  });
}
