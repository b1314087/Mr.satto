import fs from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { readPdfColors } from "../helpers/calendar-pdf-colors";

/**
 * 年度カレンダー作成ツールの「デザイン」（プリセット・カスタム配色・白黒）のE2Eテスト。
 * 画面でデザインを選び、プレビューの色と、実際にダウンロードしたExcel・PDFの色が一致することを確かめる。
 * 色の定義そのもの・既存テーマの維持は tests/calendar 側で確認している。
 */

const SLUG = "/tools/fiscal-calendar";

async function open(page: Page) {
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
    return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
  });
}

const themeButton = (page: Page, id: string) => page.getByTestId(`theme-${id}`);
const preview = (page: Page) => page.getByTestId("calendar-preview").first();
const titleBand = (page: Page) => preview(page).locator("> div").first();
const cssColor = (loc: ReturnType<Page["locator"]>, prop: "backgroundColor" | "color") => loc.evaluate((el, p) => getComputedStyle(el)[p as "color"], prop);
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
/** 日曜日のマス（プレビューの最初の日曜日）の背景・日付の文字色 */
async function firstSunday(page: Page) {
  const cell = preview(page).locator('[data-testid="calendar-preview-cell"][data-kind="sunday"]:has(span)').first();
  return { bg: await cssColor(cell, "backgroundColor"), text: await cssColor(cell.locator("span").first(), "color") };
}
async function weekdayCell(page: Page) {
  const cell = preview(page).locator('[data-testid="calendar-preview-cell"][data-kind="weekday"]:has(span)').first();
  return { bg: await cssColor(cell, "backgroundColor"), text: await cssColor(cell.locator("span").first(), "color") };
}
async function readDownload(download: Awaited<ReturnType<typeof clickAndDownload>>) {
  return new Uint8Array(fs.readFileSync((await download.path())!));
}

