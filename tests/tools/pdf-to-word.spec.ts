import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readDocxText } from "../helpers/docx-inspect";

/**
 * pdf-to-word専用テスト（外出先PC修正指示書§27-28: スキャンPDF(OCR)対応）。
 *
 * 以前は文字レイヤーの無いページ(紙をスキャンした画像PDF)に遭遇すると、
 * ファイル全体を「未対応」としてエラーにしていた。filled-pdf-to-excel.tsが
 * 既に確立しているOCRフォールバック（ページを画像化してtesseract.jsで
 * 認識し、以後は文字レイヤーのページと同じ構造推定ロジックに渡す）を
 * pdf-to-word.tsにも導入したため、実際にOCR経由でWord文書が生成できることを
 * 確認する（ボタンを押して成功表示が出ただけで満足せず、生成されたDOCXの
 * 中身に実際にOCRしたテキストが含まれていることまで確認する）。
 */
test("スキャンPDF(文字レイヤー無し)はOCRで自動的にテキスト化され、Word文書が生成される(§27-28)", async ({ page }) => {
  test.setTimeout(120_000); // OCR(tesseract.js WASM初期化+認識)はテキストレイヤー抽出より時間がかかる

  await page.goto("/tools/pdf-to-word");
  await uploadFixture(page, fixtures.pdfToWordScannedPdf);
  // next dev(Turbopack)の初回コンパイル待ち等でアップロード直後にボタンが
  // 現れないことがある既知の不安定さへの対処（他のspecと同じ再読み込み方式）。
  const buttonVisible = await page
    .getByRole("button", { name: "Wordに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!buttonVisible) {
    await page.reload();
    await uploadFixture(page, fixtures.pdfToWordScannedPdf);
  }
  await expect(page.getByRole("button", { name: "Wordに変換する" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Wordに変換する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 90_000 });

  // OCRを実際に使用したことを示す表示が出ていること(usedOcr)
  await expect(page.getByText("OCR使用", { exact: false })).toBeVisible();

  const download = await clickAndDownload(page, "Word文書をダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });

  const text = await readDocxText(path);
  // OCRの認識結果は完全一致を期待できないため(フォント・アンチエイリアス等に依存)、
  // 大きく明瞭な英単語"HELLO"・"WORLD"が(大文字小文字を問わず)含まれることだけを
  // 確認する。手書き文字の認識精度自体の検証が目的ではなく、
  // 「OCR経由の文字がちゃんとWord文書の本文として書き出されている」ことの検証が目的。
  const upper = text.toUpperCase();
  expect(upper, `OCR結果にHELLOが含まれていません。実際の認識結果: ${text}`).toContain("HELLO");
  expect(upper, `OCR結果にWORLDが含まれていません。実際の認識結果: ${text}`).toContain("WORLD");
});
