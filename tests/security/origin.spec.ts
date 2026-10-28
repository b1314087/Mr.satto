import { test, expect } from "@playwright/test";
import { allowedOriginsFor, checkRequestOrigin } from "@/lib/security/origin";

/**
 * 送信元（Origin）確認の単体テスト（工程39）。ブラウザ・サーバーには接続しない。
 * 許可の根拠はサーバー側の設定だけで、リクエストの Host など、クライアントが指定できる値は使わない。
 */
const PROD = allowedOriginsFor("https://mrsatto.com", "production");
const DEV = allowedOriginsFor("https://example.vercel.app", "development");
const none = { secFetchSite: null };

test.describe("許可する送信元の作り方", () => {
  test("本番: 設定したサイトURLと、www の有無だけ違う同じドメインだけ。localhost は許可しない", () => {
    expect([...PROD.exact].sort()).toEqual(["https://mrsatto.com", "https://www.mrsatto.com"]);
    expect(PROD.allowLocalhost).toBe(false);
    expect([...allowedOriginsFor("https://www.mrsatto.com/path", "production").exact].sort()).toEqual(["https://mrsatto.com", "https://www.mrsatto.com"]);
  });

  test("開発・テスト: localhost も許可する", () => {
    expect(DEV.allowLocalhost).toBe(true);
  });

  test("不正なサイトURLの設定では、許可する送信元がなくなる（すべて拒否）", () => {
    const broken = allowedOriginsFor("not a url", "production");
    expect(broken.exact).toEqual([]);
    expect(checkRequestOrigin({ origin: "https://mrsatto.com", ...none }, broken)).toEqual({ ok: false, reason: "foreign" });
  });
});

test.describe("Origin ヘッダーがある場合", () => {
  test("許可された送信元（本番ドメイン・www）は通る", () => {
    for (const origin of ["https://mrsatto.com", "https://www.mrsatto.com"]) {
      expect(checkRequestOrigin({ origin, ...none }, PROD)).toEqual({ ok: true });
    }
  });

  test("外部のサイト・似たドメイン・別のスキーム・別のポートは拒否", () => {
    const foreign = [
      "https://evil.example",
      "https://mrsatto.com.evil.example",
      "https://evilmrsatto.com",
      "https://sub.mrsatto.com",
      "http://mrsatto.com",
      "https://mrsatto.com:8443",
    ];
    for (const origin of foreign) {
      expect(checkRequestOrigin({ origin, ...none }, PROD), origin).toEqual({ ok: false, reason: "foreign" });
    }
  });

  test("不正な値（null・文字列・パス付き・認証情報付き・別のプロトコル）は拒否", () => {
    const invalid = ["null", "garbage", "https://mrsatto.com/", "https://mrsatto.com/path", "https://mrsatto.com@evil.example", "javascript:alert(1)", "file:///etc/passwd", "https://"];
    for (const origin of invalid) {
      const result = checkRequestOrigin({ origin, ...none }, PROD);
      expect(result.ok, origin).toBe(false);
    }
  });

  test("本番では localhost からの送信は拒否、開発では許可", () => {
    expect(checkRequestOrigin({ origin: "http://localhost:3000", ...none }, PROD)).toEqual({ ok: false, reason: "foreign" });
    expect(checkRequestOrigin({ origin: "http://localhost:3000", ...none }, DEV)).toEqual({ ok: true });
    expect(checkRequestOrigin({ origin: "http://127.0.0.1:3101", ...none }, DEV)).toEqual({ ok: true });
    // 開発でも、localhost に見せかけた別のホストは拒否
    expect(checkRequestOrigin({ origin: "http://localhost.evil.example", ...none }, DEV).ok).toBe(false);
    expect(checkRequestOrigin({ origin: "https://localhost:3000", ...none }, DEV).ok).toBe(false);
  });

  test("Sec-Fetch-Site が same-origin でも、Origin が外部なら拒否（Origin を優先）", () => {
    expect(checkRequestOrigin({ origin: "https://evil.example", secFetchSite: "same-origin" }, PROD).ok).toBe(false);
  });
});

test.describe("Origin ヘッダーが無い場合", () => {
  test("Sec-Fetch-Site が same-origin のときだけ許可", () => {
    expect(checkRequestOrigin({ origin: null, secFetchSite: "same-origin" }, PROD)).toEqual({ ok: true });
    expect(checkRequestOrigin({ origin: "", secFetchSite: "Same-Origin" }, PROD)).toEqual({ ok: true });
  });

  test("Sec-Fetch-Site が cross-site / same-site / none / 無し は拒否", () => {
    for (const secFetchSite of ["cross-site", "same-site", "none", "", null]) {
      expect(checkRequestOrigin({ origin: null, secFetchSite }, PROD), String(secFetchSite)).toEqual({ ok: false, reason: "missing" });
    }
  });
});
