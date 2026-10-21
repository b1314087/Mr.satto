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

  test("警告: 日付と曜日が合わない行・同じ日付が複数ある日を知らせる。予定は削除も修正もせず、そのままカレンダーに載る", async ({ page }) => {
    await open(page);
    await load(page, [
      HEADER,
      ["2026/4/6(月)", "入学式", "09:00", null], // 2026-04-06 は月曜日: 一致
      ["2026/4/7(月)", "始業式", "09:00", null], // 2026-04-07 は火曜日: 不一致
      ["2026/4/8(水)", "保護者会", "14:00", null],
      ["2026/4/8(水)", "保護者会", "14:00", null], // 同じ日・同じ予定名
      ["2026/5/12", "出張", "09:00", null],
      ["2026/5/12", "会議", "13:00", null], // 同じ日・別の予定
    ]);
    await expect(page.getByTestId("events-count-recognized")).toContainText("6件");
    await expect(page.getByTestId("events-count-weekday")).toContainText("1件");
    await expect(page.getByTestId("events-count-duplicate")).toContainText("2日");
    // 読めない行はないので、「確認が必要な行」は出ない（警告とは別の表示）
    await expect(page.getByTestId("events-issues")).toHaveCount(0);

    const warnings = page.getByTestId("events-warning");
    await expect(warnings).toHaveCount(3);
    await expect(page.getByTestId("events-warnings")).toContainText("読み込みはそのまま行います");
    const weekday = page.locator('[data-testid="events-warning"][data-kind="weekday-mismatch"]');
    await expect(weekday).toHaveCount(1);
    await expect(weekday).toContainText("2026/04/07 は火曜日ですが、「月」と書かれています");
    await expect(weekday).toContainText("自動では直しません");
    await expect(weekday).toContainText("対象: 3行目");
    const duplicate = page.locator('[data-testid="events-warning"][data-kind="duplicate-date"]');
    await expect(duplicate).toHaveCount(2);
    await expect(duplicate.nth(0)).toContainText("同じ予定名の行が重なっています");
    await expect(duplicate.nth(0)).toContainText("対象: 4・5行目");
    await expect(duplicate.nth(1)).toContainText("意図したものか確認してください");
    await expect(duplicate.nth(1)).toContainText("対象: 6・7行目");

    // 予定は1件も落ちず、日付も動かない（不一致の「始業式」は入力どおり4月7日、重複した「保護者会」は2件とも載る）
    const preview = page.getByTestId("calendar-preview").first();
    await expect(preview.locator('[data-date="2026-04-07"]')).toContainText("始業式");
    await expect(preview.locator('[data-date="2026-04-08"]')).toContainText("保護者会");
    expect((await preview.locator('[data-date="2026-04-08"]').innerText()).match(/保護者会/g)).toHaveLength(2);
    await page.getByRole("button", { name: "5月", exact: true }).click();
    const may12 = page.getByTestId("calendar-preview").first().locator('[data-date="2026-05-12"]');
    await expect(may12).toContainText("出張");
    await expect(may12).toContainText("会議");
  });

  test("警告: 曜日の付記も重複もない予定表では、警告は出ない。同じ日に予定が複数ある予定表では重複の確認だけが出る", async ({ page }) => {
    await open(page);
    await load(page, [HEADER, [d(2026, 4, 1), "入社式", "10:00", null], [d(2026, 4, 2), "研修", "10:00", null]]);
    await expect(page.getByTestId("events-warnings")).toHaveCount(0);
    await expect(page.getByTestId("events-count-weekday")).toHaveCount(0);
    await expect(page.getByTestId("events-count-duplicate")).toHaveCount(0);
    await page.getByTestId("events-clear").click();
    await load(page);
    // 従来の予定表（4/1に2件・4/10に5件）: 曜日の付記はなく、重複の確認だけが2日分出る。従来の件数表示は変わらない
    await expect(page.getByTestId("events-count-duplicate")).toContainText("2日");
    await expect(page.getByTestId("events-count-weekday")).toHaveCount(0);
    await expect(page.getByTestId("events-warning")).toHaveCount(2);
    await expect(page.getByTestId("events-issue")).toHaveCount(3);
    await expect(page.getByTestId("events-count-recognized")).toContainText("12件");
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
  test("2か月に切り替えると、横向きは左右・縦向きは上下に並ぶ（向きは選べる）。ボタンの表示が変わり、1か月に戻せる", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("months-per-sheet-1")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("calendar-preview")).toHaveCount(1);
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-arrangement", "single");
    await page.getByTestId("months-per-sheet-2").click();
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-months-per-sheet", "2");
    // 横向き（既定）: 左に前の月、右に次の月
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-arrangement", "side-by-side");
    const previews = page.getByTestId("calendar-preview");
    await expect(previews).toHaveCount(2);
    await expect(previews.nth(0)).toHaveAttribute("data-month", "2026-04");
    await expect(previews.nth(1)).toHaveAttribute("data-month", "2026-05");
    const side0 = (await previews.nth(0).boundingBox())!;
    const side1 = (await previews.nth(1).boundingBox())!;
    expect(side0.x).toBeLessThan(side1.x);
    expect(Math.abs(side0.y - side1.y)).toBeLessThan(2);
    await expect(page.getByRole("button", { name: "横向き" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "縦向き" })).toBeEnabled();
    await expect(page.getByTestId("orientation-arrangement")).toContainText("左に前の月、右に次の月");
    // 縦向き: 上に前の月、下に次の月
    await page.getByRole("button", { name: "縦向き" }).click();
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-arrangement", "stacked");
    await expect(page.getByRole("button", { name: "縦向き" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "横向き" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("orientation-arrangement")).toContainText("上に前の月、下に次の月");
    await expect(previews.nth(0)).toHaveAttribute("data-month", "2026-04");
    await expect(previews.nth(1)).toHaveAttribute("data-month", "2026-05");
    const top = (await previews.nth(0).boundingBox())!;
    const bottom = (await previews.nth(1).boundingBox())!;
    expect(top.y + top.height).toBeLessThanOrEqual(bottom.y + 1);
    expect(Math.abs(top.x - bottom.x)).toBeLessThan(2);
    await page.getByRole("button", { name: "12・1月", exact: true }).click();
    await expect(previews.nth(0)).toHaveAttribute("data-month", "2026-12");
    await expect(previews.nth(1)).toHaveAttribute("data-month", "2027-01");
    await expect(page.getByRole("button", { name: "Excelを作成（2か月ずつ6シート）" })).toBeVisible();
    await expect(page.getByRole("button", { name: "PDFを作成（2か月ずつ6ページ）" })).toBeVisible();
    // 横向きに戻すと左右、1か月に戻すと従来どおり
    await page.getByRole("button", { name: "横向き" }).click();
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-arrangement", "side-by-side");
    await page.getByTestId("months-per-sheet-1").click();
    await expect(previews).toHaveCount(1);
    await expect(page.getByTestId("orientation-arrangement")).toHaveCount(0);
    await page.getByRole("button", { name: "縦向き" }).click();
    await expect(page.getByRole("button", { name: "縦向き" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-arrangement", "single");
    await expect(page.getByRole("button", { name: "Excelを作成（月別12シート）" })).toBeVisible();
  });

  test("縦向きの2か月: 向きを変えると、作成済みファイルのダウンロードボタンは消える", async ({ page }) => {
    await open(page);
    await page.getByTestId("months-per-sheet-2").click();
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "縦向き" }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toHaveCount(0);
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

  test("Excel（2か月・縦向き）: A4縦・上に前の月/下に次の月・予定が全件・ファイル名・XMLの検査に合格", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("months-per-sheet-2").click();
    await page.getByRole("button", { name: "縦向き" }).click();
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_月曜始まり_縦_2か月.xlsx");
    await assertDownloadedFile(download, { format: "zip", minBytes: 5_000 });
    const bytes = new Uint8Array(fs.readFileSync((await download.path())!));
    expect(validateXlsxStrict(bytes).problems).toEqual([]);
    const wb = readXlsxWorkbook(bytes);
    expect(wb.sheets.map((s) => s.name)).toEqual(["4月・5月", "6月・7月", "8月・9月", "10月・11月", "12月・1月", "2月・3月"]);
    for (const s of wb.sheets) {
      expect(s.pageSetup.orientation).toBe("portrait");
      expect(s.pageSetup.paperSize).toBe("9");
      expect(s.fitToPage).toBe(true);
    }
    const cellOf = (sheetIndex: number, iso: string) =>
      [...wb.sheets[sheetIndex].cells.values()].find((x) => typeof x.value === "number" && x.value > 40000 && excelSerialToIso(x.value) === iso)!;
    const memo = (sheetIndex: number, iso: string) => {
      const c = cellOf(sheetIndex, iso);
      return wb.sheets[sheetIndex].cells.get(addressOf(c.row + 1, c.col))?.value;
    };
    // 上の月（4月）の日が、下の月（5月）の日より上の行にある
    expect(cellOf(0, "2026-04-30").row).toBeLessThan(cellOf(0, "2026-05-01").row);
    expect(cellOf(4, "2026-12-31").row).toBeLessThan(cellOf(4, "2027-01-01").row);
    expect(memo(0, "2026-04-01")).toBe("10:00-11:30 入社式\n18:30 歓迎会");
    expect(memo(0, "2026-04-10")).toBe("09:00 朝会A\n09:30 朝会B\n10:00 朝会C\n10:30 朝会D\n11:00 朝会E");
    expect(memo(0, "2026-05-12")).toBe("09:00-17:00 出張");
    expect(memo(4, "2027-01-04")).toBe("09:00 仕事始め");
    const all = wb.sheets.flatMap((s) => [...s.cells.values()]).map((c) => c.value);
    expect(all.some((v) => typeof v === "string" && (v.includes("前年度の予定") || v.includes("翌年度の予定")))).toBe(false);
  });

  test("PDF（2か月・縦向き・予定つき）: 6ページのA4縦で、上に前の月・下に次の月、予定が載る", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("months-per-sheet-2").click();
    await page.getByRole("button", { name: "縦向き" }).click();
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, /PDFファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_月曜始まり_縦_2か月.pdf");
    await assertDownloadedFile(download, { format: "pdf", minBytes: 5_000 });
    const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync((await download.path())!)));
    expect(pages).toHaveLength(6);
    for (const p of pages) expect(p.height).toBeGreaterThan(p.width);
    const text = (i: number) => pages[i].boxes.map((b) => b.str).join("").replace(/\s+/g, "");
    expect(text(0)).toContain("入社式");
    expect(text(0)).toContain("出張");
    expect(text(4)).toContain("仕事始め");
    const titleY = (i: number, label: string) => pages[i].boxes.find((b) => b.str.includes(label))!.y;
    expect(titleY(0, "2026年4月")).toBeGreaterThan(titleY(0, "2026年5月"));
    expect(titleY(4, "2026年12月")).toBeGreaterThan(titleY(4, "2027年1月"));
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

  test("縦向き（上下配置）でも、画面が横にはみ出さない。上の月・下の月が縦に並ぶ", async ({ page }) => {
    await open(page);
    await load(page);
    await page.getByTestId("months-per-sheet-2").click();
    await page.getByRole("button", { name: "縦向き" }).click();
    await expect(page.getByTestId("calendar-preview-sheet")).toHaveAttribute("data-arrangement", "stacked");
    const a = (await page.getByTestId("calendar-preview").nth(0).boundingBox())!;
    const b = (await page.getByTestId("calendar-preview").nth(1).boundingBox())!;
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x + a.width).toBeLessThanOrEqual(375 + 1);
    expect(a.y + a.height).toBeLessThanOrEqual(b.y + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
});
