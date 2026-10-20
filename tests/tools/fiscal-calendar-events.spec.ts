import fs from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { addressOf, excelSerialToIso, readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { validateXlsxStrict } from "../helpers/xlsx-strict";
import { extractTextBoxes } from "../helpers/pdf-text-boxes";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";

/**
 * 年度カレンダー作成ツールの「Excel予定表の読み込み」「1か月/2か月表示」のE2Eテスト。
 * 実際にxlsxの予定表を作って画面から読み込み、プレビュー・Excel・PDFに同じ予定が出ることを確かめる。
 */

const SLUG = "/tools/fiscal-calendar";
const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __downloadNames: string[] };
    w.__downloadNames = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.__downloadNames.push(this.download);
      return original.call(this);
    };
  });
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
    return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
  });
  await page.getByLabel("年度", { exact: true }).selectOption("2026");
}

const lastDownloadName = (page: Page) => page.evaluate(() => (window as unknown as { __downloadNames: string[] }).__downloadNames.at(-1));

async function scheduleFile(rows: unknown[][], name = "予定表.xlsx") {
  const blob = await writeXlsxSheets([{ name: "予定表", rows }]);
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await blob.arrayBuffer()) };
}

const HEADER = ["日付", "予定", "開始時刻", "終了時刻"];
const baseRows = (): unknown[][] => [
  HEADER,
  [d(2026, 4, 1), "入社式", "10:00", "11:30"],
  [d(2026, 4, 1), "歓迎会", "18:30", null],
  [d(2026, 4, 10), "朝会A", "09:00", null],
  [d(2026, 4, 10), "朝会B", "09:30", null],
  [d(2026, 4, 10), "朝会C", "10:00", null],
  [d(2026, 4, 10), "朝会D", "10:30", null],
  [d(2026, 4, 10), "朝会E", "11:00", null],
  [d(2026, 5, 12), "出張", "09:00", "17:00"],
  [d(2027, 1, 4), "仕事始め", "09:00", null],
  [d(2025, 12, 31), "前年度の予定", null, null],
  [d(2027, 4, 1), "翌年度の予定", null, null],
  ["来週", "日付が読めない", null, null],
  [d(2026, 6, 1), "", null, null],
  [d(2026, 6, 2), "時刻が変", "あとで", null],
];

async function load(page: Page, rows = baseRows()) {
  await page.getByTestId("events-file").setInputFiles(await scheduleFile(rows));
  await expect(page.getByTestId("events-summary")).toBeVisible({ timeout: 30_000 });
}

