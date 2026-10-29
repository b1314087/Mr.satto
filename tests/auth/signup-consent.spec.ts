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
  test("同意なしでは送信できず、同意するとサーバー（Server Action）へ送られる。ブラウザはSupabase Authへ直接登録しない", async ({ page }) => {
    await page.goto("/signup");
    const form = page.locator("main form");
    // CIでは REQUIRE_AUTH_SCREEN_TESTS=1 を付け、フォームが出ない（環境変数が反映されていない）場合は
    // スキップではなく失敗にする。黙ってスキップされ、テストが実行されたように見えるのを防ぐため（工程37）。
    if (process.env.REQUIRE_AUTH_SCREEN_TESTS === "1") {
      await expect(form, "Supabaseのダミー環境変数が反映されていません").toHaveCount(1);
    }
    test.skip((await form.count()) === 0, "会員登録機能が未設定の環境（Supabase環境変数なし）では実行しない");

    // 工程38: 登録はサーバー経由になったため、ブラウザからSupabase Authへの直接のリクエストは発生しない。
    let browserAuthRequests = 0;
    await page.route("**/auth/v1/**", async (route) => {
      browserAuthRequests += 1;
      await route.abort();
    });
    // サーバーへの送信（Server Action = 同じページへのPOST）を数える
    let serverPosts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/signup") serverPosts += 1;
    });

    await page.getByLabel("メールアドレス").fill("consent-test@example.com");
    await page.getByTestId("signup-username").fill("consent_tester");
    await page.getByLabel(/パスワード/).fill("password-1234");

    const submit = page.getByRole("button", { name: "会員登録" });
    const checkbox = page.getByRole("checkbox", { name: /利用規約.*プライバシーポリシー.*同意します/ });

    // 同意なし: ボタンが押せない。Enterキーでの送信も、ブラウザの必須チェックで止まる。
    await expect(checkbox).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await page.getByLabel(/パスワード/).press("Enter");
    await page.waitForTimeout(500);
    expect(serverPosts).toBe(0);

    // 利用規約・プライバシーポリシーへのリンクが、新しいタブで開く設定で用意されている。
    const terms = form.getByRole("link", { name: "利用規約" });
    const privacy = form.getByRole("link", { name: "プライバシーポリシー" });
    await expect(terms).toHaveAttribute("href", "/terms");
    await expect(terms).toHaveAttribute("target", "_blank");
    await expect(privacy).toHaveAttribute("href", "/privacy");
    await expect(privacy).toHaveAttribute("target", "_blank");

    // 同意すると送信できる（サーバーへ1回送られる）。ダミーのSupabaseには接続できないので、失敗の案内が表示される。
    await checkbox.check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText(/会員登録に失敗しました|準備中/)).toBeVisible({ timeout: 20_000 });
    expect(serverPosts).toBe(1);
    expect(browserAuthRequests).toBe(0);
    // 入力し直しの手間を減らすため、メールアドレスは残る（パスワードは残らない）
    await expect(page.getByLabel("メールアドレス")).toHaveValue("consent-test@example.com");
    await expect(page.getByLabel(/パスワード/)).toHaveValue("");
    // フォームがリセットされたので、同意のチェックも外れ、ボタンは再び押せない
    await expect(checkbox).not.toBeChecked();
    await expect(submit).toBeDisabled();
  });
});
