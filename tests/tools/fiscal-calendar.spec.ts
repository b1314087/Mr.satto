import fs from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { NetworkRecorder, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { addressOf, excelSerialToIso, readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { extractTextBoxes } from "../helpers/pdf-text-boxes";

/**
 * 年度カレンダー作成ツール（/tools/fiscal-calendar）のE2Eテスト（工程D）。
 * 画面で設定を変え、実際にダウンロードしたExcel・PDFの中身を読み取って確かめる。
 * 日付・祝日・印刷設定の詳細は tests/calendar 側（単体テスト）で確認している。
 */

const SLUG = "/tools/fiscal-calendar";

/**
 * 保存されるファイル名は、リンクの download 属性に付けた名前で確認する。
 * （Playwrightの suggestedFilename() は、このテスト環境のように日本語の文字コード設定がない
 *  Linuxでは、日本語を含む名前を「download」に置き換えてしまう。実際の利用者のブラウザでは起きない、
 *  テスト環境側の制約。）
 */
async function recordDownloadNames(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __downloadNames: string[] };
    w.__downloadNames = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.__downloadNames.push(this.download);
      return original.call(this);
    };
  });
}

const lastDownloadName = (page: Page) =>
  page.evaluate(() => (window as unknown as { __downloadNames: string[] }).__downloadNames.at(-1));

async function open(page: Page) {
  await recordDownloadNames(page);
  await page.goto(SLUG);
  await expect(page.getByRole("heading", { level: 1, name: "年度カレンダー作成" })).toBeVisible();
  // ツール本体の準備（hydration）が終わるまで待つ
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Excelを作成"));
    return !!btn && Object.keys(btn).some((k) => k.startsWith("__reactProps$"));
  });
}

const yearSelect = (page: Page) => page.getByLabel("年度", { exact: true });

async function readDownload(download: Awaited<ReturnType<typeof clickAndDownload>>) {
  const p = await download.path();
  return new Uint8Array(fs.readFileSync(p!));
}

test.describe("年度カレンダー作成: 画面", () => {
  test("初期表示: 年度・週の始まり・デザイン・向きの選択肢とプレビューが出る", async ({ page }) => {
    await open(page);
    await expect(yearSelect(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "月曜日始まり" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "日曜日始まり" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: /ビジネス/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /ナチュラル/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "横向き" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("tool-preview")).toBeVisible();
    await expect(page.getByTestId("calendar-preview")).toBeVisible();
    // 年度の選択肢は 2020〜2050年度の31個
    await expect(yearSelect(page).locator("option")).toHaveCount(31);
  });

  test("プレビュー: 月の切り替え、祝日の色分け（2026年度 5月）と曜日の並び", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2026");
    await page.getByRole("button", { name: "5月", exact: true }).click();
    const preview = page.getByTestId("calendar-preview");
    await expect(preview).toHaveAttribute("data-month", "2026-05");
    // 5月の祝日は4日（5/3〜5/6）。表の先頭週に含まれる前の月の祝日（4/29）は、数えない
    const holidays = preview.locator('[data-kind="holiday"][data-date^="2026-05"]');
    await expect(holidays).toHaveCount(4);
    await expect(preview.locator('[data-date="2026-05-06"]')).toContainText("振替休日");
    await expect(preview.locator('[data-date="2026-05-04"]')).toContainText("みどりの日");
    await expect(preview.locator('[data-date="2026-05-02"]')).toHaveAttribute("data-kind", "saturday");
    await expect(preview.locator('[data-date="2026-05-10"]')).toHaveAttribute("data-kind", "sunday");
    // 月曜始まり: 最初の列は月曜（2026年5月1日は金曜なので、先頭の週は 4/27(月) から）
    await expect(preview.locator('[data-testid="calendar-preview-cell"]').first()).toHaveAttribute("data-date", "2026-04-27");
    // 日曜始まりに切り替えると、先頭は 4/26(日)
    await page.getByRole("button", { name: "日曜日始まり" }).click();
    await expect(preview.locator('[data-testid="calendar-preview-cell"]').first()).toHaveAttribute("data-date", "2026-04-26");
  });

  test("プレビュー: 推定の祝日（2027年度の3月）に※と注記が出る。2026年度の3月には出ない", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2027");
    await expect(page.getByText(/暦要項の公示前の祝日（推定）が含まれます/)).toBeVisible();
    await page.getByRole("button", { name: "3月", exact: true }).click();
    const preview = page.getByTestId("calendar-preview");
    await expect(preview.locator('[data-date="2028-03-20"]')).toContainText("春分の日※");
    await expect(page.getByTestId("calendar-estimated-note")).toBeVisible();
    await yearSelect(page).selectOption("2026");
    await expect(page.getByText(/暦要項の公示前の祝日（推定）が含まれます/)).toHaveCount(0);
    await page.getByRole("button", { name: "3月", exact: true }).click();
    await expect(page.getByTestId("calendar-estimated-note")).toHaveCount(0);
  });

  test("前後の月の日付を薄く表示するオプションが、プレビューに反映される", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2026");
    const cell = page.getByTestId("calendar-preview").locator('[data-date="2026-03-30"]');
    await expect(cell).toHaveText("");
    await page.getByLabel("前後の月の日付も薄く表示する（初期は空欄）").check();
    await expect(cell).toHaveText("30");
  });

  test("設定を変えると、作成済みのファイルのダウンロードボタンは消える（古い設定のファイルを渡さない）", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2026");
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "縦向き" }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toHaveCount(0);
  });
});

