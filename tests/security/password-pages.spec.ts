import fs from "node:fs";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { isAdFreeToolId, isAdFreeToolPath } from "@/lib/tools/ad-free-tools";

/**
 * パスワードを扱うページの安全対策（2026-11-26）。
 * 1. パスワード生成・PDFパスワード保護は、広告なしのツール（広告枠もAdSenseのスクリプトも出さない）として扱われる。
 * 2. パスワード生成の最初の長さは20文字。コピーしたあと、クリップボードに残る注意を表示する。
 * 3. パスワードを作っても、外部への通信が起きない。
 */

plainTest.describe("広告なしのツールの判定", () => {
  plainTest("パスワード生成・PDFパスワード保護は、広告なしのツールとして判定される", () => {
    plainExpect(isAdFreeToolId("password-generator")).toBe(true);
    plainExpect(isAdFreeToolId("pdf-password-protect")).toBe(true);
    plainExpect(isAdFreeToolPath("/tools/password-generator")).toBe(true);
    plainExpect(isAdFreeToolPath("/tools/pdf-password-protect/")).toBe(true);
    // ほかのツールは対象外のまま
    plainExpect(isAdFreeToolPath("/tools/qr-generator")).toBe(false);
    plainExpect(isAdFreeToolPath("/guides")).toBe(false);
  });

  plainTest("AdSenseの読み込み部品は、広告なしのツールのページではスクリプトを読み込まない作りになっている", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/components/ads/adsense-loader.tsx"), "utf8");
    plainExpect(src).toContain("isAdFreeToolPath(pathname)");
    plainExpect(src).toMatch(/if \(!allowed \|\| adFree\) return null;/);
    // ほかのページから移ってきて、すでに広告のスクリプトが動いている場合は、読み込み直す
    plainExpect(src).toContain("window.location.reload()");
  });
});

test.describe("パスワード生成の画面", () => {
  test("最初の長さは20文字で、コピーするとクリップボードの注意が出る。外部への通信は起きない", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const external: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") external.push(req.url());
    });

    await page.goto("/tools/password-generator");
    await expect(page.getByText("文字数: 20")).toBeVisible();
    const code = page.getByTestId("tool-preview").locator("code");
    await expect(code).toBeVisible();
    const first = ((await code.textContent()) ?? "").trim();
    expect(Array.from(first)).toHaveLength(20);

    await page.getByRole("button", { name: "パスワードを生成する" }).click();
    await expect(code).not.toHaveText(first);
    const generated = ((await code.textContent()) ?? "").trim();
    expect(Array.from(generated)).toHaveLength(20);

    await page.getByRole("button", { name: "コピー", exact: true }).click();
    await expect(page.getByTestId("password-clipboard-note")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generated);

    // 広告のスクリプトは読み込まれていない
    expect(await page.locator('script[src*="adsbygoogle"], script[data-mrsatto-gpt]').count()).toBe(0);
    // 外部（localhost以外）への通信は1件もない
    expect(external).toEqual([]);
  });
});

test.describe("PDFパスワード保護の画面", () => {
  test("ツールページ下の広告枠を出さない", async ({ page }) => {
    await page.goto("/tools/pdf-password-protect");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator('[data-ad-placement="tool-page"]')).toHaveCount(0);
    await expect(page.locator('[data-ad-placement="footer"]')).toHaveCount(0);
  });
});
