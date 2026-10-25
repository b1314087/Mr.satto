import { test, expect } from "@playwright/test";
import { PREMIUM_PRICE_YEN } from "@/lib/plans/types";

/**
 * AI有料プランの公開時の構成（課金オン・広告オフ）の回帰テスト。
 *
 * 公開時の本番は、課金だけをオンにし、広告はオフのままにする想定。
 * 開発サーバーでこの状態を再現するため、NEXT_PUBLIC_FEATURES_OFF=ads を付けて起動した場合にだけ実行する
 * （通常の `npm test` ではスキップされる）。実行方法:
 *
 *   npm run test:launch-config
 *
 * 実際のStripe・Supabase・OpenAIには一切触れない（環境変数は未設定のまま）。
 */
test.describe("公開時の構成: 課金オン・広告オフ", () => {
  test.skip(
    process.env.NEXT_PUBLIC_FEATURES_OFF !== "ads",
    "NEXT_PUBLIC_FEATURES_OFF=ads で起動した開発サーバーでのみ実行（npm run test:launch-config）",
  );

  test("料金ページ: プレミアム月額1,100円（税込）を案内し、広告視聴・旧Standardの文言を出さない", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByTestId("feature-unavailable")).toHaveCount(0);
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    expect(text).toContain(`${PREMIUM_PRICE_YEN.toLocaleString("ja-JP")}円`);
    expect(text).not.toContain("広告視聴あり");
    expect(text).not.toContain("Standard");
    expect(text).not.toContain("550円");
    expect(text).not.toContain("有効になった後"); // 将来の広告の予定を、現行の説明に出さない
  });

  test("料金ページ: 広告を出していない間は「広告なし」を特典にせず、実在しない「プレミアム対象ツール」も書かない。AIの利用枠と外部送信を説明する", async ({ page }) => {
    await page.goto("/pricing");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    expect(text).not.toContain("広告なし");
    expect(text).not.toContain("プレミアム対象ツール");
    expect(text).toContain("現在、広告は表示されません"); // 無料プランの実際の状態
    expect(text).toContain("AIの利用枠は、請求期間ごとに上限があり");
    expect(text).toContain("AIトークン");
    expect(text).toContain("OpenAI");
    expect(text).toContain("必ずご自身で確認してください");
    // 年度カレンダー作成の通常処理は無料のまま（AIを使わない）
    expect(text).toContain("通常の年度カレンダー作成は無料（AIは使いません）");
  });

  test("フッター・トップ・運営者情報: 通常ツールはブラウザ処理、AI機能だけが同意のうえで外部送信されると区別して説明する", async ({ page }) => {
    for (const path of ["/", "/about"]) {
      await page.goto(path);
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      expect(text, path).toContain("AIで読み取る機能");
      expect(text, path).toContain("外部のAIサービスへ送信します");
    }
    await page.goto("/tools/fiscal-calendar");
    const footer = (await page.locator("footer").innerText()).replace(/\s+/g, " ");
    expect(footer).toContain("サーバーには保存されません");
    expect(footer).toContain("同意のうえで選んだ内容を外部のAIサービスへ送信します");
  });

  test("トップページ・サイトの紹介・会員登録: 広告を見る前提の文言が出ない", async ({ page }) => {
    for (const path of ["/", "/about", "/signup"]) {
      await page.goto(path);
      const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
      expect(text, path).not.toContain("広告を見れば");
      expect(text, path).not.toContain("Standard");
    }
    await page.goto("/signup");
    await expect(page.locator("main")).toContainText("プレミアムプラン");
  });

  test("通常のツールは、ログインも広告もなしで使える（無料のまま）", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByTestId("download-ad-notice")).toHaveCount(0);
    await expect(page.locator("[data-ad-placement]")).toHaveCount(0);
    await expect(page.locator("ins.adsbygoogle")).toHaveCount(0);
  });

  // ---- 工程10: SEO文（メタディスクリプション・FAQ・FAQPage構造化データ）が、実際の提供状態と食い違わない ----

  async function readSeo(request: import("@playwright/test").APIRequestContext, path: string) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const html = await res.text();
    const decode = (v: string) => v.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
    const description = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? "");
    const jsonLd = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const main = html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? "";
    const visible = decode(main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    return { description, jsonLd: jsonLd.join("\n"), visible };
  }

  test("工程9で指摘された16ツール: 無料で使えるのに「プレミアム専用」と案内しない（説明文・本文のFAQ・構造化データ）", async ({ request }) => {
    const ids = [
      "pdf-to-excel", "pdf-to-word", "word-to-pdf", "excel-to-pdf", "ocr",
      "video-convert", "video-compress", "video-resize", "video-frame-rate", "video-h264", "video-thumbnail", "video-metadata-remove",
      "estimate-generator", "quote-order-generator", "invoice-generator", "order-generator",
    ];
    for (const id of ids) {
      const { description, jsonLd, visible } = await readSeo(request, `/tools/${id}`);
      expect(description, id).not.toContain("プレミアム");
      expect(description, id).toContain("無料で利用できます");
      expect(visible, id).not.toContain("プレミアムプラン専用");
      expect(jsonLd, id).not.toContain("プレミアムプラン専用");
      expect(jsonLd, id).not.toMatch(/Standard|スタンダード/);
      expect(visible, id).toContain("会員登録なしで、無料でご利用いただけます");
    }
  });

  test("カテゴリページ: 説明文・紹介文に「プレミアム専用」「無料・プレミアム」が出ない", async ({ request }) => {
    for (const id of ["pdf", "csv-excel", "word", "video", "other"]) {
      const { description, visible } = await readSeo(request, `/tools/${id}`);
      expect(description, id).not.toContain("プレミアム");
      expect(visible, id).not.toContain("プレミアムプラン専用");
      expect(visible, id).not.toMatch(/Standard|スタンダード/);
    }
  });

  test("記入済みPDF→Excel: 提供していないStandardの説明が説明文・FAQ・構造化データに出ない（1ページまでの制限は案内する）", async ({ request }) => {
    const { description, jsonLd, visible } = await readSeo(request, "/tools/filled-pdf-to-excel");
    for (const text of [description, jsonLd, visible]) expect(text).not.toMatch(/Standard|スタンダード/);
    expect(description).toContain("無料プランは1回1ページまで");
    expect(visible).toContain("プレミアムプランはページ数の制限がありません");
    expect(visible).not.toContain("広告の視聴が必要です");
  });

  test("トップページの構造化データ: 提供していないStandardや、広告を避けるためのプランを案内しない", async ({ request }) => {
    const { jsonLd } = await readSeo(request, "/");
    expect(jsonLd).toContain('"@type":"WebApplication"');
    expect(jsonLd).not.toMatch(/Standard|スタンダード/);
    expect(jsonLd).not.toContain("広告なしで使いたい");
  });

  test("年度カレンダー: 説明文・FAQ・構造化データが、ブラウザ内処理とAI利用時の外部送信を区別している", async ({ request }) => {
    const { description, jsonLd, visible } = await readSeo(request, "/tools/fiscal-calendar");
    expect(description).toContain("AIで読み取る場合");
    expect(description).toContain("外部のAIサービスへ送信");
    expect(visible).toContain("予定表のファイル（Excel・CSV・PDF・画像）を読み込めますか？");
    expect(visible).toContain("Excel（.xlsx）・CSV・PDF・画像（PNG・JPG）");
    expect(visible).toContain("AIで読み取る補助（プレミアムの機能）を使う場合に限り");
    // 構造化データのFAQは、画面のFAQと同じ内容
    expect(jsonLd).toContain("予定表のファイル（Excel・CSV・PDF・画像）を読み込めますか？");
    expect(jsonLd).toContain("外部のAIサービスへ送信されます");
    // 画面の案内（プライバシーポリシーとも一致）にも同じ説明がある
    expect(visible).toContain("同意したときだけ");
  });

  test("生成ツール: 見出し・パンくず・構造化データに「ツールツール」が出ない", async ({ request }) => {
    for (const path of ["/tools/generator", "/tools/fiscal-calendar", "/tools/qr-generator"]) {
      const { jsonLd, visible } = await readSeo(request, path);
      expect(visible, path).not.toContain("ツールツール");
      expect(jsonLd, path).not.toContain("ツールツール");
      expect(jsonLd, path).toContain('"name":"生成ツール"');
    }
  });

  test("ログイン済みでない場合、AI補助とその利用状況のAPIは利用できない", async ({ request }) => {
    const usage = await request.get("/api/ai/usage");
    // 使用量は「使えない」と返す（200）。使用量の数値は返さない
    expect(usage.status()).toBe(200);
    const usageBody = await usage.json();
    expect(usageBody.available).toBe(false);
    expect(usageBody.usage).toBeUndefined();
    const assist = await request.post("/api/ai/calendar-assist", {
      data: { consent: true },
      headers: { origin: "http://localhost:3101" },
    });
    expect([400, 401, 403, 503]).toContain(assist.status());
    const body = await assist.text();
    expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(body).not.toMatch(/stack|at .*\(.*:\d+:\d+\)/);
  });

  test("Stripeの決済・管理APIは、ログインなしでは処理されない（課金オンでも）", async ({ request }) => {
    const checkout = await request.post("/api/stripe/checkout", { data: { plan: "premium" } });
    expect([400, 401, 403, 500, 503]).toContain(checkout.status());
    const portal = await request.post("/api/stripe/portal");
    expect([400, 401, 403, 500, 503]).toContain(portal.status());
  });

  test("Stripe Webhook: 署名がない呼び出しは受け付けない", async ({ request }) => {
    const res = await request.post("/api/stripe/webhook", { data: "{}" });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});
