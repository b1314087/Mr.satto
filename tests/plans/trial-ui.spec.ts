import { test, expect } from "@playwright/test";
import { featureFlags } from "@/lib/config/features";

/** 料金プラン画面の「3日間 無料お試し」の案内（未ログイン）と、アカウント画面の案内の確認 */
test.describe("無料お試しの案内", () => {
  test.skip(!featureFlags.billing, "課金システムがオフの間は、料金プラン画面を出さない");

  test("未ログインの料金プラン画面に、会員登録して3日間無料でためす導線がある", async ({ page }) => {
    await page.goto("/pricing");
    const offer = page.getByTestId("trial-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toContainText("3日間、無料でためせます");
    await expect(offer).toContainText("自動で課金されることはありません");
    await expect(page.getByTestId("trial-signup")).toHaveAttribute("href", "/signup");
    await expect(page.getByTestId("trial-start")).toHaveCount(0);
  });

  test("アカウント画面（未ログイン）は、お試しボタンを出さずログインを案内する", async ({ page }) => {
    await page.goto("/account");
    await expect(page.getByTestId("trial-start")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "ログイン" }).first()).toBeVisible();
  });
});
