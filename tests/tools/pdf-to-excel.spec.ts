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

async function convertAndDownload(page: import("@playwright/test").Page, pdfPath: string, timeoutMs = 30_000) {
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
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: timeoutMs });

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

// スキャンした画像のPDF(文字レイヤー無し)のOCR対応。OCRの認識結果は完全一致を期待できないため、
// 大きく明瞭な英数字の主要な語がExcelのセルとして出ていること・OCR使用の案内が出ることを確認する。
test("スキャンPDF: 文字情報の無いPDFもOCRで読み取り、表の行・列としてExcelに出力する", async ({ page }) => {
  test.setTimeout(150_000); // tesseract.js(WASM初期化+認識)は文字レイヤー抽出より時間がかかる
  const path = await convertAndDownload(page, fixtures.pdfToExcelScannedTablePdf, 120_000);

  // OCRを使ったことと、誤読があり得るので確認を促す案内が出ている
  await expect(page.getByText("OCRで読み取りました", { exact: false })).toBeVisible();
  await expect(page.getByText("誤読や列のずれがあり得るため", { exact: false })).toBeVisible();

  const sheet = await readXlsxSheet(path);
  const cells = [sheet.headers, ...sheet.rows].map((r) => r.map((c) => (c == null ? "" : String(c)).toUpperCase()));
  const flat = cells.flat().join(" ");
  expect(flat, `OCR結果にNameが含まれていません: ${flat}`).toContain("NAME");
  expect(flat, `OCR結果にAliceが含まれていません: ${flat}`).toContain("ALICE");
  expect(flat, `OCR結果にBobが含まれていません: ${flat}`).toContain("BOB");
  // 2列に分かれている(1つのセルに全部入っていない): 行ごとに2つ以上の非空セルがある行が複数ある
  const multiCellRows = cells.filter((r) => r.filter((c) => c.trim() !== "").length >= 2);
  expect(multiCellRows.length, `列が分かれていません: ${JSON.stringify(cells)}`).toBeGreaterThanOrEqual(2);
});

test("スキャンPDF: テキストレイヤーのページとスキャンのページが混在していても、両方がExcelに出力される", async ({ page }) => {
  test.setTimeout(150_000);
  const path = await convertAndDownload(page, fixtures.pdfToExcelMixedScannedPdf, 120_000);
  const sheet = await readXlsxSheet(path);
  const flat = [sheet.headers, ...sheet.rows].flat().map((c) => (c == null ? "" : String(c)).toUpperCase()).join(" ");
  // 1ページ目(テキストレイヤー)の値は正確に、2ページ目(OCR)の値はOCRで読めていること
  expect(flat).toContain("ALICE");
  expect(flat).toContain("BOB");
  expect(flat).toContain("SCORE");
});
