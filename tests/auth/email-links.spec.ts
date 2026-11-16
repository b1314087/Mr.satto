import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  AUTH_LINK_MESSAGES,
  EMAIL_CONFIRMED_MESSAGE,
  PASSWORD_MESSAGES,
  classifyAuthLinkError,
  isCodeVerifierMissing,
  parseAuthLinkParams,
} from "@/lib/auth/auth-link";
import { MOCK_EMAIL_DOMAIN, MockGoTrue } from "../helpers/mock-gotrue";

/**
 * メールのリンク（会員登録の確認・パスワード再設定）を、同じブラウザ・別のブラウザで開いたときのテスト。
 *
 * 本物のSupabaseには接続しない。テスト専用の小さなサーバー（tests/helpers/mock-gotrue.ts）を
 * NEXT_PUBLIC_SUPABASE_URL のアドレスで動かし、「メールのリンクを開いた」ときにSupabaseが返す戻り先へ、ブラウザを移動させる。
 * 「別のブラウザ・スマートフォン」は、Cookieを共有しない別のブラウザのコンテキストで再現する。
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy npx playwright test tests/auth/email-links.spec.ts
 * 環境変数が無いときは、画面のテストはスキップする（判定の関数のテストは常に実行する）。
 */

test.describe("判定の関数", () => {
  test("Supabaseのエラーの種類を、決まった日本語の文に分ける（エラーの文そのものは使わない）", () => {
    expect(classifyAuthLinkError({ code: "otp_expired" })).toBe("expired");
    expect(classifyAuthLinkError({ code: "flow_state_expired" })).toBe("expired");
    expect(classifyAuthLinkError({ code: "flow_state_not_found" })).toBe("used");
    expect(classifyAuthLinkError({ code: "refresh_token_already_used" })).toBe("used");
    expect(classifyAuthLinkError({ code: "bad_code_verifier" })).toBe("invalid");
    expect(classifyAuthLinkError({ name: "AuthRetryableFetchError", status: 0 })).toBe("network");
    expect(classifyAuthLinkError({ code: "something_new" })).toBe("invalid");
    expect(classifyAuthLinkError(null)).toBe("invalid");
    expect(isCodeVerifierMissing({ code: "pkce_code_verifier_not_found" })).toBe(true);
    expect(isCodeVerifierMissing({ name: "AuthPKCECodeVerifierMissingError" })).toBe(true);
    expect(isCodeVerifierMissing({ code: "flow_state_not_found" })).toBe(false);
  });

  test("指示書の文言どおり", () => {
    expect(AUTH_LINK_MESSAGES).toEqual({
      expired: "リンクの有効期限が切れています。もう一度メールを送信してください。",
      used: "このリンクは既に使用されています。必要に応じて再度手続きを行ってください。",
      invalid: "リンクが無効です。メールを再送信して、最新のリンクを使用してください。",
      network: "通信に失敗しました。時間をおいてもう一度お試しください。",
      session: "認証状態を確認できませんでした。最初から手続きをやり直してください。",
    });
    expect(PASSWORD_MESSAGES.mismatch).toBe("2つのパスワードが一致していません。");
    expect(PASSWORD_MESSAGES.tooShort).toBe("パスワードは8文字以上で入力してください。");
    expect(PASSWORD_MESSAGES.updateFailed).toBe("パスワードを更新できませんでした。もう一度お試しください。");
  });

  test("URLの ? と # の両方から読み取る", () => {
    expect(parseAuthLinkParams("?code=abc", "")).toMatchObject({ code: "abc", accessToken: null });
    expect(parseAuthLinkParams("", "#access_token=a&refresh_token=r&type=recovery")).toMatchObject({ accessToken: "a", refreshToken: "r", type: "recovery" });
    expect(parseAuthLinkParams("", "#error=access_denied&error_code=otp_expired")).toMatchObject({ error: "access_denied", errorCode: "otp_expired" });
    expect(parseAuthLinkParams("?error=access_denied&error_code=otp_expired", "")).toMatchObject({ errorCode: "otp_expired" });
  });
});

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const screenTests = SUPABASE_URL.startsWith("http://127.0.0.1:");

