import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { categories } from "@/lib/tools/categories";
import { getListedTools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import { waitForFileInputHydrated } from "../helpers/tool-ready";

/**
 * UI刷新・第2工程（全ページ共通ヘッダーとハンバーガーメニュー）のテスト。
 *  1. ヘッダーが二重表示されない／画面幅ごとの出し分け
 *  2. メニューの開閉（ボタン・閉じるボタン・外側クリック・Escape）、フォーカスの戻り
 *  3. メニュー項目のリンク先（カテゴリは categories.ts と一致）と、選んだ時の移動
 *  4. メニューを開閉してもツールの入力・変換結果・エラーが消えない（画面が作り直されない）
 *  5. 検索（ヘッダー・メニュー内・狭い画面）が従来どおり動く
 *  6. ライト／ダークの読みやすさ、スマホ幅で横スクロール・重なりがない
 *  7. キーボード操作・フォーカス表示、視覚効果を減らす設定
 */

const SCHEMES = ["light", "dark"] as const;
const TOOL_PAGE = "/tools/json-to-csv";
const SAMPLE_JSON = '[{"name":"田中","age":20},{"name":"佐藤","age":25}]';

const menuButton = (page: Page) => page.getByRole("button", { name: "メニューを開く" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "メニュー" });
const drawerLink = (page: Page, name: string) => drawer(page).getByRole("link", { name, exact: true });
const jsonInput = (page: Page) => page.getByRole("textbox", { name: /入力/ });
const resultBox = (page: Page) => page.getByRole("textbox", { name: /変換結果/ });

/** 画面（ヘッダーのメニューボタン）が操作できるようになるまで待つ。準備前のクリックは無視されるため */
async function openMenu(page: Page) {
  await expect(async () => {
    await menuButton(page).click();
    await expect(drawer(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

async function gotoToolPage(page: Page) {
  await page.goto(TOOL_PAGE);
  await expect(jsonInput(page)).toBeVisible({ timeout: 30_000 });
  await waitForFileInputHydrated(page).catch(() => undefined);
}

/** 画面の準備（hydration）が終わってから入力する。準備前の入力はReactに無視されることがあるため */
async function fillJson(page: Page, value: string) {
  await expect(async () => {
    await jsonInput(page).fill(value);
    await expect(jsonInput(page)).toHaveValue(value, { timeout: 1_000 });
    // 入力に反応してプレビューが出る＝Reactが入力を受け取っている
    await expect(page.getByText("CSVのプレビュー")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// 色の計算（WCAGのコントラスト比）。ブラウザが返す lab() 等の色は canvas で rgb に直す
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

/** 要素の文字色と、実際に見えている背景色（親をたどって不透明な色まで重ねる）を rgb で返す */
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
    for (const [r, g, b, a] of layers.reverse()) {
      bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    }
    const [r, g, b] = toRgba(getComputedStyle(el).color);
    return { fg: [r, g, b] as Rgb, bg };
  });
}

// ===========================================================================
// 1. ヘッダー
// ===========================================================================
test.describe("共通ヘッダー", () => {
  test("layout.tsx で1回だけ描画され、ヘッダー本体の実装は1か所にある（ソース）", () => {
    const layout = fs.readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout.match(/<Header\s*\/>/g)).toHaveLength(1);
    // 他のファイルが Header を直接描画していない（二重表示の原因を作らない）
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx$/.test(e.name) && p !== path.join(process.cwd(), "src/app/layout.tsx")) {
          if (/<Header\s*\/>/.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });

  for (const route of ["/", "/tools", TOOL_PAGE, "/about", "/privacy"]) {
    test(`ヘッダーが1つだけ表示される: ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.locator("header.ms-bar")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "メニューを開く" })).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Mr.Satto" }).first()).toBeVisible();
    });
  }

  test("PC幅: ツール一覧・検索欄・テーマ切り替えがヘッダーに並び、スマホ用の検索ボタンは出ない", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const header = page.locator("header.ms-bar");
    await expect(header.getByRole("link", { name: "ツール一覧" })).toBeVisible();
    await expect(header.getByRole("searchbox", { name: "ツールを検索" })).toBeVisible();
    await expect(header.getByRole("radiogroup", { name: "テーマ切り替え" })).toBeVisible();
    await expect(header.getByRole("button", { name: "ツールを検索" })).toBeHidden();
  });

  test("スマホ幅: ヘッダーは1行（メニュー・ロゴ・検索ボタン）。検索欄とテーマ切り替えはメニュー側へ", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    const header = page.locator("header.ms-bar");
    await expect(header.getByRole("button", { name: "メニューを開く" })).toBeVisible();
    await expect(header.getByRole("button", { name: "ツールを検索" })).toBeVisible();
    await expect(header.getByRole("searchbox")).toBeHidden();
    await expect(header.getByRole("radiogroup", { name: "テーマ切り替え" })).toBeHidden();
    const box = await header.boundingBox();
    expect(box!.height, "ヘッダーが高すぎる（本文を押し下げている）").toBeLessThanOrEqual(64);
  });
});

// ===========================================================================
// 2. 開閉
// ===========================================================================
test.describe("メニューの開閉", () => {
  test("閉じている間はメニューの項目がDOM上に無く、開くと見える（aria-expanded も切り替わる）", async ({ page }) => {
    await page.goto("/");
    await expect(drawer(page)).toBeHidden();
    await expect(page.getByRole("link", { name: "全ツール一覧" })).toHaveCount(0);
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
    await openMenu(page);
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
    await expect(drawerLink(page, "全ツール一覧")).toBeVisible();
  });

  test("閉じるボタンで閉じ、フォーカスがメニューボタンへ戻る", async ({ page }) => {
    await page.goto("/");
    await openMenu(page);
    await drawer(page).getByRole("button", { name: "メニューを閉じる" }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("Escapeで閉じ、フォーカスがメニューボタンへ戻る", async ({ page }) => {
    await page.goto("/");
    await openMenu(page);
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
  });

  test("メニューの外（暗い背景）をクリックすると閉じる。メニュー内のクリックでは閉じない", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await openMenu(page);
    await drawer(page).getByRole("heading", { name: "メニュー" }).click();
    await expect(drawer(page)).toBeVisible();
    await page.mouse.click(1100, 400);
    await expect(drawer(page)).toBeHidden();
  });

  test("開いている間は背後のページがスクロールしない設定になり、閉じると戻る", async ({ page }) => {
    await page.goto("/");
    await openMenu(page);
    await expect(page.locator("html")).toHaveClass(/ms-scroll-lock/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(page.locator("html")).not.toHaveClass(/ms-scroll-lock/);
  });

  test("開閉してもURLは変わらない（ルート遷移を起こさない）", async ({ page }) => {
    await gotoToolPage(page);
    const url = page.url();
    for (let i = 0; i < 3; i++) {
      await openMenu(page);
      await page.keyboard.press("Escape");
      await expect(drawer(page)).toBeHidden();
    }
    expect(page.url()).toBe(url);
  });
});

// ===========================================================================
// 3. 項目とリンク先
// ===========================================================================
test.describe("メニューの項目とリンク先", () => {
  test("ホーム・全ツール一覧・カテゴリ（categories.ts と同じ並び）・サービス情報のリンク先が正しい", async ({ page }) => {
    await page.goto("/about");
    await openMenu(page);
    await expect(drawerLink(page, "ホーム")).toHaveAttribute("href", "/");
    await expect(drawerLink(page, "全ツール一覧")).toHaveAttribute("href", "/tools");

    const catNav = drawer(page).getByRole("navigation", { name: "カテゴリ" });
    const links = catNav.getByRole("link");
    await expect(links).toHaveCount(categories.length);
    for (let i = 0; i < categories.length; i++) {
      await expect(links.nth(i)).toHaveAttribute("href", `/tools?category=${categories[i].id}`);
      await expect(links.nth(i)).toContainText(categories[i].name);
    }

    await expect(drawerLink(page, "プライバシーポリシー")).toHaveAttribute("href", "/privacy");
    await expect(drawerLink(page, "利用規約")).toHaveAttribute("href", "/terms");
    await expect(drawerLink(page, "Mr.Sattoについて")).toHaveAttribute("href", "/about");
  });

  test("現在のページは aria-current で示される（ホーム／カテゴリ選択中）", async ({ page }) => {
    await page.goto("/");
    await openMenu(page);
    await expect(drawerLink(page, "ホーム")).toHaveAttribute("aria-current", "page");
    await expect(drawerLink(page, "全ツール一覧")).not.toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");

    await page.goto("/tools?category=pdf");
    await openMenu(page);
    await expect(drawerLink(page, "PDF")).toHaveAttribute("aria-current", "page");
    await expect(drawerLink(page, "全ツール一覧")).not.toHaveAttribute("aria-current", "page");
    await expect(drawerLink(page, "ホーム")).not.toHaveAttribute("aria-current", "page");
  });

  test("リンクを選ぶと、そのページへ移動し、メニューは閉じる", async ({ page }) => {
    await page.goto("/about");
    await openMenu(page);
    await drawerLink(page, "ホーム").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(drawer(page)).toBeHidden();

    await openMenu(page);
    await drawerLink(page, "PDF").click();
    await expect(page).toHaveURL(/\/tools\?category=pdf$/);
    await expect(drawer(page)).toBeHidden();
    const pdfTools = getListedTools().filter((t) => t.category === "pdf" && t.status === "available");
    await expect(page.locator("main").getByText(`${pdfTools.length}件のツール`)).toBeVisible();
  });

  test("すでにツール一覧を開いていても、メニューのカテゴリ・全ツール一覧に一覧の絞り込みが追随する", async ({ page }) => {
    await page.goto("/tools");
    const available = (cat?: string) =>
      getListedTools().filter((t) => t.status === "available" && (!cat || t.category === cat)).length;
    const main = page.locator("main");
    await expect(main.getByText(`${available()}件のツール`)).toBeVisible();

    await openMenu(page);
    await drawerLink(page, "画像").click();
    await expect(page).toHaveURL(/category=image/);
    await expect(main.getByText(`${available("image")}件のツール`)).toBeVisible();

    await openMenu(page);
    await drawerLink(page, "全ツール一覧").click();
    await expect(page).toHaveURL(/\/tools$/);
    await expect(main.getByText(`${available()}件のツール`)).toBeVisible();
  });

  test("Ctrl/⌘クリック（別タブで開く操作）ではメニューを閉じない", async ({ page }) => {
    await page.goto("/about");
    await openMenu(page);
    await drawerLink(page, "利用規約").click({ modifiers: ["Control"] }).catch(() => undefined);
    await expect(drawer(page)).toBeVisible();
    await expect(page).toHaveURL(/\/about$/);
  });
});

// ===========================================================================
// 4. 入力状態の保持（最重要）
// ===========================================================================
test.describe("ツールの入力状態がメニューの開閉で消えない", () => {
  /** 開閉の方法: [名前, 開く→閉じる操作] */
  const WAYS: [string, (p: Page) => Promise<void>][] = [
    ["Escape", async (p) => void (await openMenu(p), await p.keyboard.press("Escape"))],
    [
      "閉じるボタン",
      async (p) => void (await openMenu(p), await drawer(p).getByRole("button", { name: "メニューを閉じる" }).click()),
    ],
    [
      "外側クリック",
      async (p) => {
        await openMenu(p);
        await p.mouse.click(1100, 400);
      },
    ],
  ];

  for (const [way, op] of WAYS) {
    test(`入力・変換結果・画面の部品が残る（${way}で閉じる）`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await gotoToolPage(page);
      await fillJson(page, SAMPLE_JSON);
      await page.getByRole("button", { name: "CSVに変換する" }).click();
      await expect(resultBox(page)).toBeVisible();
      const csv = await resultBox(page).inputValue();
      expect(csv).toContain("田中");

      // 画面の部品に目印を付ける。作り直し（再マウント）が起きれば目印は消える
      await page.evaluate(() => {
        (document.querySelector("textarea") as HTMLElement & { __ms?: string }).__ms = "same-node";
        (document.querySelector("main") as HTMLElement & { __ms?: string }).__ms = "same-main";
      });

      await op(page);
      await expect(drawer(page)).toBeHidden();

      await expect(jsonInput(page)).toHaveValue(SAMPLE_JSON);
      await expect(resultBox(page)).toHaveValue(csv);
      await expect(page.getByRole("button", { name: ".csvをダウンロード" })).toBeVisible();
      const marks = await page.evaluate(() => ({
        textarea: (document.querySelector("textarea") as (HTMLElement & { __ms?: string }) | null)?.__ms,
        main: (document.querySelector("main") as (HTMLElement & { __ms?: string }) | null)?.__ms,
      }));
      expect(marks).toEqual({ textarea: "same-node", main: "same-main" });
    });
  }

  test("エラー表示も残る。メニューを何度開閉しても変わらない", async ({ page }) => {
    await gotoToolPage(page);
    await fillJson(page, "これはJSONではありません");
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    const alert = page.locator('main [role="alert"]');
    await expect(alert).toBeVisible();
    const message = (await alert.textContent()) ?? "";
    expect(message.length).toBeGreaterThan(0);

    for (let i = 0; i < 2; i++) {
      await openMenu(page);
      await page.keyboard.press("Escape");
    }
    await expect(drawer(page)).toBeHidden();
    await expect(alert).toBeVisible();
    expect(await alert.textContent()).toBe(message);
    await expect(jsonInput(page)).toHaveValue("これはJSONではありません");
  });

  test("スマホ幅の検索ボタンでメニューを開いて閉じても、入力・結果が残る", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await gotoToolPage(page);
    await fillJson(page, SAMPLE_JSON);
    await page.getByRole("button", { name: "CSVに変換する" }).click();
    await expect(resultBox(page)).toBeVisible();
    const csv = await resultBox(page).inputValue();

    await expect(async () => {
      await page.getByRole("button", { name: "ツールを検索" }).click();
      await expect(drawer(page)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(jsonInput(page)).toHaveValue(SAMPLE_JSON);
    await expect(resultBox(page)).toHaveValue(csv);
  });
});

// ===========================================================================
// 5. 検索
// ===========================================================================
test.describe("検索", () => {
  test("PC: ヘッダーの検索欄から /tools?q=… へ移動し、従来どおり結果が絞り込まれる", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/about");
    const input = page.locator("header.ms-bar").getByRole("searchbox", { name: "ツールを検索" });
    await expect(input).toBeVisible();
    await input.fill("PDF 結合");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/tools\?q=PDF(%20|\+)%E7%B5%90%E5%90%88/);
    const hit = searchTools(getListedTools().filter((t) => t.status === "available"), "PDF 結合")[0];
    expect(hit, "「PDF 結合」の検索結果がある").toBeTruthy();
    await expect(page.locator(`main a[href="/tools/${hit.id}"]`)).toBeVisible();
  });

  test("すでにツール一覧を開いている時も、ヘッダーの検索で一覧が絞り込まれ、検索欄にも反映される", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/tools");
    const header = page.locator("header.ms-bar").getByRole("searchbox", { name: "ツールを検索" });
    const main = page.locator("main");
    // 画面の準備（hydration）前のEnterは「絞り込みの追随」が間に合わないので、反映されるまで繰り返す
    await expect(async () => {
      await header.fill("QR");
      await header.press("Enter");
      await expect(main.getByRole("searchbox", { name: "ツールを検索" })).toHaveValue("QR", { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/tools\?q=QR/);
    const hits = getListedTools().filter((t) => t.status === "available" && /qr/i.test(`${t.name} ${t.description} ${t.id} ${(t.keywords ?? []).join(" ")}`));
    expect(hits.length).toBeGreaterThan(0);
    await expect(main.getByText(/件のツール/)).toBeVisible();
    await expect(main.locator(`a[href="/tools/${hits[0].id}"]`)).toBeVisible();
  });

  test("メニュー内の検索欄: 入力して Enter → 検索結果へ移動し、メニューは閉じる", async ({ page }) => {
    await gotoToolPage(page);
    await openMenu(page);
    const search = drawer(page).getByRole("searchbox", { name: "メニューからツールを検索" });
    await search.fill("画像 圧縮");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/tools\?q=/);
    await expect(drawer(page)).toBeHidden();
    await expect(page.locator('main a[href="/tools/image-compress"]')).toBeVisible();
  });

  test("スマホ幅: 検索ボタンでメニューが開き、検索欄にフォーカスが移る。そのまま検索できる", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/about");
    await expect(async () => {
      await page.getByRole("button", { name: "ツールを検索" }).click();
      await expect(drawer(page)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const search = drawer(page).getByRole("searchbox", { name: "メニューからツールを検索" });
    await expect(search).toBeFocused();
    await page.keyboard.type("QR");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tools\?q=QR/);
    await expect(drawer(page)).toBeHidden();
  });
});

// ===========================================================================
// 6. ライト・ダーク・モバイル
// ===========================================================================
for (const scheme of SCHEMES) {
  test.describe(`見た目（${scheme}）`, () => {
    test.use({ colorScheme: scheme });

    test("メニューの文字（項目・見出し・現在地）と、ヘッダーのリンクがコントラスト比4.5以上", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto("/tools?category=pdf");
      await openMenu(page);
      const targets = [
        'dialog.ms-drawer a:has-text("ホーム")',
        'dialog.ms-drawer a[aria-current="page"]',
        'dialog.ms-drawer h2:has-text("メニュー")',
        'dialog.ms-drawer h3:has-text("カテゴリ")',
        'dialog.ms-drawer input[type="search"]',
      ];
      for (const sel of targets) {
        const { fg, bg } = await colorsOf(page, sel);
        // 入力欄の文字色は入力した時の色。placeholder は別なのでここでは値の色で確認する
        expect(contrast(fg, bg), `${sel} のコントラスト`).toBeGreaterThanOrEqual(4.5);
      }
      await page.keyboard.press("Escape");
      await expect(drawer(page)).toBeHidden();
      for (const sel of ['header.ms-bar > div > nav a:has-text("ツール一覧")', 'header.ms-bar a:has-text("Mr.Satto")']) {
        const { fg, bg } = await colorsOf(page, sel);
        expect(contrast(fg, bg), `${sel} のコントラスト`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("ドロワーのパネルは不透明で、現在地は色以外（太字・線）でも示される", async ({ page }) => {
      await page.goto("/tools?category=pdf");
      await openMenu(page);
      const panel = await page.locator(".ms-drawer-panel").evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, width: el.getBoundingClientRect().width };
      });
      expect(panel.bg).not.toMatch(/rgba?\(.*,\s*0(\.\d+)?\)$/);
      const cur = await drawerLink(page, "PDF").evaluate((el) => {
        const s = getComputedStyle(el);
        return { weight: Number(s.fontWeight), shadow: s.boxShadow };
      });
      expect(cur.weight).toBeGreaterThanOrEqual(700);
      expect(cur.shadow).not.toBe("none");
    });

    test("テーマ切り替えがメニュー（スマホ幅）からも使える", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto("/");
      await openMenu(page);
      const group = drawer(page).getByRole("radiogroup", { name: "テーマ切り替え" });
      await expect(group).toBeVisible();
      await group.getByRole("radio", { name: scheme === "light" ? "ダーク" : "ライト" }).click();
      await expect(page.locator("html")).toHaveClass(scheme === "light" ? /dark/ : /^((?!dark).)*$/);
    });
  });
}

test.describe("スマホ幅（390px）", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  for (const route of ["/", "/tools", TOOL_PAGE, "/pricing"]) {
    test(`横スクロールが出ない（メニューを閉じた状態・開いた状態）: ${route}`, async ({ page }) => {
      await page.goto(route);
      const overflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(1);
      await openMenu(page);
      expect(await overflow()).toBeLessThanOrEqual(1);
      // 開く時のスライドが終わってから位置を測る
      await page.locator(".ms-drawer-panel").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      const panel = await page.locator(".ms-drawer-panel").boundingBox();
      expect(panel!.x).toBeGreaterThanOrEqual(0);
      expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);
    });
  }

  test("ヘッダーの部品（メニュー・ロゴ・検索）が重ならず、画面内に収まる", async ({ page }) => {
    await page.goto("/");
    const boxes = [
      await menuButton(page).boundingBox(),
      await page.locator("header.ms-bar").getByRole("link", { name: "Mr.Satto" }).boundingBox(),
      await page.locator("header.ms-bar").getByRole("button", { name: "ツールを検索" }).boundingBox(),
    ];
    for (const b of boxes) {
      expect(b).toBeTruthy();
      expect(b!.x).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width).toBeLessThanOrEqual(390);
    }
    const [a, b, c] = boxes as NonNullable<(typeof boxes)[number]>[];
    expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    expect(b.x + b.width).toBeLessThanOrEqual(c.x);
    // タップしやすい大きさ
    expect(a.width).toBeGreaterThanOrEqual(40);
    expect(a.height).toBeGreaterThanOrEqual(40);
  });

  test("メニューの項目は、タップしやすい高さ（44px以上）", async ({ page }) => {
    await page.goto("/");
    await openMenu(page);
    const heights = await drawer(page)
      .locator("a.ms-menu-link")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(categories.length);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
  });

  test("途中の幅（タブレット768px）でも、ヘッダーが折り返さず、横スクロールも出ない", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto(TOOL_PAGE);
    const box = await page.locator("header.ms-bar").boundingBox();
    expect(box!.height).toBeLessThanOrEqual(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// 7. キーボード・フォーカス・視覚効果を減らす設定
// ===========================================================================
test.describe("キーボード操作とフォーカス", () => {
  test("メニューボタンにTabで到達しEnterで開く → フォーカスはメニュー内 → Tabを繰り返してもメニューの外へ出ない → Escapeでボタンへ戻る", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/about");
    await expect(menuButton(page)).toBeVisible();
    // 最初のTabでメニューボタンに届く（ヘッダーの先頭にあるため。画面準備前でも届く）
    await page.keyboard.press("Tab");
    await expect(menuButton(page)).toBeFocused();
    const ring = await menuButton(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(ring).toEqual({ style: "solid", width: "2px" });

    await expect(async () => {
      await page.keyboard.press("Enter");
      await expect(drawer(page)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);

    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("dialog")), `Tab ${i + 1}回目でメニューの外へ出た`).toBe(true);
    }
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
  });

  test("メニュー内のリンクにフォーカスすると枠が見え、Enterで移動できる", async ({ page }) => {
    await page.goto("/about");
    await openMenu(page);
    const link = drawerLink(page, "PDF");
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    const ring = await link.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(ring).toEqual({ style: "solid", width: "2px" });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/tools\?category=pdf/);
    await expect(drawer(page)).toBeHidden();
  });
});

test.describe("視覚効果を減らす設定", () => {
  test("通常: 開く時にスライドの動きがある", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await openMenu(page);
    const name = await page.locator(".ms-drawer-panel").evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe("ms-drawer-in");
  });

  test("reduce: 開く時の動き（スライド・背景のフェード）がなく、色の切り替えもほぼ即時", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await openMenu(page);
    const info = await page.evaluate(() => {
      const panel = document.querySelector(".ms-drawer-panel")!;
      const link = document.querySelector("a.ms-menu-link")!;
      const bd = getComputedStyle(document.querySelector("dialog.ms-drawer")!, "::backdrop");
      return {
        panelAnim: getComputedStyle(panel).animationName,
        backdropAnim: bd.animationName,
        linkTransition: parseFloat(getComputedStyle(link).transitionDuration),
      };
    });
    expect(info.panelAnim).toBe("none");
    expect(info.backdropAnim).toBe("none");
    expect(info.linkTransition).toBeLessThan(0.001);
    // 動きがなくても、開閉そのものは正しく動く
    await page.keyboard.press("Escape");
    await expect(drawer(page)).toBeHidden();
  });
});
