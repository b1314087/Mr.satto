import { test, expect } from "@playwright/test";
import { siteUrlIssue } from "@/lib/config/site-url";

/** 決済の戻り先URLの判定。本番で仮の値・http・不正なURLのままでは、決済を始めさせない。 */
test.describe("決済の戻り先URL(NEXT_PUBLIC_SITE_URL)の判定", () => {
  test("本番: 仮の値（未設定時の既定）・localhost・http・不正なURLは使えない", () => {
    expect(siteUrlIssue("https://example.vercel.app", "production")).toBe("placeholder");
    expect(siteUrlIssue("https://localhost", "production")).toBe("placeholder");
    expect(siteUrlIssue("http://mrsatto.com", "production")).toBe("not_https");
    expect(siteUrlIssue("mrsatto.com", "production")).toBe("invalid");
    expect(siteUrlIssue("", "production")).toBe("invalid");
  });

  test("本番: 実際のhttpsのURLは使える（ドメインの推測はしない。どのドメインでも形式が正しければ通す）", () => {
    expect(siteUrlIssue("https://mrsatto.com", "production")).toBeNull();
    expect(siteUrlIssue("https://mrmatto.vercel.app", "production")).toBeNull();
  });

  test("開発・テストでは判定しない", () => {
    expect(siteUrlIssue("https://example.vercel.app", "development")).toBeNull();
    expect(siteUrlIssue("http://localhost:3100", "test")).toBeNull();
    expect(siteUrlIssue("http://localhost:3100", undefined)).toBeNull();
  });
});