test.describe("画面（テスト用のSupabaseの代わりで実行）", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!screenTests, "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 のときだけ実行する");

  const mock = new MockGoTrue(Number(new URL(SUPABASE_URL || "http://127.0.0.1:54321").port));
  test.beforeAll(async () => mock.start());
  test.afterAll(async () => mock.stop());

  /** 戻り先は本番のアドレス（NEXT_PUBLIC_SITE_URL）になるので、テストのサーバーのアドレスに置き換えて開く */
  let base = "";
  const local = (link: string) => base + link.replace(/^https?:\/\/[^/]+/, "");
  test.beforeEach(({ baseURL }) => {
    base = baseURL!;
  });

  async function newBrowser(browser: Browser, baseURL: string) {
    const context = await browser.newContext({ baseURL });
    return { context, page: await context.newPage() };
  }

  async function signUp(page: Page, email: string, password: string) {
    await page.goto("/signup");
    await page.locator('input[name="email"]').fill(email);
    await page.getByTestId("signup-username").fill(`user${Date.now() % 100000}`);
    await page.locator('input[name="password"]').fill(password);
    await page.locator('input[name="consent"]').check();
    await page.locator('main form button[type="submit"]').click();
    await expect(page.getByText("確認メールを送信しました")).toBeVisible({ timeout: 30_000 });
  }

  async function login(page: Page, email: string, password: string) {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('main form button[type="submit"]').click();
  }

  async function requestReset(page: Page, email: string) {
    await page.goto("/auth/forgot-password");
    await page.locator('input[type="email"]').fill(email);
    await page.locator('main form button[type="submit"]').click();
    await expect(page.getByText("パスワード再設定用のメールを送信しました")).toBeVisible({ timeout: 30_000 });
  }

  async function setNewPassword(page: Page, password: string, confirm = password) {
    await expect(page).toHaveURL(/\/auth\/reset-password$/, { timeout: 30_000 });
    const inputs = page.locator('main form input[type="password"]');
    await inputs.nth(0).fill(password);
    await inputs.nth(1).fill(confirm);
    await page.locator('main form button[type="submit"]').click();
  }

  test("会員登録：同じブラウザで確認リンクを開くと、そのままログインしてアカウント画面へ", async ({ browser, baseURL }) => {
    const pc = await newBrowser(browser, baseURL!);
    const email = `same-${Date.now()}${MOCK_EMAIL_DOMAIN}`;
    await signUp(pc.page, email, "password-123");
    await login(pc.page, email, "password-123");
    await expect(pc.page.getByText("メールアドレスの確認がまだ完了していません")).toBeVisible();
    await pc.page.goto(local(mock.confirmLinkFor(email)));
    await expect(pc.page).toHaveURL(/\/account$/, { timeout: 30_000 });
    await pc.context.close();
  });

  test("会員登録：パソコンで登録し、スマートフォン（別のブラウザ）で確認リンクを開くと、確認完了を案内し、パソコンでログインできる", async ({ browser, baseURL }) => {
    const pc = await newBrowser(browser, baseURL!);
    const phone = await newBrowser(browser, baseURL!);
    const email = `cross-${Date.now()}${MOCK_EMAIL_DOMAIN}`;
    await signUp(pc.page, email, "password-123");
    await phone.page.goto(local(mock.confirmLinkFor(email)));
    await expect(phone.page).toHaveURL(/\/login\?confirmed=1$/, { timeout: 30_000 });
    await expect(phone.page.getByTestId("auth-link-notice")).toHaveText(EMAIL_CONFIRMED_MESSAGE);
    // スマートフォン側は、ログインした状態にはならない（ログインの状態を別の端末へ渡さない）
    const phoneCookies = await phone.context.cookies();
    expect(phoneCookies.some((c) => c.name.includes("auth-token") && !c.name.includes("code-verifier"))).toBe(false);
    await login(pc.page, email, "password-123");
    await expect(pc.page).toHaveURL(/\/account$/, { timeout: 30_000 });
    await pc.context.close();
    await phone.context.close();
  });

  test("会員登録：使い終わった確認リンク・不正な戻り先は、理由を表示する", async ({ browser, baseURL }) => {
    const pc = await newBrowser(browser, baseURL!);
    const email = `used-${Date.now()}${MOCK_EMAIL_DOMAIN}`;
    await signUp(pc.page, email, "password-123");
    await pc.page.goto(local(mock.confirmLinkFor(email)));
    await expect(pc.page).toHaveURL(/\/account$/, { timeout: 30_000 });
    await pc.page.goto(local(mock.confirmLinkFor(email)));
    await expect(pc.page.getByTestId("auth-link-notice")).toHaveAttribute("data-problem", "expired");
    await expect(pc.page.getByTestId("auth-link-notice")).toContainText(AUTH_LINK_MESSAGES.expired);
    await pc.page.goto("/auth/callback");
    await expect(pc.page.getByTestId("auth-link-notice")).toHaveAttribute("data-problem", "invalid");
    await pc.page.goto("/login?auth_error=<script>");
    await expect(pc.page.getByTestId("auth-link-notice")).toHaveCount(0);
    await pc.context.close();
  });

  test("パスワード再設定：パソコンで申し込み、スマートフォン（別のブラウザ）で再設定できる。他端末はログアウト、古いパスワードは使えない", async ({ browser, baseURL }) => {
    const pc = await newBrowser(browser, baseURL!);
    const phone = await newBrowser(browser, baseURL!);
    const email = `reset-${Date.now()}${MOCK_EMAIL_DOMAIN}`;
    await signUp(pc.page, email, "old-password-1");
    await pc.page.goto(local(mock.confirmLinkFor(email)));
    await expect(pc.page).toHaveURL(/\/account$/, { timeout: 30_000 });

    const logoutBefore = mock.logoutOthers;
    await requestReset(pc.page, email);
    // 申し込みは、別の端末でも使える方式（PKCEの値を付けない）。戻り先は以前と同じURL
    expect(mock.recoverRequests.at(-1)).toMatchObject({ email, hasCodeChallenge: false });
    expect(mock.recoverRequests.at(-1)!.redirectTo).toMatch(/\/auth\/reset-callback$/);

    const link = local(mock.recoveryLinkFor(email));
    await phone.page.goto(link);
    await setNewPassword(phone.page, "new-password-2");
    await expect(phone.page).toHaveURL(/\/account$/, { timeout: 30_000 });
    // 認証の値（#access_token）は、URL・履歴に残らない
    expect(phone.page.url()).not.toContain("access_token");
    expect(mock.logoutOthers).toBe(logoutBefore + 1);

    const fresh = await newBrowser(browser, baseURL!);
    await login(fresh.page, email, "old-password-1");
    await expect(fresh.page.getByText("メールアドレスまたはパスワードが正しくありません")).toBeVisible();
    await login(fresh.page, email, "new-password-2");
    await expect(fresh.page).toHaveURL(/\/account$/, { timeout: 30_000 });

    // 同じリンクをもう一度開いても、再設定できない
    const again = await newBrowser(browser, baseURL!);
    await again.page.goto(link.replace(/#.*$/, "") + "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    await expect(again.page.getByTestId("reset-callback-error")).toHaveAttribute("data-problem", "expired");
    expect(again.page.url()).not.toContain("error_description");
    // メールのリンクは、新しいページとして開かれる
    const third = await newBrowser(browser, baseURL!);
    await third.page.goto(local(mock.recoveryLinkFor(email)));
    await expect(third.page.getByTestId("reset-callback-error")).toContainText(AUTH_LINK_MESSAGES.expired);
    expect(third.page.url()).not.toContain("error_description");
    for (const b of [pc, phone, fresh, again, third]) await b.context.close();
  });

  test("パスワード再設定：同じブラウザで再設定でき、入力の誤りは日本語で案内する", async ({ browser, baseURL }) => {
    const pc = await newBrowser(browser, baseURL!);
    const email = `reset-same-${Date.now()}${MOCK_EMAIL_DOMAIN}`;
    await signUp(pc.page, email, "old-password-1");
    await pc.page.goto(local(mock.confirmLinkFor(email)));
    await requestReset(pc.page, email);
    await pc.page.goto(local(mock.recoveryLinkFor(email)));
    await expect(pc.page.getByTestId("reset-password-account")).toContainText(email);
    // 8文字未満は、ブラウザの入力チェック（minlength）で送信されない。画面の確認（JavaScript）でも同じ文を出す
    await setNewPassword(pc.page, "short");
    await expect(pc.page.locator('main form input[type="password"]').first()).toHaveJSProperty("validity.tooShort", true);
    await pc.page.locator('main form input[type="password"]').evaluateAll((els) => els.forEach((el) => el.removeAttribute("minlength")));
    await pc.page.locator('main form button[type="submit"]').click();
    await expect(pc.page.locator("main [role=alert]")).toContainText(PASSWORD_MESSAGES.tooShort);
    await setNewPassword(pc.page, "new-password-2", "new-password-3");
    await expect(pc.page.locator("main [role=alert]")).toContainText(PASSWORD_MESSAGES.mismatch);
    await setNewPassword(pc.page, "old-password-1");
    await expect(pc.page.locator("main [role=alert]")).toContainText(PASSWORD_MESSAGES.samePassword);
    await setNewPassword(pc.page, "new-password-2");
    await expect(pc.page).toHaveURL(/\/account$/, { timeout: 30_000 });
    await pc.context.close();
  });

  test("パスワード再設定：以前のメール（?code=）を別のブラウザで開いた場合・値が無い場合・直接開いた場合は、理由を案内する", async ({ browser, baseURL }) => {
    const pc = await newBrowser(browser, baseURL!);
    const email = `legacy-${Date.now()}${MOCK_EMAIL_DOMAIN}`;
    await signUp(pc.page, email, "old-password-1");
    await pc.page.goto(local(mock.confirmLinkFor(email)));
    await expect(pc.page).toHaveURL(/\/account$/, { timeout: 30_000 });
    const other = await newBrowser(browser, baseURL!);
    await other.page.goto("/auth/reset-callback?code=unknown-code");
    await expect(other.page.getByTestId("reset-callback-error")).toHaveAttribute("data-problem", "invalid");
    expect(other.page.url()).not.toContain("code=");
    await other.page.goto("/auth/reset-callback");
    await expect(other.page.getByTestId("reset-callback-error")).toHaveAttribute("data-problem", "invalid");
    await other.page.goto("/auth/reset-password");
    await expect(other.page.getByTestId("reset-password-no-session")).toHaveText(AUTH_LINK_MESSAGES.session);
    await pc.context.close();
    await other.context.close();
  });

  test("パスワード再設定：type が recovery ではない値や、無効な値は受け付けない", async ({ browser, baseURL }) => {
    const b = await newBrowser(browser, baseURL!);
    await b.page.goto("/auth/reset-callback#access_token=a.b.c&refresh_token=r&type=signup");
    await expect(b.page.getByTestId("reset-callback-error")).toHaveAttribute("data-problem", "invalid");
    expect(b.page.url()).not.toContain("access_token");
    await b.page.goto("/auth/reset-callback#access_token=a.b.c&refresh_token=r&type=recovery");
    await expect(b.page.getByTestId("reset-callback-error")).toBeVisible();
    await expect(b.page).toHaveURL(/\/auth\/reset-callback$/);
    await b.context.close();
  });
});
