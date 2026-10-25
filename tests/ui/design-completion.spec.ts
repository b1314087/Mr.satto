import { test, expect } from "@playwright/test";
import { categories } from "@/lib/tools/categories";
import { getListedTools } from "@/lib/tools/data";

/**
 * UI刷新・第6工程（サイト全体のデザイン完成）のテスト。
 *  1. 背景の光・ロゴ・色分けカテゴリアイコン（絵文字をやめた）が、主要ページに出ている
 *  2. ホーム（見出し構造は変えない）、ツール一覧（PCは左のカテゴリ列／スマホは選択ボタン）
 *  3. ツール画面の外枠は背景ぼかしを使わない（使うと、広告確認ダイアログなど position: fixed の部品が
 *     画面ではなく外枠を基準に配置され、スマホで画面からはみ出す）
 *  4. 主要ページ・案内ページで、スマホ幅でも横スクロールが出ない
 */

const available = () => getListedTools().filter((t) => t.status === "available");

test.describe("共通の見た目（背景・ロゴ・アイコン）", () => {
  test("背景の光は装飾（aria-hidden・クリックを妨げない）で、ページ背景そのものは単色のまま", async ({ page }) => {
    await page.goto("/");
    const info = await page.locator(".ms-ambient").evaluate((el) => {
      const s = getComputedStyle(el);
      return { hidden: el.getAttribute("aria-hidden"), pe: s.pointerEvents, pos: s.position, z: s.zIndex };
    });
    expect(info).toEqual({ hidden: "true", pe: "none", pos: "fixed", z: "-1" });
    const bodyImage = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    expect(bodyImage).toBe("none");
  });

  test("ヘッダーとフッターにロゴマーク（SVG）が出て、サービス名の文字も併記される", async ({ page }) => {
    await page.goto("/about");
    for (const scope of ["header.ms-bar", "footer"]) {
      await expect(page.locator(`${scope} svg[aria-hidden="true"]`).first()).toBeVisible();
    }
    await expect(page.locator("header.ms-bar").getByRole("link", { name: "Mr.Satto" })).toBeVisible();
  });

  test("ホーム: すべてのカテゴリに、色分けしたアイコンタイルが付く（名前・件数は文字で残る）", async ({ page }) => {
    await page.goto("/");
    const section = page.locator('section:has(h2:text("カテゴリから探す"))');
    for (const c of categories) {
      const card = section.locator(`a[href="/tools/${c.id}"]`);
      await expect(card.locator(`span.ms-tile[data-cat="${c.id}"]`)).toHaveCount(1);
      await expect(card).toContainText(c.name);
      await expect(card).toContainText("ツール");
    }
  });

  test("ホーム: 見出しはh1が1つだけ（サービス名）。キャッチコピーは大きな見出し風の段落で、検索欄には青い丸の検索ボタンがある", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mr.Satto");
    const size = await page.locator('main p:has-text("面倒な作業を、サッと。")').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(36);
    await expect(page.getByRole("button", { name: "検索する" })).toBeVisible();
  });

  test("ホーム: 検索ボタン（青い丸）でも、Enterと同じく /tools?q=… へ移動する", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("searchbox", { name: "ツールを検索" }).last().fill("画像 圧縮");
    await page.getByRole("button", { name: "検索する" }).click();
    await expect(page).toHaveURL(/\/tools\?q=/);
  });
});

test.describe("ツール一覧のカテゴリ列", () => {
  test("PC幅: 左にカテゴリ列（件数つき）が出て、選ぶと絞り込まれ、選択中は aria-pressed で示される", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/tools");
    const side = page.getByRole("complementary", { name: "カテゴリで絞り込む" });
    await expect(side).toBeVisible();
    await expect(side.getByRole("button")).toHaveCount(categories.length + 1);
    await expect(side.getByRole("button", { name: "すべて", exact: true })).toHaveAttribute("aria-pressed", "true");

    const pdf = available().filter((t) => t.category === "pdf").length;
    await side.getByRole("button", { name: "PDF", exact: true }).click();
    await expect(side.getByRole("button", { name: "PDF", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("main").getByText(`${pdf}件のツール`, { exact: true })).toBeVisible();
    // 件数は表示専用（アクセシブルネームには含めない）
    await expect(side.getByRole("button", { name: "PDF", exact: true }).locator(".ms-side-count")).toHaveText(String(pdf));
  });

  test("スマホ幅: 左の列は出ず、横に並ぶ選択ボタンで絞り込める", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/tools");
    await expect(page.getByRole("complementary", { name: "カテゴリで絞り込む" })).toBeHidden();
    await page.locator("main").getByRole("button", { name: "動画", exact: true }).click();
    await expect(page.locator("main").getByRole("button", { name: "動画", exact: true })).toHaveAttribute("aria-pressed", "true");
    const video = available().filter((t) => t.category === "video").length;
    await expect(page.locator("main").getByText(`${video}件のツール`, { exact: true })).toBeVisible();
  });
});

test.describe("ツール画面の外枠", () => {
  test("外枠は背景ぼかしを使わない（position: fixed のダイアログが画面基準で出るように）", async ({ page }) => {
    await page.goto("/tools/json-formatter");
    const panel = page.locator(".ms-tool-panel");
    await expect(panel).toHaveCount(1);
    const filter = await panel.evaluate((el) => {
      const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
      return { b: s.backdropFilter, w: s.webkitBackdropFilter ?? "none" };
    });
    expect(filter.b === "none" || filter.b === "").toBe(true);
    expect(filter.w === "none" || filter.w === "").toBe(true);
    // 外枠の背景と境界線がある（ガラス調の面として見える）
    const look = await panel.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, shadow: s.boxShadow };
    });
    expect(look.border).toBe("1px");
    expect(look.shadow).not.toBe("none");
  });

  test("ファイル選択欄に、見た目だけの「ファイルを選択」ボタンが付くが、アクセシブルな名前は変わらない", async ({ page }) => {
    await page.goto("/tools/excel-csv-convert");
    const zone = page.getByRole("button", { name: /Excelファイル（.xlsx）をドラッグ&ドロップ/ });
    await expect(zone).toBeVisible();
    const cta = await zone.locator(".ms-dropzone-cta").evaluate((el) => getComputedStyle(el, "::after").content);
    expect(cta).toContain("ファイルを選択");
    await expect(zone.locator(".ms-dropzone-cta")).toHaveAttribute("aria-hidden", "true");
  });
});

test.describe("スマホ幅で横スクロールが出ない（デザイン変更後の主要ページ）", () => {
  for (const route of ["/", "/tools", "/tools/pdf", "/tools/excel-csv-convert", "/pricing", "/terms", "/privacy", "/about", "/login", "/licenses"]) {
    test(`${route}`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto(route);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("ダークモード", () => {
  test.use({ colorScheme: "dark" });

  test("ロゴの光沢は暗い背景でも目立ちすぎない（半透明の白）。カテゴリのタイルも暗い面に変わる", async ({ page }) => {
    await page.goto("/");
    const shine = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ms-brand-shine").trim());
    // ブラウザは値を rgba() または #rrggbbaa のどちらかの書き方で返す（0.08 ≒ 0x14）
    expect(["rgba(255, 255, 255, 0.08)", "#ffffff14"]).toContain(shine);
    const bg = await page.locator('.ms-tile[data-cat="image"]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    // ライトの #e7efff（231,239,255）ではなく、暗い半透明の青
    expect(bg).not.toBe("rgb(231, 239, 255)");
  });
});
