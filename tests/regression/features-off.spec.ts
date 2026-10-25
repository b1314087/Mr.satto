import { test, expect } from "@playwright/test";
import { uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { fixtures } from "../fixtures/paths";
import { tools } from "@/lib/tools/data";
import { categories } from "@/lib/tools/categories";
import { siteConfig } from "@/lib/config/site";

/**
 * 機能スイッチ（src/lib/config/features.ts）の「広告オフ・課金オフ」状態の回帰テスト。
 *
 * 本番は両スイッチがオフ。開発サーバーでこの状態を再現するため、
 * NEXT_PUBLIC_FEATURES_OFF=1 を付けてサーバーを起動した場合にだけ実行する
 * （通常の `npm test` ではスキップされる）。実行方法:
 *
 *   npm run test:features-off
 *
 * 実際のAd Manager・AdSense・Stripe・Supabaseには一切触れない。
 */
test.describe("機能スイッチ: 広告オフ・課金オフ", () => {
  test.skip(
    process.env.NEXT_PUBLIC_FEATURES_OFF !== "1",
    "NEXT_PUBLIC_FEATURES_OFF=1 で起動した開発サーバーでのみ実行（npm run test:features-off）",
  );

  test("ヘッダーとフッターに、料金・ログイン・特商法の導線が出ない", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    const footer = page.locator("footer");

    await expect(header.getByRole("link", { name: "ツール一覧" })).toBeVisible();
    await expect(header.getByRole("link", { name: "料金プラン" })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "ログイン" })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "アカウント" })).toHaveCount(0);
    await expect(footer.getByRole("link", { name: "料金プラン" })).toHaveCount(0);
    await expect(footer.getByRole("link", { name: "特定商取引法に基づく表記" })).toHaveCount(0);
    // 残すべきリンクは残る
    await expect(footer.getByRole("link", { name: "プライバシーポリシー" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "利用規約" })).toBeVisible();
  });

  for (const path of ["/pricing", "/tokushoho", "/signup", "/account"]) {
    test(`${path} は「準備中」を表示し、検索エンジンには出さない`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId("feature-unavailable")).toBeVisible();
      if (path !== "/account") {
        // /account は元から noindex（個人ページ）。他は課金オフの間 noindex になる
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      }
    });
  }

  test("/login は管理画面などへのログイン用にページを残し、検索には出さない", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
    await expect(page.getByTestId("feature-unavailable")).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("sitemap.xml に料金・ログイン・会員登録・特商法のページが含まれない", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.ok()).toBe(true);
    const xml = await res.text();
    for (const path of ["/pricing", "/login", "/signup", "/tokushoho"]) {
      expect(xml).not.toContain(`${path}</loc>`);
    }
    // ツールのページは残る
    expect(xml).toContain("/tools/image-resize</loc>");
  });

  test("決済（checkout）と決済管理（portal）のAPIは404を返す", async ({ request }) => {
    const checkout = await request.post("/api/stripe/checkout", { data: { plan: "standard" } });
    expect(checkout.status()).toBe(404);
    const portal = await request.post("/api/stripe/portal");
    expect(portal.status()).toBe(404);
  });

  test("Stripe Webhook は何も処理せず、200だけ返す（署名がなくても処理に進まない）", async ({ request }) => {
    const res = await request.post("/api/stripe/webhook", { data: "{}" });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: true });
  });

  test("ツール一覧のカードに、料金区分のバッジ（通常・プレミアム）が出ない", async ({ page }) => {
    await page.goto("/tools");
    await expect(page.locator('a[href^="/tools/"]').first()).toBeVisible();
    const cards = page.locator('a[href^="/tools/"]');
    await expect(cards.getByText("通常", { exact: true })).toHaveCount(0);
    await expect(cards.filter({ hasText: "スタンダード" })).toHaveCount(0);
    await expect(cards.filter({ hasText: "プレミアム" })).toHaveCount(0);
  });

  test("サイトの主なページに、料金プラン・広告に触れた文言が一つも残っていない", async ({ request }) => {
    test.setTimeout(900_000);
    // 画面に出る文章（本文・検索結果用の説明文・構造化データ）を、HTMLから取り出して調べる。
    // about・privacy・terms は、課金・広告の有無そのものを説明するページなので対象外。
    const FORBIDDEN = /プレミアム|スタンダード|Standard|Premium|プラン|料金|有料|月額|サブスク|広告/;
    const paths = [
      "/",
      "/tools",
      ...categories.map((c) => `/tools/${c.id}`),
      ...tools.filter((t) => t.status === "available").map((t) => `/tools/${t.id}`),
    ];

    const problems: string[] = [];
    for (const path of paths) {
      const res = await request.get(path);
      expect(res.status(), `${path} が開けない`).toBe(200);
      const html = await res.text();
      // 構造化データ（application/ld+json）と meta の説明文は残し、それ以外のscript・styleは除く
      const ldJson = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      const metas = [...html.matchAll(/<meta[^>]+(?:name|property)="(?:description|og:description|og:title|twitter:description)"[^>]*>/g)].map(
        (m) => m[0],
      );
      const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
      const bodyText = html
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, " ");
      const haystack = [title, ...metas, ...ldJson, bodyText].join("\n");
      const hit = haystack.match(new RegExp(`.{0,25}(?:${FORBIDDEN.source}).{0,25}`));
      if (hit) problems.push(`${path}: …${hit[0].replace(/\s+/g, " ")}…`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("年度カレンダー作成の予定データ欄に、「AI」「Premium」「画像」など、提供していない機能の案内が出ない", async ({ page }) => {
    await page.goto("/tools/fiscal-calendar");
    const imp = page.getByTestId("events-import");
    await expect(imp).toBeVisible();
    const text = (await imp.innerText()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/AI|Premium|プレミアム|画像/);
    expect(text).toContain("Excel・CSV・PDF");
    const footer = (await page.locator("footer").innerText()).replace(/\s+/g, " ");
    expect(footer).toContain("サーバーに保存されません");
    expect(footer).not.toContain("AI");
  });

  test("ツールページに広告の枠・ダウンロード時の広告の案内が出ない", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await expect(page.locator('input[type="file"]')).toBeAttached();
    await expect(page.getByTestId("download-ad-notice")).toHaveCount(0);
    await expect(page.locator("[data-ad-placement]")).toHaveCount(0);
    await expect(page.locator("ins.adsbygoogle")).toHaveCount(0);
  });

  test("広告の確認画面なしで、処理済みファイルをそのままダウンロードできる", async ({ page }) => {
    await page.goto("/tools/image-resize");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "ダウンロード" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename().length).toBeGreaterThan(0);
    await expect(page.getByTestId("download-gate-dialog")).toHaveCount(0);
  });

  test("広告スクリプトを読み込まない", async ({ page }) => {
    const adRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("googlesyndication.com") || url.includes("doubleclick.net")) adRequests.push(url);
    });
    await page.goto("/");
    await page.goto("/tools/image-resize");
    expect(adRequests).toEqual([]);
  });

  test("プライバシーポリシーと利用規約が、現在の提供内容に合った表記になる", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByText("現在、本サービスは広告を表示していません。")).toBeVisible();
    await expect(page.getByText("現在、本サービスは、会員登録・ログイン・有料プランを一般のご利用者向けには提供していません。", { exact: false })).toBeVisible();

    await page.goto("/terms");
    const notice = page.getByTestId("terms-billing-notice");
    await expect(notice).toBeVisible();
    // 収益化を「一時的に」止めていること、恒久的に無料とするものではないことを明記している
    await expect(notice).toContainText("一時的に停止");
    await expect(notice).toContainText("恒久的に無料とするものではなく");
    await expect(page.getByTestId("terms-current-offering")).toContainText("恒久的に無料で提供することをお約束するものではありません");
  });

  test("利用規約の運営者情報の案内が、「準備中」の特商法ページではなく、問い合わせ窓口を指す", async ({ page }) => {
    await page.goto("/terms");
    const clause = page.getByTestId("terms-contact-clause");
    const formLink = clause.getByRole("link", { name: "お問い合わせフォーム" });
    await expect(formLink).toHaveAttribute("href", siteConfig.contactFormUrl);
    // フォームは新しいタブで開き、開いた先から元のページを操作されないようにする
    await expect(formLink).toHaveAttribute("target", "_blank");
    await expect(formLink).toHaveAttribute("rel", /noopener/);
    await expect(clause.getByRole("link", { name: siteConfig.contactEmail })).toHaveAttribute(
      "href",
      `mailto:${siteConfig.contactEmail}`,
    );
    // 課金オフの間は /tokushoho が「準備中」のため、この問い合わせ条項からはリンクしない
    // （ページの他の箇所ではなく、この条項の中だけを確認する）
    await expect(clause.getByRole("link", { name: "特定商取引法に基づく表記" })).toHaveCount(0);
    await expect(clause.locator('a[href="/tokushoho"]')).toHaveCount(0);
  });

  test("利用規約の第3〜6条は、課金オフの間「定めなし」になり、旧条件が表示されない", async ({ page }) => {
    await page.goto("/terms");
    const main = page.locator("main");

    // 条番号が飛んだり重なったりしていない（第1〜12条の見出しが、この順にすべてある）
    const headings = await main.locator("h2").allTextContents();
    const articleNumbers = headings.map((h) => h.match(/^第(\d+)条/)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
    expect(articleNumbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    // 第3〜6条は、見出しを残したまま「定めなし」になる（この条の中だけを確認する）
    const articles = [
      { title: "第3条（会員登録）", reason: "現在、会員登録は提供していないため、本条は定めていません。" },
      { title: "第4条（料金・お支払い）", reason: "現在、有料プランは提供しておらず、料金のお支払いはないため、本条は定めていません。" },
      { title: "第5条（契約期間・更新・解約）", reason: "現在、有料プランは提供していないため、本条は定めていません。" },
      { title: "第6条（返金）", reason: "現在、お支払いが発生するサービスは提供していないため、本条は定めていません。" },
    ];
    for (const { title, reason } of articles) {
      const article = main.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: title }) });
      await expect(article).toHaveCount(1);
      const body = article.getByTestId("terms-clause-not-provided");
      await expect(body).toContainText(reason);
      await expect(body).toContainText("本規約を改定して定めます（第11条）");
    }

    // 旧条件（具体的な料金・自動更新・返金なし・契約期間）が、規約本文に出ない。
    // 第2条には「月額料金」という語が残るため、「月額」だけでは判定しない
    for (const oldText of [/円（税込）/, "毎月自動で更新", "返金は行いません", "現在の契約期間の終了までは"]) {
      await expect(main).not.toContainText(oldText);
    }

    // 第2条などが指す「第11条」の見出しが、実際にある
    await expect(main.getByRole("heading", { level: 2, name: "第11条（規約の変更）" })).toBeVisible();
  });

  test("会員登録なしの利用案内（aboutページ）が、課金オフの内容になる", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { name: "ご利用料金について" })).toBeVisible();
    await expect(page.getByRole("link", { name: "料金プラン" })).toHaveCount(0);
    // 検索結果に出る説明文にも、実際には提供していない「料金プラン」を出さない
    const description = await page.locator('meta[name="description"]').getAttribute("content");
    expect(description ?? "").not.toContain("料金プラン");
    expect(description ?? "").toContain("対応分野・プライバシー設計について紹介します");
    // 現在は無料でも、恒久的な無料サービスと誤解されない
    await expect(page.getByText("今後、広告の表示や有料プランを導入する場合があります")).toBeVisible();
  });
});
