import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import path from "node:path";
import type { Page } from "@playwright/test";
import { countPixels, pageCount, render } from "../helpers/chart-pdf-inspect";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { scratchDir } from "../helpers/tmp";

/**
 * Excel→PDF：変換の前の「グラフのページ境界チェック」(16種類のExcel)。
 *
 * テスト用のExcelは tests/fixtures/static/excel-chart-pagecheck/(架空のデータのみ。
 * tests/fixtures/excel-chart/generate_ooxml_chart_fixtures.py で、Excel 2016以降のOOXMLの形で作る)。
 * チェックの結果(区分・グラフ・問題・対象ページ)と、実際に変換したPDFでグラフが描かれるページが一致すること、
 * 警告があっても変換できること、チェックを切れること、設定を変えると調べ直すことを確かめる。
 * 同じファイルをLibreOfficeでPDFにした結果とも、グラフが出るページが一致することを確認済み。
 */

const SRC = path.join(__dirname, "..", "fixtures", "static", "excel-chart-pagecheck");

async function load(page: Page, name: string, src = SRC) {
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, path.join(src, name));
  await page.getByRole("button", { name: "PDFに変換する" }).waitFor({ state: "visible", timeout: 30_000 });
}
/** チェックが終わるのを待って、結果の欄を返す */
async function checkResult(page: Page) {
  const panel = page.getByTestId("chart-page-check");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).not.toContainText("チェックしています", { timeout: 90_000 });
  return panel;
}
/** 結果の表の行(区分・シート・グラフ・問題・対象ページ)の文字 */
async function issueRows(page: Page): Promise<string[]> {
  return (await page.getByTestId("chart-page-issue").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
}
async function convert(page: Page): Promise<string> {
  const dir = scratchDir("xlpagecheck");
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了", 120_000);
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const pdf = path.join(dir, "out.pdf");
  await download.saveAs(pdf);
  return pdf;
}
/** PDFでグラフ(色の付いた画素)が描かれているページ */
function chartPages(pdf: string): number[] {
  const out: number[] = [];
  const colored = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b) > 60 && !(r > 90 && g < 70 && b > 130);
  for (let p = 1; p <= pageCount(pdf); p++) if (countPixels(render(pdf, p), colored) > 30) out.push(p);
  return out;
}

const OK = "グラフのページ境界チェックが完了しました。問題は検出されませんでした。";
const NG = "ページ境界に重なっているグラフがあります。PDF出力時にグラフや項目名が途中で切れる可能性があります。";

test.describe.configure({ mode: "parallel" });

test("p01 ページの境目をまたがないグラフ：「問題は検出されませんでした」。PDFでもグラフは1ページ目だけ", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p01-no-cross.xlsx");
  await expect(await checkResult(page)).toContainText(OK);
  expect(chartPages(await convert(page))).toEqual([1]);
});

test("p02 左右のページの境目をまたぐ：警告・グラフ1（縦棒）・1・3ページ。PDFでもグラフは1・3ページ目", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p02-cross-columns.xlsx");
  await expect(await checkResult(page)).toContainText(NG);
  const rows = await issueRows(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("警告");
  expect(rows[0]).toContain("Sheet1");
  expect(rows[0]).toContain("グラフ1（縦棒）");
  expect(rows[0]).toContain("「左右にまたぐ」");
  expect(rows[0]).toContain("G2〜N17");
  expect(rows[0]).toContain("左右のページの境目（縦の境界線・自動の改ページ）をまたいでいます");
  expect(rows[0]).toContain("1・3ページ");
  // 警告があっても変換できる
  await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeEnabled();
  expect(chartPages(await convert(page))).toEqual([1, 3]);
});

test("p03 上下のページの境目をまたぐ：警告・1・2ページ", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p03-cross-rows.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("上下のページの境目（横の境界線・自動の改ページ）をまたいでいます");
  expect(rows[0]).toContain("1・2ページ");
  expect(chartPages(await convert(page))).toEqual([1, 2]);
});

test("p04 手動の改ページ(行)の上のグラフ：「手動の改ページ」と表示", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p04-manual-row-break.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("横の境界線・手動の改ページ");
  expect(rows[0]).toContain("1・2ページ");
});

test("p05 自動の改ページの上のグラフ：「自動の改ページ」と表示", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p05-auto-row-break.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("横の境界線・自動の改ページ");
  expect(rows[0]).toContain("1・2ページ");
});

test("p06 印刷範囲の端にかかるグラフ：「印刷範囲の端（左右）で切れています」", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p06-print-area-edge.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("警告");
  expect(rows[0]).toContain("印刷範囲の端（左右）で切れています");
  expect(rows[0]).toContain("1ページ");
});

