import { test, expect, type Page } from "@playwright/test";
import { config } from "@/proxy";

/**
 * ログイン確認の通信回数（サーバー通信の最適化）。
 *
 * 1. Proxy（src/proxy.ts）を通るリクエストの規則（純粋な判定。Next.js の unstable_doesMiddlewareMatch）
 *    - ページ・認証の戻り（/auth/callback）は、これまでどおり通す
 *    - リンクの先読み（prefetch）・API・public の大きなファイル・アイコンは通さない
 * 2. ブラウザ側の表示用ログイン確認（src/lib/auth/browser-session.ts）
 *    - ログイン中：ヘッダー・メニュー・管理画面リンクが同じ確認結果を共有し、Supabase（/auth/v1/user）と
 *      /api/admin/me への問い合わせは、1ページにつき1回ずつ。画面内の移動では聞き直さない
 *    - 未ログイン：どちらにも問い合わせない
 *
 * 2 は実際のSupabaseには接続しない。ダミーの環境変数（NEXT_PUBLIC_SUPABASE_URL / ANON_KEY）で起動し、
 * ブラウザからの問い合わせは page.route で横取りして数える（tests/auth/login-redirect.spec.ts と同じ方式）。
 * 環境変数が無い環境ではログイン機能が出ないため、2 はスキップされる
 * （CIでは REQUIRE_AUTH_SCREEN_TESTS=1 により、スキップではなく失敗になる）。
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy npx playwright test tests/auth/session-requests.spec.ts
 */

// ---------------------------------------------------------------------------
// 1. Proxy を通るリクエストの規則
// ---------------------------------------------------------------------------

test("Proxy：ページと認証の戻りは通し、先読み・API・大きなファイル・アイコンは通さない", async () => {
  // Next.js のテスト用の判定関数は、読み込み時に AsyncLocalStorage を必要とする
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = (await import("node:async_hooks")).AsyncLocalStorage;
  const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server.js");
  const matches = (path: string, headers: Record<string, string> = {}) =>
    unstable_doesMiddlewareMatch({ config, url: `http://localhost${path}`, headers });

  // 通す（ログイン状態の確認とトークンの更新が必要なもの）
  for (const path of ["/", "/tools", "/tools/csv-dedupe", "/pricing", "/account", "/login", "/admin", "/auth/callback?code=x", "/auth/reset-callback?code=x"]) {
    expect(matches(path), path).toBe(true);
  }
  // 画面を実際に開くときのRSCリクエスト（先読みではない）も通す
  expect(matches("/pricing?_rsc=1", { rsc: "1" })).toBe(true);
  // 似た名前のページは、除外の対象にならない
  for (const path of ["/iconic", "/icon-list", "/tools/icon", "/fontsx", "/apis"]) expect(matches(path), path).toBe(true);

  // 通さない
  expect(matches("/pricing?_rsc=1", { rsc: "1", "next-router-prefetch": "1" }), "先読み").toBe(false);
  expect(matches("/tools", { purpose: "prefetch" }), "先読み（purpose）").toBe(false);
  for (const path of [
    "/api/analytics/visit",
    "/api/admin/me",
    "/api/ai/form-extract",
    "/api/stripe/checkout",
    "/api/stripe/webhook",
    "/icon?abc",
    "/apple-icon?abc",
    "/fonts/NotoSansJP-Regular.ttf",
    "/models/u2netp.onnx",
    "/ort/ort-wasm-simd-threaded.wasm",
    "/pdfjs/cmaps/90ms-RKSJ-H.bcmap",
    "/tesseract/core/tesseract-core.wasm.js",
    "/pdf.worker.min.mjs",
    "/ads.txt",
    "/_next/static/chunks/main.js",
    "/favicon.ico",
    "/robots.txt",
    "/sitemap.xml",
  ]) {
    expect(matches(path), path).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// 2. ブラウザ側の表示用ログイン確認
// ---------------------------------------------------------------------------

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

const USER = {
  id: "00000000-0000-4000-8000-000000000123",
  aud: "authenticated",
  role: "authenticated",
  email: "session-requests@example.com",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: {},
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

/** @supabase/ssr がCookieに保存する形のセッション（ダミー） */
function sessionCookieValue(): string {
  const now = Math.floor(Date.now() / 1000);
  const session = {
    access_token: `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: USER.id, exp: now + 3600, aud: "authenticated", role: "authenticated", session_id: "s1" })}.dummy`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "dummy-refresh-token",
    user: USER,
  };
  return `base64-${base64url(session)}`;
}

/** ダミーのSupabaseが設定された環境か（ログインフォームが出るか）。無ければスキップ */
async function skipWithoutAuth(page: Page) {
  await page.goto("/login");
  const form = page.locator("main form");
  if (process.env.REQUIRE_AUTH_SCREEN_TESTS === "1") {
    await expect(form, "Supabaseのダミー環境変数が反映されていません").toHaveCount(1);
  }
  test.skip((await form.count()) === 0, "ログイン機能が未設定の環境（Supabase環境変数なし）では実行しない");
  // 開発サーバーは、ページを初めて組み立てた直後に部品を差し替え（読み込み直しなしで部品を作り直す）、
  // ページ内に持っている確認結果が消えることがある（本番にはない動き）。数える前に、使うページを一度組み立てておく
  for (const path of ["/tools/csv-dedupe", "/pricing"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  await page.waitForTimeout(1500);
}

/**
 * ブラウザからの /auth/v1/user と /api/admin/me を横取りして数える。
 * loads はページの読み込み回数（画面内の移動では増えない）。開発サーバーは、ページを初めて組み立てたときに
 * ページ全体を読み込み直すことがあるため、「1ページの読み込みにつき1回まで」で確かめる。
 */
async function countAuthRequests(page: Page, admin: boolean) {
  const counts = { user: 0, adminMe: 0, loads: 0 };
  page.on("load", () => {
    counts.loads += 1;
  });
  await page.route("**/auth/v1/user**", async (route) => {
    // ブラウザが別のドメインへ送る前の確認（CORSのプリフライト：OPTIONS）は、ログイン確認そのものではないので数えない
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, OPTIONS" } });
      return;
    }
    counts.user += 1;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(USER) });
  });
  await page.route("**/api/admin/me", async (route) => {
    counts.adminMe += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ admin }) });
  });
  return counts;
}

