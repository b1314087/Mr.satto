import { test, expect } from "@playwright/test";

/**
 * ログイン後のリダイレクト先（?next=）の画面テスト（工程37）。
 *
 * tests/auth/safe-redirect.spec.ts は判定の関数だけを検証する。こちらは、ログインフォームが
 * 実際にその判定を使っていること（外部サイトへ移動しないこと）を、画面操作で確かめる。
 *
 * 実際のSupabaseには接続しない。ダミーの環境変数（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY）で起動し、
 * ログインのリクエストは page.route で横取りして成功の応答を返す。
 * 環境変数が無い環境ではログインフォームが出ないため、このテストはスキップされる
 * （CIでは REQUIRE_AUTH_SCREEN_TESTS=1 により、スキップではなく失敗になる）。
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy npx playwright test tests/auth
 */
const EXTERNAL_HOST = /^https?:\/\/evil\.example(\/|$)/;

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeSessionBody() {
  const now = Math.floor(Date.now() / 1000);
  const user = {
    id: "00000000-0000-0000-0000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "redirect-test@example.com",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  return {
    access_token: `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: user.id, exp: now + 3600 })}.dummy`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "dummy-refresh-token",
    user,
  };
}

async function loginWithNext(page: import("@playwright/test").Page, next: string) {
  let externalRequests = 0;
  await page.route(EXTERNAL_HOST, async (route) => {
    externalRequests += 1;
    await route.fulfill({ status: 200, contentType: "text/html", body: "external" });
  });
  await page.route("**/auth/v1/token**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fakeSessionBody()) });
  });

  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const form = page.locator("main form");
  if (process.env.REQUIRE_AUTH_SCREEN_TESTS === "1") {
    await expect(form, "Supabaseのダミー環境変数が反映されていません").toHaveCount(1);
  }
  test.skip((await form.count()) === 0, "ログイン機能が未設定の環境（Supabase環境変数なし）では実行しない");

  await page.getByLabel("メールアドレス").fill("redirect-test@example.com");
  await page.getByLabel("パスワード").fill("password-1234");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByText("ログインしました")).toBeVisible();
  return () => externalRequests;
}

test.describe("ログイン後のリダイレクト先（画面）", () => {
  test("安全な内部パスなら、そのページへ移動する", async ({ page }) => {
    await loginWithNext(page, "/tools");
    await expect(page).toHaveURL(/\/tools$/);
  });

  for (const unsafe of ["/\t/evil.example/x", "//evil.example/x", "/\\evil.example/x", "https://evil.example/x"]) {
    test(`外部サイトへ誘導する値は無視される: ${JSON.stringify(unsafe)}`, async ({ page }) => {
      const externalRequests = await loginWithNext(page, unsafe);
      // 画面遷移（と、その後のサーバー側のリダイレクト）が落ち着くのを待ってから確認する
      await page.waitForTimeout(1500);
      expect(externalRequests()).toBe(0);
      expect(new URL(page.url()).hostname).toBe("localhost");
    });
  }
});
