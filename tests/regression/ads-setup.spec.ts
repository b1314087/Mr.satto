import { test, expect } from "@playwright/test";

/**
 * 広告(Google AdSense)の設定の回帰テスト。
 *
 * - /ads.txt が正しい書式で公開されている(AdSenseの収益化・不正対策に必要)
 * - CSPが、AdSense・Googleの同意メッセージが使うドメインを許可している一方で、
 *   "https:" のような包括的な許可をscript-srcに入れていない
 *
 * 実際の広告配信(広告が表示されること)は、本番のドメイン・発行者IDでしか確認できないため、
 * このテストの対象外(本番で目視確認する)。
 */

test("ads.txt: AdSenseの発行者IDが正しい書式で公開されている", async ({ request }) => {
  const res = await request.get("/ads.txt");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"] ?? "").toContain("text/plain");
  const lines = (await res.text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  expect(lines.length).toBeGreaterThan(0);
  // 書式: <広告システムのドメイン>, <発行者ID>, <DIRECT|RESELLER>, <認定機関ID>
  for (const line of lines) {
    expect(line, `ads.txtの書式が不正です: ${line}`).toMatch(/^google\.com, pub-\d{10,20}, DIRECT, f08c47fec0942fa0$/);
  }
});

test("CSP: 広告・同意メッセージのドメインを許可し、script-srcに包括的な許可を入れていない", async ({ request }) => {
  const res = await request.get("/");
  const csp = res.headers()["content-security-policy"] ?? "";
  const directive = (name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

  const script = directive("script-src");
  expect(script).toContain("https://pagead2.googlesyndication.com");
  expect(script).toContain("https://fundingchoicesmessages.google.com");
  // 包括的な許可("https:" "*" "http:")は入れない
  expect(script.split(/\s+/)).not.toContain("https:");
  expect(script.split(/\s+/)).not.toContain("*");

  expect(directive("connect-src")).toContain("https://ep1.adtrafficquality.google");
  expect(directive("connect-src")).toContain("https://fundingchoicesmessages.google.com");
  expect(directive("frame-src")).toContain("https://googleads.g.doubleclick.net");
  expect(directive("frame-src")).toContain("https://fundingchoicesmessages.google.com");
  expect(directive("img-src")).toContain("https://pagead2.googlesyndication.com");

  // 広告を許可しても、他の重要な防御は維持されている
  expect(directive("object-src")).toBe("object-src 'none'");
  expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
});
