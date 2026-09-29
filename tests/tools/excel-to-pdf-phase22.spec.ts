import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";

/**
 * Phase 22 B節（excel-to-pdf）専用テスト。
 *
 * Phase 18.2では印刷範囲・用紙・余白・Fit to Page・改ページ・非表示行列・罫線・
 * Gridlinesを検証したが、「Mr.Sattoが勝手にシート名をページ上部へ追加しない」
 * (開発指示書B-9、「非常に重要」と明記)は対象外だったため、このファイルで
 * 単独に検証する。既存のexcel-to-pdf-phase18-2.spec.tsには手を加えない。
 */

async function convertAndDownload(page: import("@playwright/test").Page, xlsxPath: string) {
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, xlsxPath);
  const converted = await page
    .getByRole("button", { name: "PDFに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!converted) {
    await page.reload();
    await uploadFixture(page, xlsxPath);
    await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 20_000 });
  }
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1 });
  expect(isValidPdfFile(path)).toBe(true);
  return path;
}

test("シート名を勝手にPDF上部へ表示しない(B-9)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelSheetNameXlsx);
  const pdf = await extractPdfContent(path);
  // 実際のセルの内容は含まれるが、シート名(Excel側で明示的なHeader/Footer設定は
  // していない)はPDFのどこにも現れてはいけない。
  expect(pdf.text).toContain("SHEETNAME_TEST_CELL_VALUE");
  expect(pdf.text).not.toContain("SHEETNAME_MUST_NOT_APPEAR_IN_PDF");
});
