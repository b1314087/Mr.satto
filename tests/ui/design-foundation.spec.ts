import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { getFeaturedTools, getListedTools, tools } from "@/lib/tools/data";
import { waitForFileInputHydrated } from "../helpers/tool-ready";

/**
 * UI刷新・第1工程（デザイントークン・共通部品）のテスト。
 *  1. トークンの定義（ライト・ダーク）と、文字・ボタン・フォーカス枠のコントラスト比（WCAG）
 *  2. 共通部品（Button / GlassCard / ToolCard）の出力
 *  3. 実画面（トップのカード・JSON/CSV変換のボタン）での見た目・フォーカス・視覚効果を減らす設定
 */

const CSS = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

// ---------------------------------------------------------------------------
// 色の計算（WCAGの相対輝度・コントラスト比）
// ---------------------------------------------------------------------------
type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(v);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  throw new Error(`解釈できない色: ${value}`);
}

/** 半透明の色 fg を、不透明な背景 bg の上に重ねた色 */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** globals.css の指定ブロック（:root / .dark）から --ms-* の値を取り出す */
function tokensOf(selector: ":root" | ".dark", css = CSS): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "g");
  const out: Record<string, string> = {};
  for (const m of css.matchAll(re)) {
    for (const d of m[1].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[d[1]] = d[2].replace(/\/\*.*?\*\//g, "").trim();
  }
  return out;
}

const REQUIRED_TOKENS = [
  "--ms-page", "--ms-surface", "--ms-surface-glass", "--ms-surface-glass-solid", "--ms-surface-strong", "--ms-hover-tint",
  "--ms-text", "--ms-text-muted", "--ms-border", "--ms-border-strong", "--ms-glass-highlight",
  "--ms-shadow-sm", "--ms-shadow-lift", "--ms-accent", "--ms-accent-hover", "--ms-accent-pressed", "--ms-on-accent",
  "--ms-focus", "--ms-success", "--ms-warning", "--ms-danger",
];
/** ライト・ダークに関係なく同じ値を使う基準値（:root にだけ定義し、ダークは引き継ぐ） */
const SHARED_TOKENS = ["--ms-radius-card", "--ms-radius-control", "--ms-blur", "--ms-duration", "--ms-ease"];

test.describe("デザイントークン（globals.css）", () => {
  test("必要なトークンが、ライト・ダークの両方に定義されている", () => {
    const light = tokensOf(":root");
    const dark = tokensOf(".dark");
    for (const name of [...REQUIRED_TOKENS, ...SHARED_TOKENS]) expect(light[name], `ライト: ${name}`).toBeTruthy();
    for (const name of REQUIRED_TOKENS) expect(dark[name], `ダーク: ${name}`).toBeTruthy();
    // 角丸・ぼかし・動きはテーマで変えない（ダークで上書きされていない）
    for (const name of SHARED_TOKENS) expect(dark[name], `ダークで上書きしていない: ${name}`).toBeUndefined();
  });

  test("ページ背景・基本の文字色は --ms-page / --ms-text を参照する（背景の定義は1か所。ページ背景は淡い水色のガラス調）", () => {
    expect(tokensOf(":root")["--background"]).toBe("var(--ms-page)");
    expect(tokensOf(":root")["--foreground"]).toBe("var(--ms-text)");
    expect(tokensOf(".dark")["--background"]).toBe("var(--ms-page)");
    expect(tokensOf(".dark")["--foreground"]).toBe("var(--ms-text)");
    expect(tokensOf(":root")["--ms-page"]).toBe("#eaf2fc");
    expect(tokensOf(".dark")["--ms-page"]).toBe("#060c1a");
    expect(CSS).toMatch(/@custom-variant dark \(&:where\(\.dark, \.dark \*\)\);/);
    expect(CSS).toMatch(/body \{\s*background: var\(--background\);/);
  });

  for (const [name, selector] of [["ライト", ":root"], ["ダーク", ".dark"]] as const) {
    test(`${name}: 文字・ボタン・フォーカス枠・状態色のコントラスト比が基準を満たす`, () => {
      const t = tokensOf(selector);
      const color = (n: string) => parseColor(t[n]);
      const page = color("--ms-page");
      // ガラス面は、ぼかしが使える時（半透明）と使えない時（ほぼ不透明）の両方を、そのテーマで実際にあり得る
      // 一番条件の悪い下地（ライト: 純白〜中間グレー、ダーク: 純黒〜濃いグレー）に重ねて確認する
      const bases: [string, string][] =
        selector === ":root"
          ? [["純白", "#ffffff"], ["中間グレー", "#a3a3a3"]]
          : [["純黒", "#000000"], ["濃いグレー", "#404040"]];
      const surfaces: [string, Rgba][] = [
        ["ページ背景", page],
        ["通常の面", color("--ms-surface")],
        ["入力欄・ダイアログの面", color("--ms-surface-strong")],
        ["ガラス面（ぼかし無し）on ページ", over(color("--ms-surface-glass-solid"), page)],
        ["ガラス面（半透明）on ページ", over(color("--ms-surface-glass"), page)],
        ...bases.map(([label, hex]): [string, Rgba] => [`ガラス面（半透明）on ${label}`, over(color("--ms-surface-glass"), parseColor(hex))]),
      ];
      for (const [label, bg] of surfaces) {
        expect(contrast(color("--ms-text"), bg), `本文 on ${label}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color("--ms-text-muted"), bg), `補助文字 on ${label}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const [label, bg] of surfaces.slice(0, 3)) {
        for (const state of ["--ms-success", "--ms-warning", "--ms-danger"]) {
          expect(contrast(color(state), bg), `${state} on ${label}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(color("--ms-focus"), bg), `フォーカス枠 on ${label}`).toBeGreaterThanOrEqual(3);
      }
      for (const n of ["--ms-accent", "--ms-accent-hover", "--ms-accent-pressed"]) {
        expect(contrast(color("--ms-on-accent"), color(n)), `主要ボタンの文字 on ${n}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("ぼかしが使えない環境・視覚効果を減らす設定への対応がCSSに入っている", () => {
    // ぼかしが使える時だけ半透明にする（既定はほぼ不透明）
    expect(CSS).toMatch(/\.ms-glass \{[^}]*background-color: var\(--ms-surface-glass-solid\)/);
    expect(CSS).toMatch(/@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
    // 透明度を下げる・コントラストを上げる設定では不透明にする
    expect(CSS).toMatch(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\)/);
    // 動きを減らす設定
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(CSS).toMatch(/@media \(hover: hover\) and \(prefers-reduced-motion: no-preference\)/);
    // キーボードのフォーカス枠
    expect(CSS).toMatch(/\.ms-btn:focus-visible/);
    expect(CSS).toMatch(/\.ms-glass-interactive:focus-visible/);
  });
});

// ---------------------------------------------------------------------------
// 共通部品のソース（部品はJSXを含むため、ここでは書き方の約束だけを確認する。
// 実際の描画は下の「実画面」のテストで確認する）
// ---------------------------------------------------------------------------
test.describe("共通部品の作り（ソースの約束）", () => {
  const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

  test("Button: <button>のまま・既定type=button・処理中は押せずaria-busyが付く", () => {
    const src = read("src/components/ui/button.tsx");
    expect(src).toContain('type = "button"');
    expect(src).toContain("disabled={disabled || loading}");
    expect(src).toContain("aria-busy={loading || undefined}");
    expect(src).toContain("<button");
    expect(src).toContain("{...rest}"); // aria・onClickなどの属性はそのまま渡る
    expect(src).toContain('"ms-btn"');
  });

  test("GlassCard: strongは不透明の面、クリックできるカードはリンク側に付ける設計（divに変えない）", () => {
    const src = read("src/components/ui/glass-card.tsx");
    expect(src).toContain('strong ? "ms-glass-strong" : "ms-glass"');
    expect(src).toContain('interactive && "ms-glass-interactive"');
  });

  test("ToolCard: 実装済みはガラス調（共通クラス）。準備中は破線・低コントラストで区別し、ガラスにしない", () => {
    const src = read("src/components/tools/tool-card.tsx");
    expect(src).not.toContain("appearance");
    expect(src).toContain("glassCardClasses({ interactive: true })");
    // 準備中の分岐: 破線・弱い背景。ガラス（ms-glass）や浮き上がりは付けない
    const coming = /isComingSoon\s*\?[\s\S]*?:\s*glassCardClasses/.exec(src)?.[0] ?? "";
    expect(coming).toContain("border-dashed");
    expect(coming).not.toContain("ms-glass");
    expect(coming).not.toContain("translate");
    expect(src).toContain("（準備中・まだ利用できません）");
  });
});

// ---------------------------------------------------------------------------
// 実画面
// ---------------------------------------------------------------------------
type Scheme = "light" | "dark";

/**
 * ブラウザが返す色は lab() / oklab() などの形のことがある（Tailwind v4の色）。canvas に塗って
 * sRGBの rgba() に直してから返す。
 */
async function computed(page: Page, selector: string, props: string[]): Promise<Record<string, string>> {
  return page.locator(selector).first().evaluate((el, ps) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const toRgba = (c: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    };
    const colorProps = new Set(["color", "background-color", "border-top-color", "outline-color"]);
    return Object.fromEntries(ps.map((p) => [p, colorProps.has(p) ? toRgba(cs.getPropertyValue(p)) : cs.getPropertyValue(p)]));
  }, props);
}

/** 要素の実際の背景色（透明なら親をたどり、半透明は重ねる） */
async function effectiveBackground(page: Page, selector: string): Promise<Rgba> {
  const layers: string[] = await page.locator(selector).first().evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const toRgba = (c: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    };
    const out: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) out.push(toRgba(getComputedStyle(n).backgroundColor));
    return out;
  });
  let result = parseColor("rgb(255, 255, 255)");
  for (const c of layers.reverse()) {
    const col = parseColor(c);
    if (col.a > 0) result = over(col, result);
  }
  return result;
}

for (const scheme of ["light", "dark"] as Scheme[]) {
  test.describe(`実画面（${scheme === "light" ? "ライト" : "ダーク"}モード）`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    test("ツール一覧: カードはガラス調で、リンク先・個数が変わらず、文字が読める", async ({ page }) => {
      await page.goto("/tools");
      const expected = getListedTools().filter((t) => t.status === "available");
      const cards = page.locator('main a[href^="/tools/"][aria-label]');
      await expect(cards).toHaveCount(expected.length);
      for (const [i, tool] of expected.entries()) await expect(cards.nth(i)).toHaveAttribute("href", `/tools/${tool.id}`);

      const sel = 'main a[href^="/tools/"][aria-label]';
      await cards.first().scrollIntoViewIfNeeded();
      const cs = await computed(page, sel, ["background-color", "border-top-width", "backdrop-filter", "box-shadow", "border-radius"]);
      expect(cs["border-top-width"]).toBe("1px");
      expect(cs["backdrop-filter"]).toContain("blur");
      expect(parseColor(cs["background-color"]).a).toBeLessThan(1); // 半透明
      expect(cs["box-shadow"]).not.toBe("none");
      expect(parseFloat(cs["border-radius"])).toBe(22);

      // 文字と、その下の背景（ガラスを下地に重ねた色）のコントラスト
      const bg = await effectiveBackground(page, sel);
      const title = parseColor((await computed(page, `${sel} h3`, ["color"]))["color"]);
      const desc = parseColor((await computed(page, `${sel} p`, ["color"]))["color"]);
      expect(contrast(title, bg), "カード見出し").toBeGreaterThanOrEqual(4.5);
      expect(contrast(desc, bg), "カード説明").toBeGreaterThanOrEqual(4.5);
    });

    test("トップ: 「ファイルを保存しない」などの説明がガラスカードで、文字が読める", async ({ page }) => {
      await page.goto("/");
      const sel = 'div.ms-glass:has(h3:text("ファイルを保存しない"))';
      await expect(page.locator(sel)).toHaveCount(1);
      await expect(page.locator("div.ms-glass:has(h3)")).toHaveCount(2);
      const bg = await effectiveBackground(page, sel);
      const h = parseColor((await computed(page, `${sel} h3`, ["color"]))["color"]);
      const p = parseColor((await computed(page, `${sel} p:nth-of-type(1)`, ["color"]))["color"]);
      expect(contrast(h, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p, bg)).toBeGreaterThanOrEqual(4.5);
    });

    test("ツール一覧: カードにキーボードで移動すると、はっきりしたフォーカス枠が出る", async ({ page }) => {
      await page.goto("/tools");
      const first = page.locator('main a[href^="/tools/"][aria-label]').first();
      // キーボード操作としてフォーカスする（Tabで入る形にして、:focus-visible が効く状態にする）
      await first.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(first).toBeFocused();
      const cs = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement!);
        return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
      });
      expect(cs.style).toBe("solid");
      expect(cs.width).toBe("2px");
      expect(cs.color.replace(/\s/g, "")).toBe(scheme === "light" ? "rgb(37,99,235)" : "rgb(96,165,250)");
    });

    test("JSON→CSV: 主要ボタン・補助ボタンが正しく動き、無効状態・フォーカス枠が分かる", async ({ page }) => {
      await page.goto("/tools/json-to-csv");
      await waitForFileInputHydrated(page).catch(() => undefined);
      const input = page.getByRole("textbox", { name: /入力/ });
      await expect(async () => {
        await input.fill("x");
        await expect(input).toHaveValue("x", { timeout: 1000 });
      }).toPass({ timeout: 20_000 });
      await input.fill("");

      const run = page.getByRole("button", { name: "CSVに変換する" });
      // 入力が空: 押せない。色だけでなく、薄さ・カーソルでも分かる
      await expect(run).toBeDisabled();
      // （色・影の切り替えにはごく短いアニメーションがあるので、落ち着くまで待つ）
      await expect.poll(async () => (await computed(page, 'button:has-text("CSVに変換する")', ["box-shadow"]))["box-shadow"]).toBe("none");
      const dis = await computed(page, 'button:has-text("CSVに変換する")', ["opacity", "cursor"]);
      expect(parseFloat(dis["opacity"])).toBeLessThan(0.8);
      expect(dis["cursor"]).toBe("not-allowed");

      await input.fill('[{"a":1,"b":"x"}]');
      await expect(run).toBeEnabled();
      const primary = await computed(page, 'button:has-text("CSVに変換する")', ["background-color", "color", "border-radius", "cursor"]);
      expect(primary["background-color"]).toBe("rgba(37, 99, 235, 1.000)");
      expect(primary["color"]).toBe("rgba(255, 255, 255, 1.000)");
      expect(primary["cursor"]).toBe("pointer");
      expect(contrast(parseColor(primary["color"]), parseColor(primary["background-color"]))).toBeGreaterThanOrEqual(4.5);

      // キーボードでボタンまで移動してEnterで実行できる。フォーカス枠が出る
      await input.focus();
      await page.keyboard.press("Tab");
      await expect(run).toBeFocused();
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement!);
        return { style: s.outlineStyle, width: s.outlineWidth };
      });
      expect(ring).toEqual({ style: "solid", width: "2px" });
      await page.keyboard.press("Enter");
      await expect(page.getByText("変換が完了しました")).toBeVisible();

      // 補助ボタン（コピー）: 白・ニュートラルで枠線あり。主要ボタンと区別できる
      const copy = page.getByRole("button", { name: "コピー" });
      await expect(copy).toBeVisible();
      const sec = await computed(page, 'button:has-text("コピー")', ["background-color", "color", "border-top-width", "border-top-color"]);
      expect(sec["border-top-width"]).toBe("1px");
      expect(sec["background-color"]).not.toBe("rgba(37, 99, 235, 1.000)");
      expect(contrast(parseColor(sec["color"]), parseColor(sec["background-color"]))).toBeGreaterThanOrEqual(4.5);
      // 補助ボタンは、背景が透けるガラス調（色は白／濃紺のまま、不透明ではない。文字は読める濃さを保つ）
      const secBg = parseColor(sec["background-color"]);
      expect([secBg.r, secBg.g, secBg.b].map(Math.round)).toEqual(scheme === "light" ? [255, 255, 255] : [16, 26, 54]);
      expect(secBg.a).toBeGreaterThan(0.3);
      expect(secBg.a).toBeLessThan(1);
    });
  });
}

