import { test, expect } from "@playwright/test";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@/lib/auth/username";

test("会員登録フォームに、必須のユーザー名の入力欄がある（文字数の制限と説明つき）", async ({ page }) => {
  await page.goto("/signup");
  const form = page.locator("main form");
  if (process.env.REQUIRE_AUTH_SCREEN_TESTS === "1") {
    await expect(form, "Supabaseのダミー環境変数が反映されていません").toHaveCount(1);
  }
  test.skip((await form.count()) === 0, "会員登録機能が未設定の環境では実行しない");

  const input = page.getByTestId("signup-username");
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("name", "username");
  await expect(input).toHaveAttribute("required", "");
  await expect(input).toHaveAttribute("minlength", String(USERNAME_MIN_LENGTH));
  await expect(input).toHaveAttribute("maxlength", String(USERNAME_MAX_LENGTH));
  await expect(form).toContainText("ユーザー名");
});
