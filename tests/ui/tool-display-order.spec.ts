import { test, expect, type Page } from "@playwright/test";
import { tools, getListedTools } from "@/lib/tools/data";
import { categories } from "@/lib/tools/categories";
import { hasImplementation } from "@/lib/tools/registry";
import { searchTools } from "@/lib/tools/search";
import { TOOL_READINGS, compareToolsByReading, primaryKey, sortToolsForDisplay } from "@/lib/tools/display-order";

/**
 * カテゴリー内のツールの表示順（2026-11-17。src/lib/tools/display-order.ts）。
 * - カテゴリーの中は、ツール名の読みの50音順。頭が同じツール（PDF○○・Word○○ など）は1か所にまとまる。
 * - ツール一覧ページ（/tools?category=…）と、カテゴリーのページ（/tools/pdf など）で同じ順。
 * - 検索結果の順・ツールのデータ（所属カテゴリー・URL）は変えない。
 */

const listed = getListedTools().filter((t) => t.status === "available" && hasImplementation(t.id));

function expectedFor(categoryId: string): string[] {
  return sortToolsForDisplay(listed.filter((t) => t.category === categoryId)).map((t) => t.id);
}

/** 画面のツールのカードの並び（ツールのページへのリンクの順。見出しの近くのリンクなどは、対象のツールだけを数える） */
async function shownIds(page: Page, allowed: string[]): Promise<string[]> {
  const hrefs = await page.locator("main a[href^='/tools/']").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  const set = new Set(allowed);
  const seen: string[] = [];
  for (const h of hrefs) {
    const id = h.replace(/^\/tools\//, "").replace(/[?#].*$/, "");
    if (set.has(id) && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

test.describe("表示順のデータ", () => {
  test("一覧に出るすべてのツールに読みがあり、読みはひらがな（と →・）だけで書かれている", () => {
    for (const t of listed) {
      const r = TOOL_READINGS[t.id];
      expect(r, `${t.id}（${t.name}）の読みがありません`).toBeTruthy();
      expect(r, `${t.id} の読み`).toMatch(/^[ぁ-ゖー→・]+$/);
    }
    // 存在しないツールの読みが残っていない
    for (const id of Object.keys(TOOL_READINGS)) expect(tools.some((t) => t.id === id), id).toBe(true);
  });

  test("50音の比べ方：カタカナ・濁音・小さい字・長音のゆれをそろえる", () => {
    expect(primaryKey("ガゾウ")).toBe(primaryKey("がぞう"));
    expect(primaryKey("ぱすわーど")).toBe(primaryKey("はすわあと"));
    expect(primaryKey("じぇいそん")).toBe(primaryKey("しえいそん"));
    expect(primaryKey("ぴーでぃーえふ")).toBe(primaryKey("ひいていいえふ"));
    // 区切り（→・）は字より前：「Excel・CSV」は「Excel旧形式」より前、「Word→画像」は「Word結合」より前
    expect(primaryKey("えくせる・しー") < primaryKey("えくせるきゅう")).toBe(true);
    expect(primaryKey("わーど→がぞう") < primaryKey("わーどけつごう")).toBe(true);
    // 清音が同じなら、濁音などの違いで順を決める（毎回同じ順）
    expect(compareToolsByReading({ id: "a", name: "は" }, { id: "b", name: "ば" })).toBeLessThan(0);
  });

  test("各カテゴリーの中は50音順で、頭が同じツールは1か所にまとまっている", () => {
    for (const c of categories) {
      const order = expectedFor(c.id).map((id) => TOOL_READINGS[id]);
      for (let i = 1; i < order.length; i++) {
        expect(primaryKey(order[i - 1]) <= primaryKey(order[i]), `${c.id}: ${order[i - 1]} → ${order[i]}`).toBe(true);
      }
      const names = expectedFor(c.id).map((id) => tools.find((t) => t.id === id)!.name);
      for (const prefix of ["PDF", "Word", "Excel", "CSV", "画像", "動画", "音声", "ZIP", "PowerPoint"]) {
        const idx = names.map((n, i) => (n.startsWith(prefix) ? i : -1)).filter((i) => i >= 0);
        if (idx.length < 2) continue;
        expect(idx[idx.length - 1] - idx[0] + 1, `${c.id} の「${prefix}」が離れています：${names.join(" / ")}`).toBe(idx.length);
      }
    }
  });

  test("並べ替えても、ツールのデータ（所属カテゴリー・ID・名前・件数）は変わらない", () => {
    const sorted = sortToolsForDisplay(listed);
    expect(sorted).toHaveLength(listed.length);
    expect(new Set(sorted.map((t) => t.id))).toEqual(new Set(listed.map((t) => t.id)));
    for (const t of sorted) expect(t).toBe(listed.find((x) => x.id === t.id));
    // 元の配列（データの並び）は変えない
    expect(getListedTools().map((t) => t.id)).toEqual(tools.filter((t) => !t.mergedInto).map((t) => t.id));
    // カテゴリーの順は categories.ts の並び
    const catOrder = sorted.map((t) => t.category).filter((c, i, a) => a.indexOf(c) === i);
    expect(catOrder).toEqual(categories.map((c) => c.id).filter((id) => listed.some((t) => t.category === id)));
  });
});

test.describe("画面の表示順", () => {
  test.describe.configure({ timeout: 120_000 });

  for (const c of categories) {
    test(`${c.name}：カテゴリーのページと、ツール一覧ページの絞り込みで、同じ50音順に並ぶ`, async ({ page }) => {
      const expected = expectedFor(c.id);
      await page.goto(`/tools/${c.id}`);
      expect(await shownIds(page, expected)).toEqual(expected);
      await page.goto(`/tools?category=${c.id}`);
      await expect(page.locator("main a[href^='/tools/']").first()).toBeVisible();
      expect(await shownIds(page, expected)).toEqual(expected);
    });
  }

  test("「すべて」は、カテゴリーの順に、それぞれのカテゴリーの中は50音順で並ぶ", async ({ page }) => {
    await page.goto("/tools");
    const expected = sortToolsForDisplay(listed).map((t) => t.id);
    expect(await shownIds(page, expected)).toEqual(expected);
  });

  test("検索したときの順は、これまでどおり（検索の順のまま）", async ({ page }) => {
    await page.goto("/tools?q=PDF");
    const all = getListedTools();
    const expected = searchTools(all, "PDF")
      .filter((t) => t.status === "available")
      .map((t) => t.id);
    await expect(page.locator("main a[href^='/tools/']").first()).toBeVisible();
    expect(await shownIds(page, expected)).toEqual(expected);
  });

  test("カードのリンクから、ツールのページが開ける", async ({ page }) => {
    await page.goto("/tools/word");
    const first = expectedFor("word")[0];
    await page.locator(`main a[href='/tools/${first}']`).first().click();
    await expect(page).toHaveURL(new RegExp(`/tools/${first}$`));
    await expect(page.locator("h1")).toContainText(tools.find((t) => t.id === first)!.name);
  });

  test.describe("スマホの幅", () => {
    test.use({ viewport: { width: 375, height: 800 } });
    test("カテゴリーのページ・ツール一覧で、横スクロールが出ない", async ({ page }) => {
      for (const url of ["/tools/csv-excel", "/tools?category=generator", "/tools"]) {
        await page.goto(url);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, url).toBeLessThanOrEqual(1);
      }
    });
  });
});