test.describe("視覚効果を減らす設定（prefers-reduced-motion）", () => {
  const CARD = 'main a[href^="/tools/"][aria-label]';
  const CATEGORY_CARD = 'section:has(h2:text("カテゴリから探す")) a[href^="/tools/"]';

  test("通常: ツールのカードもカテゴリのカードもホバーで少し浮く", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    const cat = page.locator(CATEGORY_CARD).first();
    await cat.scrollIntoViewIfNeeded();
    await cat.hover();
    await expect.poll(async () => (await computed(page, CATEGORY_CARD, ["translate"]))["translate"], { timeout: 3000 }).toBe("0px -2px");

    await page.goto("/tools");
    await page.locator(CARD).first().hover();
    await expect.poll(async () => (await computed(page, CARD, ["translate"]))["translate"], { timeout: 3000 }).toBe("0px -2px");
  });

  test("動きを減らす設定: どのカードも浮かず、切り替えもほぼ即時になる。枠の色の変化は残る", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const cat = page.locator(CATEGORY_CARD).first();
    await cat.scrollIntoViewIfNeeded();
    await cat.hover();
    await page.waitForTimeout(400);
    const glass = await computed(page, CATEGORY_CARD, ["translate", "transition-duration", "border-top-color"]);
    expect(glass["translate"]).toBe("none");
    expect(parseFloat(glass["transition-duration"].split(",")[0])).toBeLessThan(0.001);
    expect(glass["border-top-color"]).toBe("rgba(37, 99, 235, 1.000)"); // ホバーしたことは枠の色で伝わる

    await page.goto("/tools");
    await page.locator(CARD).first().hover();
    await page.waitForTimeout(400);
    const def = await computed(page, CARD, ["translate", "transition-duration"]);
    expect(def["translate"]).toBe("none");
    expect(parseFloat(def["transition-duration"].split(",")[0])).toBeLessThan(0.001);
  });

  test("動きを減らす設定: 処理中のスピナーは回らない（文字の「処理中」で状態は伝わる）", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/tools/json-to-csv");
    // スピナー用のCSS（.ms-btn[aria-busy] / .animate-spin）が、動きを減らす設定で止まる指定になっていることを実際の適用で確認する
    const result = await page.evaluate(() => {
      const el = document.createElement("button");
      el.className = "ms-btn ms-btn-primary";
      el.setAttribute("aria-busy", "true");
      document.body.appendChild(el);
      const name = getComputedStyle(el, "::before").animationName;
      const spin = document.createElement("span");
      spin.className = "animate-spin";
      document.body.appendChild(spin);
      const spinName = getComputedStyle(spin).animationName;
      el.remove();
      spin.remove();
      return { name, spinName };
    });
    expect(result).toEqual({ name: "none", spinName: "none" });
  });
});

