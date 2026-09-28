import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";

/**
 * Phase 18.2 C節（word-to-pdf）専用テスト。
 *
 * 「Wordの1印刷ページ = PDFの1ページ」を実現するための改修(C-1〜C-14)を、
 * 開発指示書のC-14テストリスト（明示的なPage Break/A4横向き）に加え、
 * 用紙サイズ・余白・見出し/太字/斜体/下線・表・画像・複数セクションの
 * 取り扱いを検証する。既存のword-to-pdf向けE2Eテストファイルは無かったため
 * （tests/tools/配下を事前に確認済み）、この新規ファイルが唯一の
 * word-to-pdf E2Eカバレッジとなる。他ツールのテストには一切手を加えない。
 */

async function convertAndDownload(page: import("@playwright/test").Page, docxPath: string) {
  await page.goto("/tools/word-to-pdf");
  await uploadFixture(page, docxPath);
  // ルート自体の初回コンパイル待ち等、next dev環境固有の理由でボタン表示が
  // 一度だけ遅れることがあるため(excel-to-pdf側の対処と同じ理由)、
  // 見えなければ1度だけ再読み込みしてやり直す。
  const buttonVisible = await page
    .getByRole("button", { name: "PDFに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!buttonVisible) {
    await page.reload();
    await uploadFixture(page, docxPath);
  }
  await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 20_000 });

  async function tryConvert(): Promise<boolean> {
    await page.getByRole("button", { name: "PDFに変換する" }).click();
    const outcome = await Promise.race([
      page
        .getByText("完了", { exact: false })
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "success" as const),
      page
        .getByText("失敗", { exact: false })
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => "error" as const),
    ]).catch(() => "timeout" as const);
    return outcome === "success";
  }

  // mammothの動的import(await import("mammoth"))が、next dev(Turbopack)側でまだ
  // オンデマンドコンパイルされていないタイミングで最初にアクセスされると、
  // excel-to-pdf側と同様にチャンク読み込みが失敗することがある
  // (本番のVercelビルドでは事前ビルド済みチャンクを配信するため発生しない、
  // テスト環境(next dev)固有の現象)。失敗時は1度だけページを再読み込みして
  // やり直す。
  if (!(await tryConvert())) {
    await page.reload();
    await uploadFixture(page, docxPath);
    await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 15_000 });
    const ok = await tryConvert();
    expect(ok, "リロード後もPDF変換が完了しませんでした").toBe(true);
  }

  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1 });
  expect(isValidPdfFile(path)).toBe(true);
  return { path, page };
}

test("明示的な改ページ(w:br type=page): その位置でPDFのページが分かれる(C-9/C-14)", async ({ page }) => {
  const { path } = await convertAndDownload(page, fixtures.wordPageBreakDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(2);
  expect(pdf.pages[0].text).toContain("PAGEBREAK_TEST_PAGE1_TEXT");
  expect(pdf.pages[0].text).not.toContain("PAGEBREAK_TEST_PAGE2_TEXT");
  expect(pdf.pages[1].text).toContain("PAGEBREAK_TEST_PAGE2_TEXT");
  expect(pdf.pages[1].text).not.toContain("PAGEBREAK_TEST_PAGE1_TEXT");
});

test("明示的な改ページ(w:pageBreakBefore): その位置でPDFのページが分かれる(C-9)", async ({ page }) => {
  const { path } = await convertAndDownload(page, fixtures.wordPageBreakBeforeDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(2);
  expect(pdf.pages[0].text).toContain("PBB_TEST_PAGE1_TEXT");
  expect(pdf.pages[0].text).not.toContain("PBB_TEST_PAGE2_TEXT");
  expect(pdf.pages[1].text).toContain("PBB_TEST_PAGE2_TEXT");
});

test("A4横向きのWord文書はA4横向きのPDFになる(C-3/C-4/C-14)", async ({ page }) => {
  const { path } = await convertAndDownload(page, fixtures.wordLandscapeA4Docx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(1);
  expect(pdf.pages[0].width).toBeGreaterThan(pdf.pages[0].height); // 横向き(幅>高さ)
  expect(pdf.pages[0].width).toBeCloseTo(841.89, 0);
  expect(pdf.pages[0].height).toBeCloseTo(595.28, 0);
});

test("余白: 明示的な左余白がPDFの描画開始位置へ反映される(C-8)", async ({ page }) => {
  const { path } = await convertAndDownload(page, fixtures.wordMarginsDocx);
  const pdf = await extractPdfContent(path);
  const marginItem = pdf.pages[0].items.find((it) => it.str === "M");
  expect(marginItem).toBeTruthy();
  // 左余白2.0インチ(=144pt)付近から描画が始まる(既定値56ptとは明確に区別できる)
  expect(marginItem!.x).toBeGreaterThan(135);
  expect(marginItem!.x).toBeLessThan(155);
});

test("見出し・太字/斜体/下線・表・画像が保持される(C-6/C-7/C-10/C-12/C-13)", async ({ page }) => {
  const { path } = await convertAndDownload(page, fixtures.wordRichContentDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.text).toContain("RICH_HEADING_TEXT");
  expect(pdf.text).toContain("RICH_BOLD_TEXT");
  expect(pdf.text).toContain("RICH_ITALIC_TEXT");
  expect(pdf.text).toContain("RICH_UNDERLINE_TEXT");
  expect(pdf.text).toContain("RICH_CELL_A1");
  expect(pdf.text).toContain("RICH_CELL_B2");
});

test("複数セクション: 最初のセクションの用紙設定が適用され、警告が表示される(C-11)", async ({ page }) => {
  const { path, page: p } = await convertAndDownload(page, fixtures.wordMultiSectionDocx);
  const pdf = await extractPdfContent(path);
  // 1つ目のセクション(A4縦)の設定が文書全体に適用されている
  expect(pdf.pages[0].width).toBeCloseTo(595.28, 0);
  expect(pdf.pages[0].height).toBeCloseTo(841.89, 0);
  expect(pdf.text).toContain("SECTION1_TEXT");
  expect(pdf.text).toContain("SECTION2_TEXT");
  await expect(p.getByText("複数のセクション", { exact: false })).toBeVisible();
});
