import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { isAdHostAllowed } from "@/lib/ads/host";
import { CANONICAL_HOST, CANONICAL_ORIGIN } from "@/lib/config/site";

/**
 * 正式なドメイン（https://mrsatto.com）への統一と、広告を出すホスト名の制限（2026-11-16）。
 * 本番の転送（VERCEL_ENV=production のビルド）は、実際に本番用にビルドして確かめた（報告に結果を記載）。
 * ここでは、設定の形と、ホスト名の判定を確かめる。
 */

test.describe("正式なドメイン", () => {
  test("正式なドメインは mrsatto.com（固定）", () => {
    expect(CANONICAL_HOST).toBe("mrsatto.com");
    expect(CANONICAL_ORIGIN).toBe("https://mrsatto.com");
  });

  test("本番だけ、mrsatto.com 以外のホスト名を、同じパスで https://mrsatto.com へ恒久的に転送する設定になっている", () => {
    const src = fs.readFileSync("next.config.ts", "utf8");
    expect(src).toContain('const IS_VERCEL_PRODUCTION = process.env.VERCEL_ENV === "production";');
    expect(src).toContain('missing: [{ type: "host" as const, value: CANONICAL_HOST_PATTERN }],');
    expect(src).toContain("destination: `${CANONICAL_ORIGIN}/:path*`,");
    // 他の転送より先に判定する（redirects() の最初）
    const redirects = src.slice(src.indexOf("async redirects()"));
    expect(redirects.indexOf("IS_VERCEL_PRODUCTION")).toBeLessThan(redirects.indexOf("/tools/color-palette-generator"));
    // ホスト名の判定は完全一致（mrsatto.com.evil.example などを正式なドメインと扱わない）。Next.js は ^値$ で判定する
    expect(src).toContain('CANONICAL_HOST.replace(/\\./g, "\\\\.")');
  });

  test("プレビューは検索エンジンに載せない（robots.txt と X-Robots-Tag）", () => {
    expect(fs.readFileSync("src/app/robots.ts", "utf8")).toContain('if (process.env.VERCEL_ENV === "preview") {');
    expect(fs.readFileSync("next.config.ts", "utf8")).toContain('...(IS_VERCEL_PREVIEW ? [{ source: "/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }] : []),');
  });

  test("ローカル開発では転送しない：localhost のページがそのまま開く", async ({ page }) => {
    const res = await page.goto("/tools?x=1");
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).hostname).toBe("localhost");
    expect(new URL(page.url()).search).toBe("?x=1");
  });

  test("パスキーの利用元は、本番では https://mrsatto.com（固定）だけ", () => {
    const src = fs.readFileSync("src/lib/passkey/server.ts", "utf8");
    expect(src).toContain("const origins = [CANONICAL_ORIGIN];");
    expect(src).toContain("return { rpID: CANONICAL_HOST, origins };");
  });
});

test.describe("広告を出すホスト名", () => {
  test("mrsatto.com だけ許可。www・Vercelのアドレス・プレビュー・localhost・似た名前は許可しない", () => {
    expect(isAdHostAllowed("mrsatto.com")).toBe(true);
    expect(isAdHostAllowed("MRSATTO.COM")).toBe(true);
    expect(isAdHostAllowed("mrsatto.com.")).toBe(true);
    for (const host of [
      "www.mrsatto.com",
      "mrmatto.vercel.app",
      "mr-matto-git-feature-b1314087.vercel.app",
      "localhost",
      "127.0.0.1",
      "mrsatto.com.evil.example",
      "evilmrsatto.com",
      "",
      null,
      undefined,
    ]) {
      expect(isAdHostAllowed(host), String(host)).toBe(false);
    }
  });

  test("広告のスクリプト・広告枠・ダウンロード時の広告は、ホスト名の判定を通る。広告全体のオン・オフの判定はそのまま", () => {
    expect(fs.readFileSync("src/app/layout.tsx", "utf8")).toContain("{isAdsEnabled() && <AdsenseLoader clientId={adConfig.adsenseClientId} />}");
    const slot = fs.readFileSync("src/components/ads/ad-slot.tsx", "utf8");
    expect(slot).toContain("const hostAllowed = useAdHostAllowed();");
    expect(slot).toContain("if (!featureFlags.ads) return null;");
    const gate = fs.readFileSync("src/components/ads/download-gate-provider.tsx", "utf8");
    expect(gate).toContain("if (!isCurrentHostAdAllowed()) return false;");
    // 本番のビルドでは、テスト用の許可（NEXT_PUBLIC_ADS_TEST_HOSTS）は使わない
    expect(fs.readFileSync("src/lib/ads/host.ts", "utf8")).toContain('if (process.env.NODE_ENV !== "production") {');
  });
});
