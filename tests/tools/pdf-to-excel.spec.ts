import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readXlsxSheet, readXlsxRawStructure } from "../helpers/xlsx-inspect";

/**
 * pdf-to-excel専用テスト（外出先PC修正指示書§21-26: 罫線・結合セル対応）。
 *
 * これまでpdf-to-excel自体の専用E2Eテストが存在しなかったため、まず基本の
 * 変換動作を確認したうえで、今回追加した罫線検出(detectTableBorders)が
 * 「実際に線が引かれている場合だけ罫線を出力し、線が無い場合には出力しない」
 * ことの両方を確認する（excel-to-pdf-phase18-2.spec.tsの
 * 「Gridlines(枠線の無い大きな表)は罫線情報が無ければ一切線を描画しない」と
 * 同じ方針。誤検出（線が無いのに引いてしまう）が無いことも同じくらい重要）。
 */

async function convertAndDownload(page: import("@playwright/test").Page, pdfPath: string) {
  await page.goto("/tools/pdf-to-excel");
  await uploadFixture(page, pdfPath);
  // next dev(Turbopack)の初回コンパイル待ち等でアップロード直後にボタンが
  // 現れないことがある既知の不安定さへの対処（他のspecと同じ再読み込み方式）。
  const buttonVisible = await page
    .getByRole("button", { name: "Excelに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!buttonVisible) {
    await page.reload();
    await uploadFixture(page, pdfPath);
  }
  await expect(page.getByRole("button", { name: "Excelに変換する" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 30_000 });

  const download = await clickAndDownload(page, "Excelファイルをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
  return path;
}

test("基本の変換: 表の値がExcelのセルへ正しく配置される", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.pdfToExcelBorderedTablePdf);
  const sheet = await readXlsxSheet(path);
  expect(sheet.headers).toEqual(["Name", "Score"]);
  expect(sheet.rows.map((r) => r.map((c) => (c == null ? "" : String(c))))).toEqual([
    ["Alice", "10"],
    ["Bob", "20"],
  ]);
});

test("罫線: PDFに実際に線が描画されている表では、生成したExcelにも罫線が反映される(§21-26)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.pdfToExcelBorderedTablePdf);
  const raw = await readXlsxRawStructure(path);
  expect(raw.borderStyleCount, "PDFに描画された罫線がExcelへ反映されていません").toBeGreaterThan(0);
});

test("罫線: 線が描画されていない表では、Excel側にも罫線を一切出力しない(誤検出防止)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.pdfToExcelBorderlessTablePdf);
  const raw = await readXlsxRawStructure(path);
  expect(raw.borderStyleCount, "罫線が無いPDFなのにExcel側に罫線が出力されています(誤検出)").toBe(0);

  // 罫線の有無以外の内容自体は、罫線ありのフィクスチャと完全に同じであるべき
  const sheet = await readXlsxSheet(path);
  expect(sheet.headers).toEqual(["Name", "Score"]);
});
