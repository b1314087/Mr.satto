import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { categories } from "@/lib/tools/categories";
import { getFeaturedTools, getListedTools, getToolById, tools } from "@/lib/tools/data";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { searchTools } from "@/lib/tools/search";
import { siteConfig } from "@/lib/config/site";

/**
 * UI刷新・第3工程（ニュートラル背景・トップページ再構成・ツールカードのガラス化）のテスト。
 *  1. トップ: 「おすすめツール」の表示だけが消え、featured・関連ツールのしくみは残る
 *  2. トップ: 検索 → カテゴリの構成、ファーストビュー、リンク先
 *  3. ツールカード（全ツール一覧・カテゴリ別・関連ツール）のガラス化、準備中の区別、リンク先
 *  4. 背景がニュートラル（青のグラデーションなし）、ライト・ダークでの読みやすさ
 *  5. スマホ・タブレットでの崩れ、キーボード・メニュー
 *  6. SEO（タイトル・canonical・構造化データ・サイトマップ）が変わらない
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const available = () => getListedTools().filter((t) => t.status === "available");
const main = (page: Page) => page.locator("main");

// ---------------------------------------------------------------------------
// 色の計算（WCAGのコントラスト比）。ブラウザが返す lab() 等は canvas で rgb に直す
// ---------------------------------------------------------------------------
type Rgb = [number, number, number];
const luminance = ([r, g, b]: Rgb) => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

async function colorsOf(page: Page, selector: string): Promise<{ fg: Rgb; bg: Rgb }> {
  return page.locator(selector).first().evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const toRgba = (c: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    let bg: [number, number, number] = [255, 255, 255];
    const layers: [number, number, number, number][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) layers.push(toRgba(getComputedStyle(n).backgroundColor));
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const [r, g, b] = toRgba(getComputedStyle(el).color);
    return { fg: [r, g, b] as Rgb, bg };
  });
}

// ===========================================================================
// 1. 「おすすめツール」の削除範囲
// ===========================================================================
test.describe("「おすすめツール」の削除", () => {
  test("トップに「おすすめツール」の見出し・セクションがない", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "おすすめツール" })).toHaveCount(0);
    await expect(page.getByText("おすすめツール")).toHaveCount(0);
    // トップに並ぶのは「カテゴリ」のカードだけ。個別ツールのカード（aria-label付きのリンク）は出ない
    await expect(main(page).locator('a[href^="/tools/"][aria-label]')).toHaveCount(0);
  });

  test("トップのソースが getFeaturedTools / ToolGrid に依存していない（表示だけを外した）", () => {
    const src = read("src/app/page.tsx");
    expect(src).not.toContain("getFeaturedTools");
    expect(src).not.toContain("ToolGrid");
    expect(src).not.toContain("おすすめツール");
  });

  test("featured 属性・getFeaturedTools は残っている（登録情報・関連ツールの補完で使う）", () => {
    const featured = getFeaturedTools();
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.every((t) => t.featured === true && t.status === "available" && !t.mergedInto)).toBe(true);
    expect(tools.filter((t) => t.featured).length).toBeGreaterThanOrEqual(featured.length);
    expect(read("src/lib/tools/related-tools.ts")).toContain("t.featured");
    expect(read("src/lib/tools/types.ts")).toContain("featured?: boolean");
  });

  test("関連ツールは従来どおり、同カテゴリが足りない時に featured で補われる", () => {
    // 同カテゴリの候補が極端に少ないツール（PowerPointは1件のみ）で、featuredによる補完が働く
    const pptx = getToolById("pptx-invert")!;
    const { related, sameCategoryCandidateCount } = getRelatedTools(pptx);
    expect(sameCategoryCandidateCount).toBe(0);
    expect(related.length).toBe(4);
    // 工程11: relatedToolIds で指定した「使う場面が近いツール」が先頭に入り、残りが featured で補われる
    const pinnedIds = pptx.relatedToolIds ?? [];
    expect(related.slice(0, pinnedIds.length).map((t) => t.id)).toEqual(pinnedIds);
    expect(related.slice(pinnedIds.length).every((t) => t.featured && t.id !== pptx.id)).toBe(true);
  });

  test("個別ツールページの関連ツールが従来どおり表示され、ガラス調のカードで正しいリンク先を持つ", async ({ page }) => {
    const tool = getToolById("json-to-csv")!;
    const { related, sameCategoryCandidateCount } = getRelatedTools(tool);
    await page.goto(`/tools/${tool.id}`);
    const heading = related.length <= sameCategoryCandidateCount ? `${categories.find((c) => c.id === tool.category)!.name}の他のツール` : "こちらのツールもおすすめです";
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    const cards = main(page).locator('a[href^="/tools/"][aria-label]');
    await expect(cards).toHaveCount(related.length);
    for (const [i, t] of related.entries()) {
      await expect(cards.nth(i)).toHaveAttribute("href", `/tools/${t.id}`);
      await expect(cards.nth(i)).toHaveClass(/ms-glass/);
    }
  });
});

// ===========================================================================
// 2. トップページの構成
// ===========================================================================
test.describe("トップページの構成", () => {
  test("サービス名・タグライン・短い説明が出て、h1は1つだけ", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(siteConfig.name);
    await expect(main(page).getByText(siteConfig.tagline)).toBeVisible();
  });

  test("検索欄が先に、その次にカテゴリが並ぶ（上から順）", async ({ page }) => {
    await page.goto("/");
    const search = main(page).getByRole("searchbox", { name: "ツールを検索" });
    const catHeading = page.getByRole("heading", { name: "カテゴリから探す" });
    const first = await search.boundingBox();
    const second = await catHeading.boundingBox();
    expect(first!.y + first!.height).toBeLessThan(second!.y);
  });

  test("検索欄から既存の検索機能が使える（/tools?q=… へ移動し、結果が絞り込まれる）", async ({ page }) => {
    await page.goto("/");
    const search = main(page).getByRole("searchbox", { name: "ツールを検索" });
    await expect(async () => {
      await search.fill("画像 圧縮");
      await search.press("Enter");
      await expect(page).toHaveURL(/\/tools\?q=/, { timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    const hits = searchTools(available(), "画像 圧縮");
    expect(hits.length).toBeGreaterThan(0);
    await expect(main(page).locator(`a[href="/tools/${hits[0].id}"]`)).toBeVisible();
    await expect(main(page).getByText(`${hits.length}件のツール`)).toBeVisible();
  });

  test("カテゴリカード: categories.ts と同じ並び・名前・件数・リンク先（/tools/<カテゴリID>）", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator('section:has(h2:text("カテゴリから探す")) a[href^="/tools/"]');
    await expect(cards).toHaveCount(categories.length);
    for (const [i, c] of categories.entries()) {
      await expect(cards.nth(i)).toHaveAttribute("href", `/tools/${c.id}`);
      await expect(cards.nth(i)).toContainText(c.name);
      const n = available().filter((t) => t.category === c.id).length;
      await expect(cards.nth(i)).toContainText(`${n}ツール`);
    }
  });

  test("カテゴリカードを選ぶと、そのカテゴリのページへ移動する", async ({ page }) => {
    await page.goto("/");
    const target = categories.find((c) => c.id === "pdf")!;
    await page.locator(`section:has(h2:text("カテゴリから探す")) a[href="/tools/${target.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/tools/${target.id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`${target.name}ツール一覧`);
    // カテゴリページのツールカードも同じガラス調
    const cards = main(page).locator('a[href^="/tools/"][aria-label]');
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(cards.first()).toHaveClass(/ms-glass/);
  });

  test("「全ツール一覧」への導線が従来どおりある（トップ→/tools、全ツールが出る）", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "全ツール一覧 →" }).click();
    await expect(page).toHaveURL(/\/tools$/);
    await expect(main(page).getByText(`${available().length}件のツール`)).toBeVisible();
    const first = available()[0];
    await main(page).locator(`a[href="/tools/${first.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/tools/${first.id}$`));
  });

  test("ファーストビュー: 検索欄とカテゴリの一部が、スクロールなしで見える（PC・スマホ）", async ({ page }) => {
    for (const vp of [
      { width: 1280, height: 720 },
      { width: 390, height: 800 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto("/");
      const search = await main(page).getByRole("searchbox", { name: "ツールを検索" }).boundingBox();
      expect(search!.y + search!.height, `${vp.width}px: 検索欄`).toBeLessThanOrEqual(vp.height);
      const card = await page.locator('section:has(h2:text("カテゴリから探す")) a[href^="/tools/"]').first().boundingBox();
      expect(card!.y, `${vp.width}px: 最初のカテゴリ`).toBeLessThan(vp.height);
    }
  });

  test("説明のカード（ガラス）は2つ。内容が重ならない", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("div.ms-glass:has(h3)")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "ファイルを保存しない" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "会員登録不要ですぐ使える" })).toBeVisible();
  });
});

// ===========================================================================
// 3. ツールカード
// ===========================================================================
test.describe("ツールカード", () => {
  test("全ツール一覧: 全件がガラス調のリンクで、リンク先が /tools/<ID>。クリックで移動できる", async ({ page }) => {
    await page.goto("/tools");
    const cards = main(page).locator('a[href^="/tools/"][aria-label]');
    await expect(cards).toHaveCount(available().length);
    const classes = await cards.evaluateAll((els) => els.map((e) => e.className));
    expect(classes.every((c) => c.includes("ms-glass") && c.includes("ms-glass-interactive"))).toBe(true);
    await cards.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/tools/${available()[1].id}$`));
  });

  test("カード全体が1つのリンク（<a>）で、中身（見出し・説明）はその中にある。JSでの遷移に置き換えていない", async ({ page }) => {
    await page.goto("/tools");
    const first = main(page).locator('a[href^="/tools/"][aria-label]').first();
    expect(await first.evaluate((e) => e.tagName)).toBe("A");
    await expect(first.locator("h3")).toHaveCount(1);
    await expect(first.locator("p")).toHaveCount(1);
    expect(read("src/components/tools/tool-card.tsx")).not.toMatch(/onClick|router\.push/);
  });

  test("カテゴリ別一覧: カードにツールの説明文を出さない（名前・バッジ・リンクは変わらない）。全ツール一覧では説明が残る", async ({ page }) => {
    const imageTools = getListedTools().filter((t) => t.category === "image" && t.status === "available");
    await page.goto("/tools/image");
    const cards = main(page).locator('a[href^="/tools/"][aria-label]');
    await expect(cards).toHaveCount(imageTools.length);
    // どのカードにも説明文（<p>）がなく、名前（<h3>）とリンク先はそのまま
    expect(await cards.evaluateAll((els) => els.map((e) => e.querySelectorAll("p").length))).toEqual(imageTools.map(() => 0));
    await expect(cards.first().locator("h3")).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("href", `/tools/${imageTools[0].id}`);
    await expect(main(page).getByText(imageTools[0].description, { exact: false })).toHaveCount(0);

    // 全ツール一覧（共通のカード）には、これまでどおり説明が出る
    await page.goto("/tools");
    await expect(main(page).locator('a[href^="/tools/"][aria-label]').first().locator("p")).toHaveCount(1);
  });

  test("カテゴリ別一覧: 「通常」のバッジは出さず、AI機能が入っているツールにだけ「AI実装」が出る", async ({ page }) => {
    await page.goto("/tools/image");
    const cards = main(page).locator('a[href^="/tools/"][aria-label]');
    await expect(cards.getByText("通常", { exact: true })).toHaveCount(0);
    // 画像カテゴリでAIが入っているのは背景透過だけ（端末内で動くAIモデル）
    const aiTools = getListedTools().filter((t) => t.category === "image" && t.hasAi && t.status === "available");
    expect(aiTools.map((t) => t.id)).toEqual(["background-remover"]);
    await expect(cards.getByText("AI実装", { exact: true })).toHaveCount(1);
    await expect(main(page).locator('a[href="/tools/background-remover"]').getByText("AI実装", { exact: true })).toHaveCount(1);
    await expect(main(page).locator('a[href="/tools/image-resize"]').getByText("AI実装", { exact: true })).toHaveCount(0);

    // 年度カレンダー（外部AIの補助つき）は、課金が有効な本番設定では「AI実装」が出る
    await page.goto("/tools/generator");
    await expect(main(page).locator('a[href="/tools/fiscal-calendar"]').getByText("AI実装", { exact: true })).toHaveCount(1);
  });

  test("カテゴリ別一覧: 説明文は見出しの右隣に並ぶ（広い画面）", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/tools/image");
    const h1 = await page.getByRole("heading", { level: 1 }).boundingBox();
    const intro = await main(page).locator("p", { hasText: "サーバーへ送られることはありません" }).first().boundingBox();
    expect(h1 && intro).toBeTruthy();
    // 説明文は見出しより右にあり、縦の位置が重なる（同じ行に並ぶ）
    expect(intro!.x).toBeGreaterThan(h1!.x + h1!.width);
    expect(intro!.y).toBeLessThan(h1!.y + h1!.height);
    expect(intro!.y + intro!.height).toBeGreaterThan(h1!.y);
  });

  test("カードの背景はぼかし付きの半透明で、ぼかしが使えない環境用の不透明な既定値もある", async ({ page }) => {
    const css = read("src/app/globals.css");
    // 既定（ぼかし非対応）: ほぼ不透明の面＋境界線。@supports の中でだけ半透明＋ぼかしにする
    expect(css).toMatch(/\.ms-glass \{[^}]*background-color: var\(--ms-surface-glass-solid\)[^}]*border: 1px solid/);
    expect(css).toMatch(/@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\) \{\s*\.ms-glass \{[^}]*backdrop-filter: blur/);
    await page.goto("/tools");
    const cs = await main(page).locator('a[href^="/tools/"][aria-label]').first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { blur: s.backdropFilter, shadow: s.boxShadow, border: s.borderTopWidth };
    });
    expect(cs.blur).toContain("blur");
    expect(cs.shadow).toContain("inset"); // 上端のハイライト
    expect(cs.border).toBe("1px");
  });

  test("準備中カード: 既存の仕様（破線・準備中バッジ・説明つきの名前・ガラスにしない）を維持している（ソース）", () => {
    const src = read("src/components/tools/tool-card.tsx");
    expect(src).toContain("border-dashed");
    expect(src).toContain("準備中");
    expect(src).toContain("（準備中・まだ利用できません）");
    // 準備中は「実装済みと同じ見た目・動き」にしない
    const comingBranch = /isComingSoon\s*\?\s*\/\/[\s\S]*?:\s*glassCardClasses/.exec(src)?.[0] ?? "";
    expect(comingBranch).toContain("border-dashed");
    expect(comingBranch).not.toContain("ms-glass");
    expect(comingBranch).not.toContain("hover:");
  });

  test("準備中のツールがある場合: 破線で、ガラスではなく、準備中バッジが出る（今は0件のためスキップされることがある）", async ({ page }) => {
    const coming = getListedTools().filter((t) => t.status === "coming-soon");
    test.skip(coming.length === 0, "準備中のツールが現在0件");
    await page.goto("/tools");
    const card = main(page).locator(`a[href="/tools/${coming[0].id}"]`);
    await expect(card).toContainText("準備中");
    await expect(card).not.toHaveClass(/ms-glass/);
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
  });

  test("料金区分のバッジ: 「通常」は中立色（青を使わない）。バッジの文言は TOOL_TIER_LABELS を参照", () => {
    const src = read("src/components/tools/tool-card.tsx");
    expect(src).toContain("TOOL_TIER_LABELS");
    expect(src).not.toMatch(/bg-blue-50|text-blue-700/);
  });
});

// ===========================================================================
// 4. 背景・ライト／ダーク
// ===========================================================================
for (const scheme of ["light", "dark"] as const) {
  test.describe(`背景と読みやすさ（${scheme}）`, () => {
    test.use({ colorScheme: scheme });

    test("ページ背景はニュートラルな単色で、青のグラデーション・背景画像がない", async ({ page }) => {
      await page.goto("/");
      const info = await page.evaluate(() => {
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        const images = [...document.querySelectorAll("main, main *")]
          .map((e) => getComputedStyle(e).backgroundImage)
          .filter((v) => v !== "none");
        return { rgb: [r, g, b], images };
      });
      expect(info.rgb).toEqual(scheme === "light" ? [250, 250, 250] : [11, 11, 13]);
      // 3色の差が小さい＝無彩色（青みがない）
      expect(Math.max(...info.rgb) - Math.min(...info.rgb)).toBeLessThanOrEqual(3);
      expect(info.images.filter((v) => /gradient/.test(v))).toEqual([]);
    });

    test("トップの文字（見出し・説明・件数・カテゴリ名・補足）が、背景に対して4.5以上", async ({ page }) => {
      await page.goto("/");
      const targets = [
        "main h1",
        'main p:has-text("面倒な作業を、サッと。")',
        'main p:has-text("ブラウザ上でサッと解決")',
        'main p:has-text("ツール名や作業内容から探せます")',
        'main h2:has-text("カテゴリから探す")',
        'section:has(h2:text("カテゴリから探す")) a[href="/tools/image"] span.block:first-child',
        'section:has(h2:text("カテゴリから探す")) a[href="/tools/image"] span.block:last-child',
        'main a:has-text("全ツール一覧 →")',
        'div.ms-glass h3:has-text("ファイルを保存しない")',
        'div.ms-glass p:has-text("お使いのブラウザ内")',
      ];
      for (const sel of targets) {
        const { fg, bg } = await colorsOf(page, sel);
        expect(contrast(fg, bg), `${sel}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("ツール一覧のカード（見出し・説明・バッジ）が読める。ページ背景とカードは境界線・影で区別される", async ({ page }) => {
      await page.goto("/tools");
      for (const sel of ['main a[aria-label] h3', 'main a[aria-label] p', 'main a[aria-label] span.rounded-full']) {
        const { fg, bg } = await colorsOf(page, sel);
        expect(contrast(fg, bg), sel).toBeGreaterThanOrEqual(4.5);
      }
      const card = await page.locator('main a[aria-label]').first().evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderTopWidth, borderColor: s.borderTopColor, shadow: s.boxShadow };
      });
      expect(card.border).toBe("1px");
      expect(card.shadow).not.toBe("none");
    });

    test("カテゴリカードにキーボードで移動すると、2pxのフォーカス枠が出る", async ({ page }) => {
      await page.goto("/");
      const card = page.locator('section:has(h2:text("カテゴリから探す")) a[href="/tools/image"]');
      await card.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(card).toBeFocused();
      const ring = await card.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor.replace(/\s/g, "") };
      });
      expect(ring).toEqual({ style: "solid", width: "2px", color: scheme === "light" ? "rgb(37,99,235)" : "rgb(96,165,250)" });
    });
  });
}

// ===========================================================================
// 5. スマホ・タブレット・メニュー
// ===========================================================================
for (const width of [390, 768, 1280]) {
  test.describe(`画面幅 ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const route of ["/", "/tools", "/tools/image", "/tools/json-to-csv"]) {
      test(`横スクロールがなく、カードが画面からはみ出さない: ${route}`, async ({ page }) => {
        await page.goto(route);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
        const rights = await page
          .locator('main a[href^="/tools/"]:has(h3), main a[href^="/tools/"]:has(span.block)')
          .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right })));
        for (const r of rights) {
          expect(r.l).toBeGreaterThanOrEqual(0);
          expect(r.r).toBeLessThanOrEqual(width + 0.5);
        }
      });
    }

    test("カテゴリカードの文字が切れず、隣のカードと重ならない（トップ）", async ({ page }) => {
      await page.goto("/");
      const info = await page.locator('section:has(h2:text("カテゴリから探す")) a[href^="/tools/"]').evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          const text = e.querySelector("span.block") as HTMLElement;
          return { l: r.left, r: r.right, t: r.top, b: r.bottom, clipped: text.scrollWidth > text.clientWidth + 1 };
        })
      );
      expect(info.every((i) => !i.clipped)).toBe(true);
      for (let i = 0; i < info.length; i++)
        for (let j = i + 1; j < info.length; j++) {
          const a = info[i], b = info[j];
          const overlap = a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
          expect(overlap, `カード${i}と${j}が重なっている`).toBe(false);
        }
    });
  });
}

test.describe("共通ヘッダー・メニューとの両立", () => {
  test("トップでもハンバーガーメニューが開閉でき、全ツール一覧へ移動できる。ヘッダーは1つ", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("header.ms-bar")).toHaveCount(1);
    const dialog = page.getByRole("dialog", { name: "メニュー" });
    await expect(async () => {
      await page.getByRole("button", { name: "メニューを開く" }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "メニューを開く" })).toBeFocused();
    await expect(async () => {
      await page.getByRole("button", { name: "メニューを開く" }).click();
      await expect(dialog).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await dialog.getByRole("link", { name: "全ツール一覧", exact: true }).click();
    await expect(page).toHaveURL(/\/tools$/);
  });
});

// ===========================================================================
// 6. SEO・URL
// ===========================================================================
test.describe("SEO・URL", () => {
  test("トップ: タイトル・canonical・構造化データ（3件）が維持されている", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(`${siteConfig.name}｜${siteConfig.tagline}`);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonical!.replace(/\/$/, "")).toBe(siteConfig.url.replace(/\/$/, ""));
    const types = await page.locator('script[type="application/ld+json"]').evaluateAll((els) =>
      els.map((e) => JSON.parse(e.textContent ?? "{}")["@type"])
    );
    expect(types).toEqual(expect.arrayContaining(["WebSite", "Organization", "WebApplication"]));
  });

  test("カテゴリページ・ツールページのURLとタイトルが変わらない", async ({ page }) => {
    await page.goto("/tools/image");
    await expect(page).toHaveURL(/\/tools\/image$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("画像ツール一覧");
    await page.goto("/tools/json-to-csv");
    await expect(page).toHaveURL(/\/tools\/json-to-csv$/);
  });

  test("sitemap.xml に、トップ・全ツール一覧・全カテゴリ・全ツールが引き続き載る", async ({ request }) => {
    const xml = await (await request.get("/sitemap.xml")).text();
    expect(xml).toContain("/tools</loc>");
    for (const c of categories) expect(xml).toContain(`/tools/${c.id}</loc>`);
    for (const t of getListedTools().filter((t) => t.status === "available")) expect(xml).toContain(`/tools/${t.id}</loc>`);
  });
});
