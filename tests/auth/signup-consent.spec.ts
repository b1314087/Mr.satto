import { test, expect } from "@playwright/test";
import { getSignupConsentError, SIGNUP_CONSENT_REQUIRED_MESSAGE } from "@/lib/auth/signup-consent";

/**
 * 会員登録時の利用規約・プライバシーポリシーへの同意チェックのテスト（Phase 1-9）。
 *
 * 1. 判定ロジック（純粋関数）のテスト: 常に実行される。
 * 2. 画面のテスト: 会員登録フォームは NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が
 *    設定されている環境でだけ表示される（未設定だと「準備中」表示になる）。そのため、
 *    未設定の環境ではこの画面テストはスキップされる。
 *    実行するときは、実際のSupabaseには接続しないダミー値を設定して起動する:
 *      NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy npx playwright test tests/auth
 *    （登録リクエストは page.route で横取りし、実際の通信は行わない）
 */
test("同意していなければエラーメッセージを返し、同意していれば null を返す", () => {
  expect(getSignupConsentError(false)).toBe(SIGNUP_CONSENT_REQUIRED_MESSAGE);
  expect(getSignupConsentError(true)).toBeNull();
});

test.describe("会員登録フォームの同意チェック（画面）", () => {
  test("同意なしでは登録リクエストが送られず、同意すると送られる", async ({ page }) => {
    await page.goto("/signup");
    const form = page.locator("main form");
    test.skip((await form.count()) === 0, "会員登録機能が未設定の環境（Supabase環境変数なし）では実行しない");

    let signupRequests = 0;
    await page.route("**/auth/v1/signup**", async (route) => {
      signupRequests += 1;
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ code: 422, error_code: "user_already_exists", msg: "User already registered" }),
      });
    });

    await page.getByLabel("メールアドレス").fill("consent-test@example.com");
    await page.getByLabel(/パスワード/).fill("password-1234");

    const submit = page.getByRole("button", { name: "会員登録" });
    const checkbox = page.getByRole("checkbox", { name: /利用規約.*プライバシーポリシー.*同意します/ });

    // 同意なし: ボタンが押せない。Enterキーでの送信も、ブラウザの必須チェックで止まる。
    await expect(checkbox).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await page.getByLabel(/パスワード/).press("Enter");
    await page.waitForTimeout(500);
    expect(signupRequests).toBe(0);

    // 利用規約・プライバシーポリシーへのリンクが、新しいタブで開く設定で用意されている。
    const terms = form.getByRole("link", { name: "利用規約" });
    const privacy = form.getByRole("link", { name: "プライバシーポリシー" });
    await expect(terms).toHaveAttribute("href", "/terms");
    await expect(terms).toHaveAttribute("target", "_blank");
    await expect(privacy).toHaveAttribute("href", "/privacy");
    await expect(privacy).toHaveAttribute("target", "_blank");

    // 同意すると送信できる（登録リクエストが1回送られる）。
    await checkbox.check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText("このメールアドレスは既に登録されています")).toBeVisible();
    expect(signupRequests).toBe(1);

    // 同意を外すとまた押せなくなる。
    await checkbox.uncheck();
    await expect(submit).toBeDisabled();
  });
});