test.describe("年度カレンダーのデザイン: 選択", () => {
  test("6つの選択肢（ビジネス・ナチュラル・シンプル（白黒）・パステル・ブルーグレー・カスタム）があり、色見本が付く。初期はビジネス", async ({ page }) => {
    await open(page);
    const ids = ["business", "natural", "simple", "pastel", "bluegray", "custom"];
    for (const id of ids) {
      await expect(themeButton(page, id)).toBeVisible();
      await expect(themeButton(page, id).getByTestId(`theme-${id}-swatch`)).toHaveCount(4);
    }
    await expect(themeButton(page, "business")).toHaveAttribute("aria-pressed", "true");
    for (const id of ids.slice(1)) await expect(themeButton(page, id)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: /シンプル（白黒）/ })).toBeVisible();
    await expect(page.getByTestId("custom-colors")).toHaveCount(0); // 4色の設定はカスタムのときだけ
  });

  test("ビジネスとナチュラルの見た目は従来どおり（プレビューの色）", async ({ page }) => {
    await open(page);
    await expect(preview(page)).toHaveAttribute("data-theme", "business");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#1F3864"));
    expect((await firstSunday(page)).bg).toBe(rgb("#FDECEC"));
    expect((await firstSunday(page)).text).toBe(rgb("#B42318"));
    await themeButton(page, "natural").click();
    await expect(preview(page)).toHaveAttribute("data-theme", "natural");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#4F6B4A"));
    expect((await weekdayCell(page)).bg).toBe(rgb("#FBF8EF"));
    expect((await firstSunday(page)).text).toBe(rgb("#A63D2A"));
  });

  test("パステル・ブルーグレーを選ぶと、プレビューの色が切り替わる", async ({ page }) => {
    await open(page);
    const seen = new Set<string>();
    for (const id of ["business", "pastel", "bluegray", "natural"]) {
      await themeButton(page, id).click();
      await expect(preview(page)).toHaveAttribute("data-theme", id);
      seen.add(await cssColor(titleBand(page), "backgroundColor"));
    }
    expect(seen.size).toBe(4);
  });

  test("シンプル（白黒）: プレビューは白地・黒文字で、土日祝の色分けがなく、祝日名は表示される", async ({ page }) => {
    await open(page);
    await themeButton(page, "simple").click();
    await expect(preview(page)).toHaveAttribute("data-theme", "simple");
    const cells = preview(page).locator('[data-testid="calendar-preview-cell"]');
    const n = await cells.count();
    expect(n).toBeGreaterThan(27);
    const colors = await cells.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(new Set(colors)).toEqual(new Set([rgb("#FFFFFF")]));
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#FFFFFF"));
    expect(await cssColor(titleBand(page), "color")).toBe(rgb("#000000"));
    expect((await firstSunday(page)).text).toBe(rgb("#000000"));
    // 4月のプレビューに祝日名（昭和の日）が出る
    await expect(preview(page)).toContainText("昭和の日");
    // 推定の注記など、日付の内容は変わらない
    await expect(page.getByTestId("custom-colors")).toHaveCount(0);
  });

  test("デザインを切り替えても、プレビューの幅・高さ・横位置が変わらず、画面から消えない（PC幅）", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const measure = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="tool-preview"]') as HTMLElement;
        const r = el.getBoundingClientRect();
        const split = document.querySelector("[data-preview-split]") as HTMLElement;
        return { x: r.x, w: r.width, h: r.height, top: r.top, bottom: r.bottom, splitTop: split.getBoundingClientRect().top + window.scrollY, vh: window.innerHeight };
      });
    const before = await measure();
    for (const id of ["natural", "simple", "custom", "pastel", "business"]) {
      await themeButton(page, id).click();
      const m = await measure();
      expect(Math.abs(m.x - before.x), `${id} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.w - before.w), `${id} width`).toBeLessThanOrEqual(1);
      expect(Math.abs(m.h - before.h), `${id} height`).toBeLessThanOrEqual(2);
      expect(Math.abs(m.splitTop - before.splitTop), `${id} レイアウトの位置`).toBeLessThanOrEqual(1);
      // プレビューは画面の中に見えている（切り替えで画面外へ押し出されない）
      expect(m.bottom, `${id} bottom`).toBeGreaterThan(0);
      expect(m.top, `${id} top`).toBeLessThan(m.vh);
    }
  });
});

test.describe("年度カレンダーのデザイン: カスタム配色", () => {
  test("カスタムを選ぶと4色の設定が出て、初期値のプレビューになる", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    await expect(page.getByTestId("custom-colors")).toBeVisible();
    for (const role of ["main", "accent", "background", "ink"]) {
      await expect(page.getByTestId(`custom-color-${role}`)).toBeVisible();
      await expect(page.getByTestId(`custom-hex-${role}`)).toBeVisible();
    }
    await expect(page.getByTestId("custom-hex-main")).toHaveValue("#1F3864");
    await expect(preview(page)).toHaveAttribute("data-theme", "custom");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#1F3864"));
  });

  test("色を変えると、すぐにプレビューへ反映され、ほかの色は変わらない（カラーピッカー・色コード入力の両方）", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    const titleBefore = await cssColor(titleBand(page), "backgroundColor");
    const weekdayBefore = await weekdayCell(page);
    const sundayBefore = await firstSunday(page);

    // アクセント（ピッカー）→ 日曜日・祝日だけが変わる
    await page.getByTestId("custom-color-accent").fill("#00aa00");
    await expect(page.getByTestId("custom-hex-accent")).toHaveValue("#00AA00");
    expect((await firstSunday(page)).text).toBe(rgb("#00AA00"));
    expect((await firstSunday(page)).text).not.toBe(sundayBefore.text);
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(titleBefore); // メインは変わらない
    expect(await weekdayCell(page)).toEqual(weekdayBefore); // 背景・文字も変わらない

    // メイン（色コード入力）→ 見出し帯が変わる。アクセントは変わらない
    await page.getByTestId("custom-hex-main").fill("#336699");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#336699"));
    expect((await firstSunday(page)).text).toBe(rgb("#00AA00"));

    // 背景 → 平日のマスだけ。文字は変わらない
    await page.getByTestId("custom-hex-background").fill("#FFF8E1");
    expect((await weekdayCell(page)).bg).toBe(rgb("#FFF8E1"));
    expect((await weekdayCell(page)).text).toBe(weekdayBefore.text);

    // 文字・罫線 → 平日の文字
    await page.getByTestId("custom-hex-ink").fill("#112233");
    expect((await weekdayCell(page)).text).toBe(rgb("#112233"));
    expect((await weekdayCell(page)).bg).toBe(rgb("#FFF8E1"));
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#336699"));
  });

  test("不正な色コードは警告が出るだけで、プレビューは変わらず、画面は壊れない。正しい色コードに直すと反映される", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    const before = await cssColor(titleBand(page), "backgroundColor");
    for (const bad of ["zzz", "#12", "red", "#GGGGGG", ""]) {
      await page.getByTestId("custom-hex-main").fill(bad);
      expect(await cssColor(titleBand(page), "backgroundColor"), `入力 "${bad}"`).toBe(before);
    }
    await page.getByTestId("custom-hex-main").fill("#12");
    await expect(page.getByRole("alert").filter({ hasText: "色コード" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Excelを作成/ })).toBeEnabled();
    await page.getByTestId("custom-hex-main").fill("#abc");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#AABBCC"));
    await expect(page.getByRole("alert").filter({ hasText: "色コード" })).toHaveCount(0);
  });

  test("読みやすさの目安: 読みにくい組み合わせは知らせるが、選択は止めない", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    await expect(page.getByTestId("custom-contrast-weekday")).toHaveAttribute("data-ok", "true");
    // 背景と文字を近い色にする
    await page.getByTestId("custom-hex-background").fill("#EEEEEE");
    await page.getByTestId("custom-hex-ink").fill("#F0F0F0");
    await expect(page.getByTestId("custom-contrast-weekday")).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("custom-contrast-weekday")).toContainText("読みにくい可能性");
    await expect(page.getByRole("button", { name: /Excelを作成/ })).toBeEnabled();
    expect((await weekdayCell(page)).bg).toBe(rgb("#EEEEEE")); // 制限せず、そのまま反映
  });

  test("「初期値に戻す」で4色がもとに戻る", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    await page.getByTestId("custom-hex-main").fill("#336699");
    await page.getByTestId("custom-hex-accent").fill("#00AA00");
    await page.getByRole("button", { name: "カスタム配色を初期値に戻す" }).click();
    for (const [role, hex] of [["main", "#1F3864"], ["accent", "#B42318"], ["background", "#FFFFFF"], ["ink", "#1F2937"]]) {
      await expect(page.getByTestId(`custom-hex-${role}`)).toHaveValue(hex);
    }
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#1F3864"));
    expect((await firstSunday(page)).text).toBe(rgb("#B42318"));
  });

  test("プリセットに戻すと、カスタムの色は混ざらずプリセットの配色に完全に戻る。カスタムに戻ると4色は保たれている", async ({ page }) => {
    await open(page);
    const businessTitle = await cssColor(titleBand(page), "backgroundColor");
    const businessSunday = await firstSunday(page);
    const businessWeekday = await weekdayCell(page);
    await themeButton(page, "custom").click();
    await page.getByTestId("custom-hex-main").fill("#009688");
    await page.getByTestId("custom-hex-accent").fill("#FF5722");
    await page.getByTestId("custom-hex-background").fill("#FFFDE7");
    await page.getByTestId("custom-hex-ink").fill("#000000");
    await themeButton(page, "business").click();
    await expect(page.getByTestId("custom-colors")).toHaveCount(0);
    await expect(preview(page)).toHaveAttribute("data-theme", "business");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(businessTitle);
    expect(await firstSunday(page)).toEqual(businessSunday);
    expect(await weekdayCell(page)).toEqual(businessWeekday);
    await themeButton(page, "pastel").click();
    await themeButton(page, "custom").click();
    await expect(page.getByTestId("custom-hex-main")).toHaveValue("#009688");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#009688"));
  });

  test("カスタム配色が外部へ送信されない（端末内だけで処理）", async ({ page }) => {
    const recorder = new NetworkRecorder(page);
    await open(page);
    await themeButton(page, "custom").click();
    await page.getByTestId("custom-hex-main").fill("#336699");
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const origin = new URL(page.url()).origin;
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
    expect(findSuspiciousApiUploads(recorder, origin, [], 1)).toEqual([]);
    expect(recorder.requests.filter((r) => /336699/i.test(r.url) && !r.url.startsWith(origin))).toEqual([]);
  });
});

test.describe("年度カレンダーのデザイン: ダウンロードしたファイルの色", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Excel（カスタム）: タブ色・見出し帯・日曜日のマスがプレビューと同じ色で、12シート", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    await page.getByTestId("custom-hex-main").fill("#2E7D32");
    await page.getByTestId("custom-hex-accent").fill("#C2185B");
    await page.getByTestId("custom-hex-background").fill("#FFF8E1");
    const previewTitle = await cssColor(titleBand(page), "backgroundColor");
    const previewSunday = await firstSunday(page);
    expect(previewTitle).toBe(rgb("#2E7D32"));
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const wb = readXlsxWorkbook(await readDownload(await clickAndDownload(page, /Excelファイルをダウンロード/)));
    expect(wb.sheets).toHaveLength(12);
    const apr = wb.sheets[0];
    expect(apr.tabColor).toBe("2E7D32");
    const fills = new Set([...apr.cells.values()].map((c) => wb.style(c)?.fillColor?.slice(-6)));
    const fonts = new Set([...apr.cells.values()].map((c) => wb.style(c)?.fontColor?.slice(-6)));
    expect(fills).toContain("2E7D32"); // 見出し帯（プレビューと同じ）
    expect(fills).toContain("FFF8E1"); // 平日のマス
    expect(fonts).toContain("C2185B"); // 日曜日・祝日（プレビューの日曜日の文字色と同じ）
    expect(previewSunday.text).toBe(rgb("#C2185B"));
  });

  test("Excel（シンプル）: 塗りつぶしとタブ色がなく、12シート", async ({ page }) => {
    await open(page);
    await themeButton(page, "simple").click();
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const wb = readXlsxWorkbook(await readDownload(await clickAndDownload(page, /Excelファイルをダウンロード/)));
    expect(wb.sheets).toHaveLength(12);
    for (const s of wb.sheets) expect(s.tabColor).toBeNull();
    for (const st of wb.styles) expect(st.fillColor).toBeNull();
  });

  test("PDF（カスタム）: 見出し帯・日曜日の文字がプレビューと同じ色で、12ページ", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    await page.getByTestId("custom-hex-main").fill("#2E7D32");
    await page.getByTestId("custom-hex-accent").fill("#C2185B");
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const pages = await readPdfColors(await readDownload(await clickAndDownload(page, /PDFファイルをダウンロード/)));
    expect(pages).toHaveLength(12);
    for (const pg of pages) {
      expect(pg.fillColors).toContain("#2E7D32");
      expect(pg.fillColors).toContain("#C2185B");
    }
  });

  test("PDF（シンプル）: 塗りつぶしがなく、白黒グレーだけで、12ページ", async ({ page }) => {
    await open(page);
    await themeButton(page, "simple").click();
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const pages = await readPdfColors(await readDownload(await clickAndDownload(page, /PDFファイルをダウンロード/)));
    expect(pages).toHaveLength(12);
    for (const pg of pages) {
      expect(pg.fillOpCount).toBe(0);
      for (const c of [...pg.fillColors, ...pg.strokeColors]) expect(c).toMatch(/^#([0-9A-F]{2})\1\1$/);
    }
  });

  test("デザインを変えると、作成済みの結果は消え、新しい設定で作り直せる", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    await themeButton(page, "simple").click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Excelを作成/ })).toBeEnabled();
  });
});

test.describe("年度カレンダーのデザイン: スマートフォン幅", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("カスタム配色の設定も横にはみ出さず、色を変えるとプレビューに反映される", async ({ page }) => {
    await open(page);
    await themeButton(page, "custom").click();
    await expect(page.getByTestId("custom-colors")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "横方向のはみ出し(px)").toBeLessThanOrEqual(1);
    const box = await page.getByTestId("custom-colors").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1);
    await page.getByTestId("custom-hex-main").fill("#336699");
    expect(await cssColor(titleBand(page), "backgroundColor")).toBe(rgb("#336699"));
    for (const id of ["simple", "pastel", "bluegray", "business"]) {
      await themeButton(page, id).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), id).toBeLessThanOrEqual(1);
    }
  });
});
