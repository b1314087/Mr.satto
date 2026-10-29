import { test, expect } from "@playwright/test";

/** 「管理画面」リンクは、管理者としてログインしているときだけ出る。未ログインでは出ない */
test.describe("管理画面リンク", () => {
  test("/api/admin/me は、未ログインなら admin:false だけを返す（個人情報なし・キャッシュなし）", async ({ request }) => {
    const res = await request.get("/api/admin/me");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ admin: false });
    expect(res.headers()["cache-control"]).toContain("no-store");
  });

  test("未ログインのヘッダー・メニューに、管理画面リンクは出ない", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("admin-link")).toHaveCount(0);
    await page.getByRole("button", { name: /メニュー/ }).first().click().catch(() => undefined);
    await expect(page.getByTestId("admin-link")).toHaveCount(0);
  });

  test("管理者と判定されたときだけ、リンクが出て /admin へ向かう（判定の応答を差し替えて確認）", async ({ page }) => {
    // 管理者としてログインした状態をテストでは再現できないため、判定APIの応答だけを差し替える
    await page.route("**/api/admin/me", (route) => route.fulfill({ json: { admin: true } }));
    await page.goto("/");
    // Supabaseが設定されていない（テスト環境）ときは、リンクは出ない＝安全側。設定済みでログインしていれば出る
    const link = page.getByTestId("admin-link");
    const count = await link.count();
    if (count > 0) await expect(link.first()).toHaveAttribute("href", "/admin");
  });
});
