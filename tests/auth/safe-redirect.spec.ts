import { test, expect } from "@playwright/test";
import { isSafeInternalPath } from "@/lib/auth/safe-redirect";

/**
 * ログイン後リダイレクト先（?next=）の Open Redirect 対策のテスト（工程36）。
 * 純粋関数のテストなので、サーバーやブラウザ画面は不要。
 */
test.describe("isSafeInternalPath", () => {
  const safe = ["/account", "/admin", "/tools?q=a", "/tools/pdf-merge#top", "/", "/%09/x", "/a//b"];
  for (const p of safe) {
    test(`許可: ${JSON.stringify(p)}`, () => {
      expect(isSafeInternalPath(p)).toBe(true);
    });
  }

  const unsafe = [
    "",
    "account",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\r/evil.example",
    "/\n/evil.example",
    "/\t\\evil.example",
    "/a\\b",
    "/\u0000/evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "\t//evil.example",
    " //evil.example",
  ];
  for (const p of unsafe) {
    test(`拒否: ${JSON.stringify(p)}`, () => {
      expect(isSafeInternalPath(p)).toBe(false);
    });
  }

  test("許可された値は必ず同一オリジンに解決される", () => {
    for (const p of safe) {
      expect(new URL(p, "https://mrsatto.com").origin).toBe("https://mrsatto.com");
    }
  });
});
