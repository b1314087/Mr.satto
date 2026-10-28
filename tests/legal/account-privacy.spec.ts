import { test, expect } from "@playwright/test";
import { featureFlags } from "@/lib/config/features";
import { LEGAL_VERSIONS, formatLegalVersion } from "@/lib/legal/versions";

/**
 * 工程38: 利用規約・プライバシーポリシーの、同意の記録・アカウント削除・ご請求の案内の記載を確認する。
 * 記載が法令に適合しているかを検証するものではない（運営者の確認が必要）。
 */
test.describe("利用規約（工程38）", () => {
  test("最終更新日が、同意を記録する版と一致している", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.locator("main")).toContainText(`最終更新日: ${formatLegalVersion(LEGAL_VERSIONS.terms)}`);
  });

  test("条文は12条のまま（条番号の参照が壊れていない）", async ({ page }) => {
    await page.goto("/terms");
    const titles = await page.locator("main h2").allInnerTexts();
    expect(titles.filter((t) => /^第\d+条（/.test(t))).toHaveLength(12);
  });

  test("課金が有効なときだけ、同意の記録・アカウント削除の条項がある", async ({ page }) => {
    await page.goto("/terms");
    const consent = page.getByTestId("terms-consent-record-clause");
    const deletion = page.getByTestId("terms-account-deletion-clause");
    if (featureFlags.billing) {
      await expect(consent).toContainText("種類・版・日時");
      await expect(deletion).toContainText("契約が続いている間は、アカウントを削除できません");
      await expect(deletion).toContainText("返金は行いません");
    } else {
      await expect(consent).toHaveCount(0);
      await expect(deletion).toHaveCount(0);
    }
  });
});

test.describe("プライバシーポリシー（工程38）", () => {
  test("最終更新日が、同意を記録する版と一致している", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator("main")).toContainText(`最終更新日: ${formatLegalVersion(LEGAL_VERSIONS.privacy)}`);
  });

  test("ご請求の案内がある。窓口は実在するフォーム・メールだけで、対応期限の数字を書いていない", async ({ page }) => {
    await page.goto("/privacy");
    const section = page.getByTestId("privacy-requests");
    await expect(section).toContainText("開示、訂正、利用停止、削除");
    await expect(section.getByRole("link", { name: "お問い合わせフォーム" })).toBeVisible();
    await expect(section.getByRole("link", { name: "contact@mrsatto.com" })).toBeVisible();
    const text = await section.innerText();
    expect(text).not.toMatch(/\d+\s*(日|営業日|週間|か月|ヶ月)以内/);
    expect(text).not.toMatch(/電話|FAX|窓口番号/);
  });

  test("課金が有効なときだけ、同意の記録・アカウント削除の説明がある（Stripe・バックアップの扱いを含む）", async ({ page }) => {
    await page.goto("/privacy");
    const consent = page.getByTestId("privacy-consent-record");
    const deletion = page.getByTestId("privacy-deletion");
    if (featureFlags.billing) {
      await expect(consent).toContainText("メールアドレスやIPアドレスは、この記録には含めません");
      await expect(deletion).toContainText("契約が続いている間は、アカウントを削除できません");
      await expect(deletion).toContainText("Stripe");
      await expect(deletion).toContainText("バックアップ");
    } else {
      await expect(consent).toHaveCount(0);
      await expect(deletion).toHaveCount(0);
    }
  });
});

test.describe("アカウント削除の画面（工程38）", () => {
  test("未ログインでは、削除フォームは出ず、ログインへ案内する。検索エンジンには公開しない", async ({ page }) => {
    const response = await page.goto("/account/delete");
    expect(response?.status()).toBe(200);
    await expect(page.locator("main").getByRole("link", { name: "ログイン" })).toHaveAttribute("href", "/login?next=/account/delete");
    await expect(page.getByLabel(/パスワード/)).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("削除後の案内ページが開く", async ({ page }) => {
    const response = await page.goto("/account/deleted");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "アカウントを削除しました" })).toBeVisible();
  });
});