test.describe("年度カレンダー作成: ダウンロードしたファイル", () => {
  // 開発サーバー下でファイル生成が重くなる場合に備え、テスト全体の上限を広げる（既定は60秒）
  test.describe.configure({ timeout: 150_000 });
  test("Excel（2026年度・月曜始まり・ビジネス・横）: 12シート・日付・祝日名・印刷設定・ファイル名", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2026");
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_月曜始まり_横.xlsx");
    await assertDownloadedFile(download, { format: "zip", minBytes: 5_000 });

    const wb = readXlsxWorkbook(await readDownload(download));
    expect(wb.sheets.map((s) => s.name)).toEqual(["4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "1月", "2月", "3月"]);
    const apr = wb.sheets[0];
    expect(apr.cells.get("A1")?.value).toBe("2026年4月");
    expect(excelSerialToIso(apr.cells.get("E3")!.value as number)).toBe("2026-04-01");
    // 4月29日（水）は昭和の日: 月曜始まりの5週目、水曜の列
    expect(excelSerialToIso(apr.cells.get(addressOf(2 + 2 * 4, 4))!.value as number)).toBe("2026-04-29");
    expect(apr.cells.get(addressOf(2 + 2 * 4, 5))?.value).toBe("昭和の日");
    expect(apr.pageSetup).toMatchObject({ paperSize: "9", orientation: "landscape", fitToWidth: "1", fitToHeight: "1" });
    expect(wb.definedNames.filter((d) => d.name === "_xlnm.Print_Area")).toHaveLength(12);
    expect(wb.sheets[9].cells.get("A1")?.value).toBe("2027年1月");
  });

  test("Excel（2027年度・日曜始まり・ナチュラル・縦・前後の月の日付あり）の設定が反映される", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2027");
    await page.getByRole("button", { name: "日曜日始まり" }).click();
    await page.getByRole("button", { name: /ナチュラル/ }).click();
    await page.getByRole("button", { name: "縦向き" }).click();
    await page.getByLabel("前後の月の日付も薄く表示する（初期は空欄）").check();
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const download = await clickAndDownload(page, /Excelファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2027年度カレンダー_日曜始まり_縦.xlsx");
    const wb = readXlsxWorkbook(await readDownload(download));
    const apr = wb.sheets[0];
    expect(apr.pageSetup.orientation).toBe("portrait");
    expect(apr.tabColor).toBe("4F6B4A");
    expect([0, 2, 4, 6, 8, 10, 12].map((c) => apr.cells.get(addressOf(1, c))?.value)).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
    // 2027年4月1日は木曜。日曜始まりの先頭は 3/28(日)。前後の月の日付が入る
    expect(excelSerialToIso(apr.cells.get("A3")!.value as number)).toBe("2027-03-28");
    // 3月（推定の春分の日）
    const mar = wb.sheets[11];
    const names = [...mar.cells.values()].filter((c) => typeof c.value === "string" && c.value.startsWith("春分の日"));
    expect(names.map((c) => c.value)).toEqual(["春分の日※"]);
    // 注記も出る
    expect([...mar.cells.values()].some((c) => typeof c.value === "string" && c.value.startsWith("※は国立天文台の暦要項"))).toBe(true);
  });

  test("PDF（2026年度・日曜始まり・ナチュラル・縦）: 12ページのA4縦・日本語・祝日名", async ({ page }) => {
    await open(page);
    await yearSelect(page).selectOption("2026");
    await page.getByRole("button", { name: "日曜日始まり" }).click();
    await page.getByRole("button", { name: /ナチュラル/ }).click();
    await page.getByRole("button", { name: "縦向き" }).click();
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    // 日本語フォント（約4MB）の取得と12ページ分の組版は、並列実行・開発サーバー下では15秒を超えうるため、ボタンが出るまで十分に待つ
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 90_000 });
    const download = await clickAndDownload(page, /PDFファイルをダウンロード/);
    expect(await lastDownloadName(page)).toBe("2026年度カレンダー_日曜始まり_縦.pdf");
    await assertDownloadedFile(download, { format: "pdf", minBytes: 100_000 });

    const pages = await extractTextBoxes(await readDownload(download));
    expect(pages).toHaveLength(12);
    for (const p of pages) {
      expect(p.width).toBeCloseTo(595.28, 0);
      expect(p.height).toBeCloseTo(841.89, 0);
    }
    expect(pages[0].boxes.some((b) => b.str === "2026年4月")).toBe(true);
    expect(pages[0].boxes.some((b) => b.str === "昭和の日")).toBe(true);
    expect(pages[11].boxes.some((b) => b.str === "2027年3月")).toBe(true);
    expect(pages[11].boxes.some((b) => b.str === "春分の日")).toBe(true);
    const header = pages[0].boxes.filter((b) => ["日", "月", "火", "水", "木", "金", "土"].includes(b.str) && b.size === 11).sort((a, b) => a.x - b.x);
    expect(header.map((b) => b.str)).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
  });

  test("通信: カレンダーの作成中に、データを外部へ送信しない（日本語フォントは同一オリジンから取得）", async ({ page }) => {
    const recorder = new NetworkRecorder(page);
    await open(page);
    await yearSelect(page).selectOption("2026");
    await page.getByRole("button", { name: /PDFを作成/ }).click();
    await expect(page.getByRole("button", { name: /PDFファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Excelを作成/ }).click();
    await expect(page.getByRole("button", { name: /Excelファイルをダウンロード/ })).toBeVisible({ timeout: 30_000 });
    const origin = new URL(page.url()).origin;
    expect(findSuspiciousExternalUploads(recorder, origin), "外部へのデータ送信").toEqual([]);
    const fontRequests = recorder.requests.filter((r) => r.url.includes("NotoSansJP-Regular.ttf"));
    expect(fontRequests.length).toBeGreaterThanOrEqual(1);
    for (const r of fontRequests) expect(r.url.startsWith(origin)).toBe(true);
    // 祝日の取得のための通信（API・外部サイト）はない
    expect(recorder.requests.filter((r) => /syukujitsu|cao\.go\.jp|holiday/i.test(r.url))).toEqual([]);
  });
});