test.describe("年度カレンダー: Excel予定表の読み込み", () => {
  test("読み込み結果の件数（読み込み行・認識・年度内/外・日付不明・予定名なし）が出て、問題のある行だけが別に示される", async ({ page }) => {
    await open(page);
    await load(page);
    await expect(page.getByTestId("events-count-recognized")).toContainText("12件");
    await expect(page.getByTestId("events-count-rows")).toContainText("14行");
    await expect(page.getByTestId("events-count-inyear")).toContainText("10件");
    await expect(page.getByTestId("events-count-outyear")).toContainText("2件");
    await expect(page.getByTestId("events-count-outyear")).toContainText("対象年度外のためカレンダーには配置されません");
    await expect(page.getByTestId("events-count-baddate")).toContainText("1件");
    await expect(page.getByTestId("events-count-emptytitle")).toContainText("1件");
    await expect(page.getByTestId("events-count-badtime")).toContainText("1件");
    await expect(page.getByTestId("events-issue")).toHaveCount(3);
    // 列は見出しから自動で割り当てられ、列を選ぶ必要はない
    await expect(page.getByTestId("events-undetected")).toHaveCount(0);
    await expect(page.getByTestId("events-col-date")).toHaveValue("0");
    await expect(page.getByTestId("events-col-title")).toHaveValue("1");
  });

  test("プレビューに予定が出る（時刻つき・同じ日の複数・入りきらない分は「他N件」）。年度の外の予定は出ない", async ({ page }) => {
    await open(page);
    await load(page);
    const preview = page.getByTestId("calendar-preview").first();
    await expect(preview).toHaveAttribute("data-month", "2026-04");
    const day1 = preview.locator('[data-date="2026-04-01"]');
    await expect(day1).toContainText("10:00-11:30 入社式");
    await expect(day1).toContainText("18:30 歓迎会");
    // 5件の日は、3行に収まるよう最後を「他N件」にまとめる（Excelには全件が残る）
    const day10 = preview.locator('[data-date="2026-04-10"]');
    await expect(day10.getByTestId("calendar-preview-more")).toContainText("他");
    await expect(preview).not.toContainText("前年度の予定");
    await page.getByRole("button", { name: "5月", exact: true }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-05-12"]')).toContainText("09:00-17:00 出張");
  });

  test("デザインを切り替えても予定は消えず、色だけが変わる。年度を変えると、その年度の範囲で振り分け直す", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByRole("button", { name: /ナチュラル/ }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-04-01"]')).toContainText("入社式");
    await page.getByLabel("年度", { exact: true }).selectOption("2027");
    // 2027年度では、「翌年度の予定」（2027-04-01）だけが年度内
    await expect(page.getByTestId("events-count-inyear")).toContainText("1件");
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2027-04-01"]')).toContainText("翌年度の予定");
  });

  test("列名が分からないファイルは、画面で列を選べる。選ぶと読み込める", async ({ page }) => {
    await open(page);
    await page.getByTestId("events-file").setInputFiles(
      await scheduleFile([
        ["A", "B", "C"],
        ["商談", d(2026, 7, 3), "x"],
        ["面談", d(2026, 7, 4), "y"],
      ]),
    );
    await expect(page.getByTestId("events-undetected")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("events-header-row").selectOption("0");
    await page.getByTestId("events-col-date").selectOption("1");
    await page.getByTestId("events-col-title").selectOption("0");
    await expect(page.getByTestId("events-count-recognized")).toContainText("2件");
    await page.getByRole("button", { name: "7月", exact: true }).click();
    await expect(page.getByTestId("calendar-preview").first().locator('[data-date="2026-07-03"]')).toContainText("商談");
  });

  test("読み込みを取り消すと、予定が消える。古い形式（.xls）は分かりやすく断る", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("events-clear").click();
    await expect(page.getByTestId("events-summary")).toHaveCount(0);
    await expect(page.getByTestId("calendar-preview-event")).toHaveCount(0);
    await page.getByTestId("events-file").setInputFiles({ name: "old.xls", mimeType: "application/vnd.ms-excel", buffer: Buffer.from("dummy") });
    await expect(page.getByTestId("events-file-error")).toContainText(".xlsx");
  });

  test("通信: 予定表の中身を外部・自社サーバーへ送信しない", async ({ page }) => {
    const recorder = new NetworkRecorder(page);
    await open(page);
    await load(page);
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    const origin = new URL(page.url()).origin;
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
    expect(findSuspiciousApiUploads(recorder, origin, [], 1)).toEqual([]);
    expect(recorder.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD" && !r.url.startsWith(origin))).toEqual([]);
  });
});

test.describe("年度カレンダー: 1か月/2か月と出力", () => {
  test("2か月に切り替えると、プレビューが左右2か月になり、向きは横に固定、ボタンの表示が変わる。1か月に戻せる", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("months-per-sheet-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("calendar-preview")).toHaveCount(1);
    await page.getByRole("button", { name: "縦向き" }).click();
    await page.getByTestId("months-per-sheet-2").click();
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-months-per-sheet", "2");
    const previews = page.getByTestId("calendar-preview");
    await expect(previews).toHaveCount(2);
    await expect(previews.nth(0)).toHaveAttribute("data-month", "2026-04");
    await expect(previews.nth(1)).toHaveAttribute("data-month", "2026-05");
    await expect(page.getByRole("button", { name: "12・1月", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "12・1月", exact: true }).click();
    await expect(previews.nth(0)).toHaveAttribute("data-month", "2026-12");
    await expect(previews.nth(1)).toHaveAttribute("data-month", "2027-01");
    await expect(page.getByTestId("orientation-locked")).toBeVisible();
    await expect(page.getByRole("button", { name: "縦向き" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "横向き" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Excelを作成（2か月ずつ6シート）" })).toBeVisible();
    await expect(page.getByRole("button", { name: "PDFを作成（2か月ずつ6ページ）" })).toBeVisible();
    await page.getByTestId("months-per-sheet-1").click();
    await expect(previews).toHaveCount(1);
    await expect(page.getByRole("button", { name: "縦向き" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "縦向き" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Excelを作成（月別12シート）" })).toBeVisible();
  });

  test("設定を変えると、作成済みファイルのダウンロードボタンは消える（2か月に変えたとき、1か月のファイルを渡さない）", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("months-per-sheet-2").click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toHaveCount(0);
  });

  test("Excel（2か月）: 6シート・予定が正しい日に全件・ファイル名・XMLの検査に合格", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("months-per-sheet-2").click();
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_月曜始まり_横_2か月.xlsx");
    await assertDownloadedFile(download, { format: "zip", minBytes: 5_000 });
    const bytes = new Uint8Array(fs.readFileSync((await download.path())!));
    expect(validateXlsxStrict(bytes).problems).toEqual([]);
    const wb = readXlsxWorkbook(bytes);
    expect(wb.sheets.map((s) => s.name)).toEqual(["4月・5月", "6月・7月", "8月・9月", "10月・11月", "12月・1月", "2月・3月"]);
    const memo = (sheetIndex: number, iso: string) => {
      const s = wb.sheets[sheetIndex];
      const c = [...s.cells.values()].find((x) => typeof x.value === "number" && x.value > 40000 && excelSerialToIso(x.value) === iso)!;
      return s.cells.get(addressOf(c.row + 1, c.col))?.value;
    };
    expect(memo(0, "2026-04-01")).toBe("10:00-11:30 入社式\n18:30 歓迎会");
    // 5件の日は、プレビューは「他N件」でも、Excelのセルには全件が残る
    expect(memo(0, "2026-04-10")).toBe("09:00 朝会A\n09:30 朝会B\n10:00 朝会C\n10:30 朝会D\n11:00 朝会E");
    expect(memo(0, "2026-05-12")).toBe("09:00-17:00 出張");
    expect(memo(4, "2027-01-04")).toBe("09:00 仕事始め");
    const all = wb.sheets.flatMap((s) => [...s.cells.values()]).map((c) => c.value);
    expect(all.some((v) => typeof v === "string" && (v.includes("前年度の予定") || v.includes("翌年度の予定")))).toBe(false);
  });

  test("Excel（1か月・予定つき）: 従来どおり12シートで、予定が入る", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_月曜始まり_横.xlsx");
    const bytes = new Uint8Array(fs.readFileSync((await download.path())!));
    expect(validateXlsxStrict(bytes).problems).toEqual([]);
    const wb = readXlsxWorkbook(bytes);
    expect(wb.sheets).toHaveLength(12);
    expect(wb.sheets[0].name).toBe("4月");
    expect([...wb.sheets[0].cells.values()].some((c) => c.value === "10:00-11:30 入社式\n18:30 歓迎会")).toBe(true);
  });

  test("PDF（2か月・予定つき）: 6ページのA4横で、予定が載る。従来のPDF（1か月）も作れる", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("months-per-sheet-2").click();
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, /PDFファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_月曜始まり_横_2か月.pdf");
    await assertDownloadedFile(download, { format: "pdf", minBytes: 5_000 });
    const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync((await download.path())!)));
    expect(pages).toHaveLength(6);
    for (const p of pages) expect(p.width).toBeGreaterThan(p.height);
    const text = (i: number) => pages[i].boxes.map((b) => b.str).join("").replace(/\s+/g, "");
    expect(text(0)).toContain("入社式");
    expect(text(0)).toContain("出張");
    expect(text(4)).toContain("仕事始め");
    // 1か月に戻して作ると12ページ
    await page.getByTestId("months-per-sheet-1").click();
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const d1 = await clickAndDownload(page, /PDFファイルをダウンロード/);
    expect(await extractTextBoxes(new Uint8Array(fs.readFileSync((await d1.path())!)))).toHaveLength(12);
  });
});

test.describe("年度カレンダー: 予定・2か月 スマートフォン幅", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("予定を読み込み、2か月表示にしても、画面が横にはみ出さない", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("months-per-sheet-2").click();
    await expect(page.getByTestId("calendar-preview")).toHaveCount(2);
    for (const i of [0, 1]) {
      const box = await page.getByTestId("calendar-preview").nth(i).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375 + 1);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "横方向のはみ出し(px)").toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: /Excelを作成/ }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
});