test("p07 印刷範囲の外のグラフ：情報「PDFには出力されません」(警告の見出しは出さない)", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p07-outside-print-area.xlsx");
  const panel = await checkResult(page);
  await expect(panel).not.toContainText(NG);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("情報");
  expect(rows[0]).toContain("印刷範囲の外にあるため、PDFには出力されません");
  expect(chartPages(await convert(page))).toEqual([]);
});

test("p08 拡大縮小50%：縮小したときのページの境目で判定し、倍率も表示", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p08-scaled-50.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("上下のページの境目");
  expect(rows[0]).toContain("拡大縮小50%で印刷したときの位置です");
  expect(rows[0]).toContain("1・2ページ");
  expect(chartPages(await convert(page))).toEqual([1, 2]);
});

test("p09 A4横：横向きのページの境目で判定。向きを「縦」に変えると調べ直して、問題なしになる", async ({ page }) => {
  test.setTimeout(180_000);
  await load(page, "p09-landscape.xlsx");
  await checkResult(page);
  expect((await issueRows(page))[0]).toContain("1・2ページ");
  await page.getByRole("button", { name: "縦", exact: true }).click();
  const panel = await checkResult(page);
  await expect(panel).toContainText(OK, { timeout: 60_000 });
});

test("p10 1ページより大きいグラフ：情報「1ページの幅・高さより大きいため、6ページに分かれます」", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p10-large-chart.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("情報");
  expect(rows[0]).toContain("1ページの幅・高さより大きいため、6ページに分かれます");
  expect(rows[0]).toContain("1〜6ページ");
});

test("p11 1シートに複数のグラフ：収まるグラフは出さず、またぐグラフ(警告)と、わずかにかかるグラフ(注意)を出す", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p11-multiple-charts.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("警告");
  expect(rows[0]).toContain("グラフ2");
  expect(rows[0]).toContain("1・3ページ");
  expect(rows[1]).toContain("注意");
  expect(rows[1]).toContain("グラフ3");
  expect(rows[1]).toContain("わずかにかかっています");
  expect(rows.join(" ")).not.toContain("グラフ1（");
});

test("p12 非表示のシートのグラフ：最初は非表示のシートを選ばないので問題なし。選ぶと、そのシートのグラフを調べる", async ({ page }) => {
  test.setTimeout(180_000);
  await load(page, "p12-hidden-sheet.xlsx");
  await expect(await checkResult(page)).toContainText(OK);
  await page.getByRole("checkbox", { name: /非表示/ }).first().check();
  await checkResult(page);
  await expect(page.getByTestId("chart-page-check")).toContainText(NG, { timeout: 60_000 });
  const rows = await issueRows(page);
  expect(rows[0]).toContain("非表示");
  expect(rows[0]).toContain("左右のページの境目");
});

test("p13 グラフと画像の重なり：グラフだけを調べる(画像は対象にしない)", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p13-chart-and-image.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("グラフ1（縦棒）");
  expect(rows[0]).toContain("1・2ページ");
});

test("p14 ページの境目に近いだけで、またがないグラフ：問題なし(過剰に警告しない)", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p14-near-not-crossing.xlsx");
  await expect(await checkResult(page)).toContainText(OK);
  expect(chartPages(await convert(page))).toEqual([1]);
});

test("p15 非表示の行があるシート：非表示の行を除いたページの境目で判定し、問題なし", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p15-hidden-rows.xlsx");
  await expect(await checkResult(page)).toContainText(OK);
  expect(chartPages(await convert(page))).toEqual([1]);
});

test("p16 手動の改ページ(列)の上のグラフ：「縦の境界線・手動の改ページ」", async ({ page }) => {
  test.setTimeout(150_000);
  await load(page, "p16-manual-col-break.xlsx");
  await checkResult(page);
  const rows = await issueRows(page);
  expect(rows[0]).toContain("縦の境界線・手動の改ページ");
  expect(rows[0]).toContain("1・2ページ");
});

test("チェックを切ると、結果を出さずにそのまま変換できる。ファイルは外部に送らない", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const recorder = new NetworkRecorder(page);
  await load(page, "p02-cross-columns.xlsx");
  await checkResult(page);
  await page.getByRole("checkbox", { name: /グラフがページの境目にかかっていないかをチェックする/ }).uncheck();
  await expect(page.getByTestId("chart-page-issue")).toHaveCount(0);
  const pdf = await convert(page);
  expect(pageCount(pdf)).toBe(4);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("グラフの無いExcelでは、チェックの欄を出さない", async ({ page }) => {
  test.setTimeout(120_000);
  await load(page, "01-a4-portrait-print-area.xlsx", path.join(__dirname, "..", "fixtures", "static", "excel-print"));
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("chart-page-check")).toHaveCount(0);
});