test("通常の設定では、処理中のボタンにスピナーが回り、カーソルが処理中になる。一覧のカードはガラス調", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/tools");
  const card = page.locator('main a[href^="/tools/"][aria-label]').first();
  await expect(card).toBeVisible();
  expect(await card.getAttribute("class")).toContain("ms-glass-interactive");

  const r = await page.evaluate(() => {
    const el = document.createElement("button");
    el.className = "ms-btn ms-btn-primary";
    el.setAttribute("aria-busy", "true");
    el.disabled = true;
    document.body.appendChild(el);
    const out = { anim: getComputedStyle(el, "::before").animationName, cursor: getComputedStyle(el).cursor, opacity: getComputedStyle(el).opacity };
    el.remove();
    return out;
  });
  expect(r.anim).toBe("ms-spin");
  expect(r.cursor).toBe("progress");
  // 処理中は薄くせず、周りを光が一周するリングで「動いている」ことを示す
  expect(parseFloat(r.opacity)).toBe(1);
});

test("既存のツール数・カテゴリ構成は変わっていない（今回はUIの土台だけ）", () => {
  expect(tools.filter((t) => t.status === "available").length).toBeGreaterThan(100);
  expect(getFeaturedTools().every((t) => !t.mergedInto)).toBe(true);
});
