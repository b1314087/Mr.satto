import { test, expect } from "@playwright/test";
import fs from "node:fs";

/**
 * 2026-11-15：AdSenseのサイトの所有権の確認（mrsatto.com）。
 * 広告のスクリプトは後から読み込む（afterInteractive）ため、確認ロボットが元のHTMLで見つけられなかった。
 * 元のHTMLの <head> に、メタタグ <meta name="google-adsense-account" content="ca-pub-…"> を出して確認できるようにする。
 */
const clientId = (process.env.NEXT_PUBLIC_ADSENSE_CLIENT_ID ?? "").trim();

test.describe("AdSenseの所有権の確認用メタタグ", () => {
  test("レイアウトは、広告IDがあるときだけ google-adsense-account のメタタグを出す（広告のオン・オフには左右されない）", () => {
    const src = fs.readFileSync("src/app/layout.tsx", "utf8");
    expect(src).toContain('...(adConfig.adsenseClientId ? { other: { "google-adsense-account": adConfig.adsenseClientId } } : {})');
  });

  test("元のHTML（JavaScriptの実行前）の <head> に、広告IDのメタタグが入っている（広告IDが未設定の環境では出ない）", async ({ request }) => {
    const res = await request.get("/");
    const html = await res.text();
    const head = html.slice(0, html.indexOf("</head>"));
    if (clientId) {
      expect(head).toContain(`<meta name="google-adsense-account" content="${clientId}"/>`);
    } else {
      expect(head).not.toContain("google-adsense-account");
    }
  });
});
