import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { getFillColorsUsed, isValidPdfFile } from "../helpers/pdf-inspect";
import { buildMinimalXlsx } from "../fixtures/xlsx-writer";
import fs from "node:fs";
import path from "node:path";

/**
 * 外出先PC修正指示書§29-31専用テスト（excel-to-pdfのセル背景色・文字色反映）。
 *
 * 以前のバージョンはExcelのセル背景色・文字色を一切読み取らず、LINE_COLOR/
 * TEXT_COLOR/MUTED_COLORの3色固定で描画していた。ooxml-page-settings.tsの
 * parseCellStyles()がstyles.xmlの<fills>/<fonts>から実際の色を解決するように
 * なったため、生成されたPDFの描画命令(setFillRGBColor)に、Excel側で指定した
 * 色が実際に現れることを確認する。
 *
 * excel-to-pdf-phase18-2.spec.tsの既存テストには手を加えず、新規ファイルとして追加する。
 */

const COLOR_XLSX_PATH = path.join(fixtures.dir.generated, "excel-cell-colors.xlsx");

test.beforeAll(() => {
  // 背景色(赤)・文字色(青)・太字を指定した表を生成する。
  // 既存のexcel-fit-*.xlsx等と混ざらないよう、このテスト専用のファイル名にする。
  const bytes = buildMinimalXlsx([
    {
      name: "Sheet1",
      rows: [
        [{ value: "COLORED_BG_CELL", fill: "#ff0000" }, { value: "COLORED_TEXT_CELL", fontColor: "#0000ff", bold: true }],
        [{ value: "PLAIN_CELL" }, { value: "PLAIN_CELL2" }],
      ],
    },
  ]);
  fs.mkdirSync(fixtures.dir.generated, { recursive: true });
  fs.writeFileSync(COLOR_XLSX_PATH, bytes);
});

test("セルの背景色・文字色がPDFへ反映される(§29-31)", async ({ page }) => {
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, COLOR_XLSX_PATH);

  const converted = await page
    .getByRole("button", { name: "PDFに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!converted) {
    await page.reload();
    await uploadFixture(page, COLOR_XLSX_PATH);
    await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 20_000 });
  }
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path: pdfPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1 });
  expect(isValidPdfFile(pdfPath)).toBe(true);

  const colors = await getFillColorsUsed(pdfPath, 1);
  expect(Array.from(colors), "Excelの背景色(#ff0000)がPDFへ反映されていません").toContain("#ff0000");
  expect(Array.from(colors), "Excelの文字色(#0000ff)がPDFへ反映されていません").toContain("#0000ff");
});
