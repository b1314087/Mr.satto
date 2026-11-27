import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

/**
 * 2026-11-27：広告の表示はオフでも、AdSenseの発行者IDを設定している間は、
 * プライバシーポリシーに広告配信事業者のCookieの扱いと止め方を記載する（AdSenseの審査・プログラムポリシー対応）。
 * 発行者IDと機能スイッチは読み込み時に決まるので、別のプロセスで環境変数を指定してページをHTMLに書き出して確かめる。
 */
function renderPrivacy(env: Record<string, string>): { version: string; html: string } {
  const out = execFileSync("npx", ["tsx", "tests/legal/scripts/render-privacy.tsx"], {
    env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_ADSENSE_CLIENT_ID: "", ...env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out);
}

test.describe.configure({ timeout: 120_000 });

test("広告オフ・AdSenseの発行者IDあり（今の本番）：広告のCookieの説明と止め方のリンクが出て、版が2026-11-27になる", () => {
  const { version, html } = renderPrivacy({ NEXT_PUBLIC_FEATURES_OFF: "ads", NEXT_PUBLIC_ADSENSE_CLIENT_ID: "ca-pub-0000000000000000" });
  expect(html).toContain('data-testid="privacy-adsense-planned"');
  expect(html).toContain("Google AdSense");
  expect(html).toContain("Cookie（匿名の識別子を含む）");
  expect(html).toContain('href="https://adssettings.google.com/"');
  expect(html).toContain('href="https://www.google.com/policies/technologies/ads/"');
  expect(html).not.toContain("現在、本サービスは広告を表示していません。");
  expect(version).toBe("2026-11-27");
  expect(html).toContain("2026年11月27日");
});

test("広告オフ・AdSenseの発行者IDなし：従来どおり「広告を表示していません」と出る", () => {
  const { html } = renderPrivacy({ NEXT_PUBLIC_FEATURES_OFF: "ads" });
  expect(html).not.toContain('data-testid="privacy-adsense-planned"');
  expect(html).toContain("現在、本サービスは広告を表示していません。");
});
