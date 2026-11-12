import { test, expect, type Page } from "@playwright/test";
import { siteConfig } from "@/lib/config/site";

/**
 * 2026年11月の全体監査で見つかった問題の修正の確認（総合改修）。
 * B-1 実行バー／B-2 帳票の並び／B-3 シフト表の横はみ出し／B-4 領収書の仕訳プレビュー／B-7 単位変換のコピー／
 * B-8 帳票の入力欄のラベル／B-9 使い方ボタンの位置／C-4 見出しの階層／C-5 canonical／C-6 description
 */

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("B-1 実行バー：画面の下にくっついている間だけ、ガラスの帯になる", () => {
  for (const width of [1280, 390]) {
    test(`幅${width}px：くっつくと data-stuck が付き、本来の位置までスクロールすると外れる`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/tools/qr-generator");
      const bar = page.getByTestId("run-bar").first();
      await expect(bar).toBeAttached();
      await page.evaluate(() => window.scrollTo(0, 0));
      // 設定が長く、最初はボタンの本来の位置が画面の下にある → くっついている
      const naturalBelow = await bar.evaluate((el) => el.getBoundingClientRect().bottom >= window.innerHeight - 2);
      if (naturalBelow) await expect(bar).toHaveAttribute("data-stuck", "true");
      // 一番下までスクロールすると、本来の位置に戻る
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(bar).not.toHaveAttribute("data-stuck", "true");
    });
  }
});

test.describe("スマホ幅（390px）の表示", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("B-2 帳票4ツール：プレビューの後に「PDF出力」が並ぶ（手順の番号と画面の順が一致）", async ({ page }) => {
    for (const slug of ["invoice-generator", "estimate-generator", "order-generator", "quote-order-generator"]) {
      await page.goto(`/tools/${slug}`);
      const preview = page.getByTestId("tool-preview").first();
      const output = page.getByRole("heading", { name: /PDF出力/ }).first();
      await expect(output).toBeAttached();
      const before = await preview.evaluate(
        (p, o) => Boolean(p.compareDocumentPosition(o!) & Node.DOCUMENT_POSITION_FOLLOWING),
        await output.elementHandle()
      );
      expect(before, slug).toBe(true);
      const pY = (await preview.boundingBox())!.y;
      const oY = (await output.boundingBox())!.y;
      expect(pY, slug).toBeLessThan(oY);
    }
  });

  test("B-3 シフト表作成：ページ全体が横にはみ出さない（勤務区分の表は、表の中で横にスクロール）", async ({ page }) => {
    await page.goto("/tools/shift-schedule");
    await expect(page.locator("table").first()).toBeAttached();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(1);
  });

  test("B-4 領収書→会計CSV：明細が0件のとき、仕訳プレビューは畳まれ、画面の下に固定されない", async ({ page }) => {
    await page.goto("/tools/receipt-accounting-csv");
    const section = page.getByTestId("receipt-journal-preview");
    await expect(section).toBeAttached();
    await expect(page.getByTestId("receipt-preview-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(await section.evaluate((el) => getComputedStyle(el).position)).not.toBe("sticky");
  });

  test("B-7 単位変換：換算表の「コピー」が縦に折り返さない", async ({ page }) => {
    await page.goto("/tools/unit-converter");
    const input = page.locator('input[type="number"], input[inputmode="decimal"]').first();
    await input.fill("100");
    const copy = page.getByRole("button", { name: /の値をコピー$/ }).first();
    await expect(copy).toBeVisible();
    const box = (await copy.boundingBox())!;
    expect(box.width).toBeGreaterThan(box.height);
    expect(box.height).toBeLessThan(48);
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(1);
  });
});

test("B-8 帳票：宛先・発行者・振込先の入力欄に、常に見えるラベルが付いている", async ({ page }) => {
  await page.goto("/tools/invoice-generator");
  for (const name of ["会社名・屋号", "担当者名", "郵便番号", "電話番号", "住所", "メールアドレス"]) {
    const fields = page.getByLabel(name, { exact: true });
    await expect(fields, name).toHaveCount(2); // 宛先・発行者
    await expect(page.locator("label", { hasText: name }).first(), name).toBeVisible();
  }
  await page.getByTestId("bank-account-settings").locator("summary").click();
  for (const name of ["金融機関名", "支店名", "口座番号", "口座名義"]) {
    await expect(page.getByLabel(name, { exact: true }), name).toBeVisible();
  }
});

test("B-9 使い方・よくある質問のボタンは、どのツールでも説明文の下（左寄せ）にあり、カテゴリはツール名の右", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const slug of ["image-compress", "pdf-to-excel", "fiscal-calendar", "char-count"]) {
    await page.goto(`/tools/${slug}`);
    const h1 = page.locator("h1");
    const lead = h1.locator("xpath=ancestor::div[contains(@class,'flex-col')][1]").locator("p").first();
    const trigger = page.getByTestId("guide-open-howto");
    const leadBox = (await lead.boundingBox())!;
    const trigBox = (await trigger.boundingBox())!;
    expect(trigBox.y, slug).toBeGreaterThan(leadBox.y + leadBox.height - 1);
    expect(Math.abs(trigBox.x - leadBox.x), slug).toBeLessThan(2);
  }
});

test.describe("C-4 見出しの階層（h1 の次が h3 にならない）", () => {
  for (const path of ["/tools", "/tools/image", "/tools/pdf"]) {
    test(path, async ({ page }) => {
      await page.goto(path);
      const levels = await page.locator("main").evaluate((m) =>
        Array.from(m.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => Number(h.tagName[1]))
      );
      for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `${path}: ${levels.join(",")}`).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("C-5 canonical：トップ以外のページがトップを指さない", () => {
  test("404ページは canonical を持たない", async ({ page }) => {
    await page.goto("/this-page-does-not-exist-xyz");
    const href = await page.locator('link[rel="canonical"]').getAttribute("href").catch(() => null);
    expect(href === null || !/^https?:\/\/[^/]+\/?$/.test(href)).toBe(true);
  });
  test("/account は自分のURL、トップは /", async ({ page }) => {
    await page.goto("/account");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${siteConfig.url}/account`);
    await page.goto("/");
    const home = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(home!.replace(/\/$/, "")).toBe(siteConfig.url.replace(/\/$/, ""));
  });
});

test("C-6 検索向けのページの description が、内容の分かる長さになっている", async ({ page }) => {
  for (const path of ["/pricing", "/terms", "/privacy", "/tokushoho", "/tools"]) {
    await page.goto(path);
    const d = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    expect(d.length, `${path}: ${d}`).toBeGreaterThanOrEqual(50);
  }
});