/** ログイン中：確認はしている（1回以上）が、1ページの読み込みにつき1回まで */
function expectAtMostOncePerLoad(counts: { user: number; adminMe: number; loads: number }) {
  expect(counts.user, "ログイン確認（/auth/v1/user）").toBeGreaterThanOrEqual(1);
  expect(counts.user, `ログイン確認（/auth/v1/user）：読み込み${counts.loads}回`).toBeLessThanOrEqual(counts.loads);
  expect(counts.adminMe, "管理者の確認（/api/admin/me）").toBeGreaterThanOrEqual(1);
  expect(counts.adminMe, `管理者の確認（/api/admin/me）：読み込み${counts.loads}回`).toBeLessThanOrEqual(counts.loads);
}

test.describe("ブラウザ側のログイン確認（画面）", () => {
  test("ログイン中：ログイン確認と管理者の確認は、1ページにつき1回ずつ。画面内の移動では聞き直さない", async ({ page, context, baseURL }) => {
    await skipWithoutAuth(page);
    const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321").hostname.split(".")[0];
    await context.addCookies([{ name: `sb-${host}-auth-token`, value: sessionCookieValue(), url: baseURL ?? "http://localhost:3100" }]);
    const counts = await countAuthRequests(page, true);

    await page.goto("/tools/csv-dedupe");
    const header = page.locator("header");
    await expect(header.getByRole("link", { name: "アカウント" })).toBeVisible();
    await expect(header.getByTestId("admin-link")).toBeVisible();
    await page.waitForTimeout(1000);
    expectAtMostOncePerLoad(counts);
    const before = { ...counts };

    // 画面内の移動（ヘッダーは残る）：聞き直さない
    await header.getByRole("link", { name: "料金プラン" }).first().click();
    await expect(page).toHaveURL(/\/pricing$/);
    await expect(header.getByRole("link", { name: "アカウント" })).toBeVisible();
    await page.waitForTimeout(1000);
    expectAtMostOncePerLoad(counts);
    if (counts.loads === before.loads) {
      expect(counts.user, "画面内の移動でログイン確認をやり直した").toBe(before.user);
      expect(counts.adminMe, "画面内の移動で管理者の確認をやり直した").toBe(before.adminMe);
    }
  });

  test("ログイン中で管理者でない人：管理画面リンクは出さず、問い合わせも1回だけ", async ({ page, context, baseURL }) => {
    await skipWithoutAuth(page);
    const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321").hostname.split(".")[0];
    await context.addCookies([{ name: `sb-${host}-auth-token`, value: sessionCookieValue(), url: baseURL ?? "http://localhost:3100" }]);
    const counts = await countAuthRequests(page, false);

    await page.goto("/tools/csv-dedupe");
    await expect(page.locator("header").getByRole("link", { name: "アカウント" })).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("admin-link")).toHaveCount(0);
    expectAtMostOncePerLoad(counts);
  });

  test("未ログイン：Supabaseにも /api/admin/me にも問い合わせず、「ログイン」を出す", async ({ page }) => {
    await skipWithoutAuth(page);
    const counts = await countAuthRequests(page, false);
    await page.goto("/tools/csv-dedupe");
    await expect(page.locator("header").getByRole("link", { name: "ログイン" })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(counts.user).toBe(0);
    expect(counts.adminMe).toBe(0);
    await expect(page.getByTestId("admin-link")).toHaveCount(0);
  });
});
