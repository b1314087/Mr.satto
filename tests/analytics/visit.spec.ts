import { test, expect } from "@playwright/test";
import { dailyVisitorHash, isLikelyBot, jstDateString, parseVisitPath } from "@/lib/analytics/visit";

/** 訪問数の集計（個人を特定しない・Cookieなし） */

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

test.describe("訪問数の集計の部品", () => {
  test("ボット・自動の巡回は数えない", () => {
    for (const ua of ["Googlebot/2.1", "curl/8.0", "HeadlessChrome/120", "Mozilla/5.0 (compatible; bingbot/2.0)", "python-requests/2.31", "", null, undefined]) {
      expect(isLikelyBot(ua), String(ua)).toBe(true);
    }
    expect(isLikelyBot(CHROME)).toBe(false);
  });

  test("数えるのは、サイト内のページだけ（管理画面・API・認証・外部URLは数えない）", () => {
    expect(parseVisitPath({ path: "/" })).toBe("/");
    expect(parseVisitPath({ path: "/tools/pdf-to-excel?x=1#a" })).toBe("/tools/pdf-to-excel");
    for (const p of ["/admin", "/admin/members", "/api/x", "/auth/callback", "/_next/static", "//evil.com", "https://evil.com/", "x", "", "/" + "a".repeat(200)]) {
      expect(parseVisitPath({ path: p }), p).toBeNull();
    }
    for (const b of [null, undefined, "str", 1, {}, { path: 5 }]) expect(parseVisitPath(b)).toBeNull();
    expect(parseVisitPath({ path: "/administrator-guide" })).toBe("/administrator-guide");
  });

  test("日本時間の日付", () => {
    expect(jstDateString(new Date("2026-10-28T15:00:00Z"))).toBe("2026-10-29");
    expect(jstDateString(new Date("2026-10-28T14:59:00Z"))).toBe("2026-10-28");
  });

  test("訪問者のハッシュ：同じ日・同じ人は同じ値。日・IP・ブラウザ・秘密が違えば別の値。元の情報は含まない", () => {
    const d1 = new Date("2026-10-29T03:00:00Z");
    const same = new Date("2026-10-29T10:00:00Z");
    const next = new Date("2026-10-30T03:00:00Z");
    const h = dailyVisitorHash("secret", "203.0.113.5", CHROME, d1);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(dailyVisitorHash("secret", "203.0.113.5", CHROME, same)).toBe(h);
    expect(dailyVisitorHash("secret", "203.0.113.5", CHROME, next)).not.toBe(h); // 日をまたいで追跡できない
    expect(dailyVisitorHash("secret", "203.0.113.6", CHROME, d1)).not.toBe(h);
    expect(dailyVisitorHash("secret", "203.0.113.5", CHROME + "x", d1)).not.toBe(h);
    expect(dailyVisitorHash("other", "203.0.113.5", CHROME, d1)).not.toBe(h);
    expect(h).not.toContain("203");
  });
});

test.describe("訪問数の受け口 /api/analytics/visit", () => {
  const post = (request: import("@playwright/test").APIRequestContext, data: unknown, headers: Record<string, string> = {}) =>
    request.post("/api/analytics/visit", { data, headers: { "user-agent": CHROME, ...headers } });

  test("どんな場合も 204（利用者に影響しない）。Cookieは設定しない", async ({ request }) => {
    const cases: { data: unknown; headers?: Record<string, string> }[] = [
      { data: { path: "/" } },
      { data: { path: "/admin" } },
      { data: "not json" },
      { data: { path: "/" }, headers: { "user-agent": "Googlebot/2.1" } },
      { data: { path: "/" }, headers: { dnt: "1" } },
      { data: { path: "/" }, headers: { "sec-gpc": "1" } },
      { data: { path: "/" }, headers: { origin: "https://evil.example" } },
      { data: { path: "/" + "a".repeat(5000) } },
    ];
    for (const c of cases) {
      const res = await post(request, c.data, c.headers);
      expect(res.status(), JSON.stringify(c)).toBe(204);
      expect(res.headers()["set-cookie"]).toBeUndefined();
      expect(await res.text()).toBe("");
    }
  });
});
