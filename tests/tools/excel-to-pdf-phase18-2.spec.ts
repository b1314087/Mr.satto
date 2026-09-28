import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, getPageOpSummary, isValidPdfFile } from "../helpers/pdf-inspect";

/**
 * Phase 18.2 B節（excel-to-pdf）専用テスト。
 *
 * 「Excelの1印刷ページ = PDFの1ページ」を実現するための改修(B-1〜B-21)を、
 * 開発指示書のK-2テストリスト（Print Area/A4/A3/Portrait/Landscape/
 * Fit1×1/Fit1×3/Fit2×2/明示的な改ページ/余白/罫線/Gridlines/非表示行/非表示列/
 * 印刷範囲外）に沿って検証する。
 *
 * 既存のexcel-to-pdf向けE2Eテストファイルは無かったため（tests/tools/配下を
 * 事前に確認済み）、この新規ファイルが唯一のexcel-to-pdf E2Eカバレッジとなる。
 * 既存のcsv-excel.spec.ts等、他ツールのテストには一切手を加えない。
 */

async function convertAndDownload(page: import("@playwright/test").Page, xlsxPath: string) {
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, xlsxPath);

  // シート読み込み(readExcelSheets内のawait import("read-excel-file/universal")、
  // Phase 9由来・本フェーズでは無変更)は、next dev(Turbopack)がそのチャンクを
  // まだオンデマンドコンパイルし終えていないタイミングで最初にアクセスすると、
  // 稀に読み込みチャンク自体が404になり読み込みが失敗することを確認済み
  // (実機検証: ネットワークログで node_modules_read-excel-file_universal_*.js が
  // 404、その後の再読み込みでは同じチャンクが正常に読み込める)。本番(Vercel)は
  // 事前ビルド済みチャンクを配信するためこの事象は発生しない、テスト環境
  // (next dev)固有の現象と判断し、失敗時は1度だけページを再読み込みして
  // 再アップロードする(開発指示書Q章の方針に倣い、環境要因をコード側の
  // 不具合と誤認しないための対処)。
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

test("Fit to Width1×Height1: 内容量に関わらず必ず1ページになる(B-13)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelFit1x1Xlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(1);
  expect(pdf.text).toContain("FIT1X1_R0C0");
  expect(pdf.text).toContain("FIT1X1_R14C5"); // 最終行・最終列のセルも1ページに収まっている
});

test("Fit to Width1×Height3: 必ず3ページ(横1×縦3)になる(B-13/B-20 Test2)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelFit1x3Xlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(3);
});

test("Fit to Width2×Height2: 必ず4ページ(横2×縦2)になる(B-13/B-20 Test3)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelFit2x2Xlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(4);
});

test("印刷範囲(Print Area)外のデータはPDFに含まれない(B-5/B-20 Test4)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelPrintAreaXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.text).toContain("INSIDE_R0C0");
  expect(pdf.text).toContain("INSIDE_R2C2");
  expect(pdf.text).not.toContain("OUTSIDE_R0C3");
  expect(pdf.text).not.toContain("OUTSIDE_R5C5");
});

test("非表示の行・列はPDFに含まれない(B-16)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelHiddenXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.text).not.toContain("HIDDEN_ROW_TEXT");
  expect(pdf.text).not.toContain("HIDDEN_COL_TEXT");
  expect(pdf.text).toContain("VISIBLE_TEXT_R0C0");
});

test("明示的な改ページの位置でページが分かれる(B-15)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelPageBreakXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(2);
  expect(pdf.pages[0].text).toContain("BREAK_ROW1");
  expect(pdf.pages[0].text).toContain("BREAK_ROW2");
  expect(pdf.pages[0].text).not.toContain("BREAK_ROW3");
  expect(pdf.pages[1].text).toContain("BREAK_ROW3");
  expect(pdf.pages[1].text).toContain("BREAK_ROW5");
  expect(pdf.pages[1].text).not.toContain("BREAK_ROW1");
});

test("罫線: 実際に設定されている辺だけを描画する(B-6〜B-9)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelBorderPartialXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(1);
  const summary = await getPageOpSummary(path, 1);
  // セル(0,0)のbottom+right、セル(1,1)のtopのみ = 合計3辺だけが線として描画される。
  // pdf-lib の drawLine() は1回の呼び出しにつきmoveTo命令を2回発行する実装のため
  // (node_modules/pdf-lib/cjs/api/operations.js の drawLine 参照。start地点へ
  // moveTo → (任意でsetLineCap) → 同じstart地点へ再度moveTo → lineTo、という順序)、
  // pathSegmentCount(moveTo回数)は「辺の数×2」になる。
  expect(summary.pathSegmentCount).toBe(6);
});

test("Gridlines(枠線の無い大きな表)は罫線情報が無ければ一切線を描画しない(B-7/B-21)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelBorderlessLargeXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.text).toContain("NOBORDER_R0C0");
  for (let i = 1; i <= pdf.pageCount; i++) {
    const summary = await getPageOpSummary(path, i);
    expect(summary.pathSegmentCount).toBe(0);
  }
});

test("用紙サイズ: A3・縦がPDFページサイズへ反映される(B-10)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelPaperA3PortraitXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pages[0].width).toBeCloseTo(841.89, 0);
  expect(pdf.pages[0].height).toBeCloseTo(1190.55, 0);
});

test("用紙サイズ: Letter・横がPDFページサイズへ反映される(B-10/B-11)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelPaperLetterLandscapeXlsx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pages[0].width).toBeCloseTo(792, 0);
  expect(pdf.pages[0].height).toBeCloseTo(612, 0);
});

test("余白: 明示的な左余白がPDFの描画開始位置へ反映される(B-12)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.excelMarginsXlsx);
  const pdf = await extractPdfContent(path);
  const marginItem = pdf.pages[0].items.find((it) => it.str === "M");
  expect(marginItem).toBeTruthy();
  // 左余白1.0インチ(=72pt) + セル内側余白4pt ≈ 76pt 付近から描画が始まる
  // (デフォルトの余白40ptのままなら約44pt付近になるはずで、明確に区別できる)
  expect(marginItem!.x).toBeGreaterThan(65);
  expect(marginItem!.x).toBeLessThan(85);
});
