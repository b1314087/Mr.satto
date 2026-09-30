import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";

/**
 * 外出先PC修正指示書§32-35専用テスト（word-to-pdfのページ溢れ根本原因修正）。
 *
 * word-to-pdf-phase18-2.spec.tsは改ページ・用紙・余白・書式・複数セクションを
 * 個別に確認しているが、「1ページのWord文書が意図せず2ページのPDFになる」という
 * バグそのもの（行間・段落間隔が実際のWordの既定値より大きすぎたことが原因）を
 * 明示的にページ数で検証するテストが無かったため、本ファイルで追加する。
 *
 * 指示書が明示的に要求する組み合わせ（1ページ・文章のみ/1ページ+表/1ページ+画像/
 * 本当に2ページの文書/A4標準余白）を、いずれも明示的な改ページ
 * (w:br type="page"・w:pageBreakBefore)を使わずに用意し、「段落数・内容量だけで
 * 自然に何ページになるか」を確認する（既存のphase18-2側は改ページ機能自体の
 * 検証が目的で、これとは検証観点が異なる）。
 */

async function convertAndDownload(page: import("@playwright/test").Page, docxPath: string) {
  await page.goto("/tools/word-to-pdf");
  await uploadFixture(page, docxPath);
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
  return path;
}

test("1ページ(文章のみ)はPDFでも1ページのまま、かつA4標準余白になる(§32-35)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.wordOnePageTextDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount, "短い文章だけの文書が2ページ以上に溢れています").toBe(1);
  expect(pdf.text).toContain("OVERFLOW_ONEPAGE_TEXT_FIRST");
  expect(pdf.text).toContain("OVERFLOW_ONEPAGE_TEXT_LAST");
  // A4縦(標準余白)のページサイズであること
  expect(pdf.pages[0].width).toBeCloseTo(595.28, 0);
  expect(pdf.pages[0].height).toBeCloseTo(841.89, 0);
  // 標準余白(既定1417twips≈70.85pt)付近から描画が始まっている(0ptに張り付いていない、
  // かつ極端に広すぎない)ことを大まかに確認する。word-to-pdf.tsは1文字ずつ
  // drawTextを呼び出すため(既存のword-margins.spec.tsと同じ理由)、先頭の単一文字
  // "M"段落を目印に使う。
  const marginItem = pdf.pages[0].items.find((it) => it.str === "M");
  expect(marginItem).toBeTruthy();
  expect(marginItem!.x).toBeGreaterThan(50);
  expect(marginItem!.x).toBeLessThan(90);
});

test("1ページ+表は1ページのまま(§32-35)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.wordOnePageWithTableDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount, "短い文章+小さな表だけの文書が2ページ以上に溢れています").toBe(1);
  expect(pdf.text).toContain("OVERFLOW_TABLE_INTRO_TEXT");
  expect(pdf.text).toContain("OVERFLOW_TABLE_A1");
  expect(pdf.text).toContain("OVERFLOW_TABLE_B2");
  expect(pdf.text).toContain("OVERFLOW_TABLE_OUTRO_TEXT");
});

test("1ページ+画像は1ページのまま(§32-35)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.wordOnePageWithImageDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount, "短い文章+小さな画像だけの文書が2ページ以上に溢れています").toBe(1);
  expect(pdf.text).toContain("OVERFLOW_IMAGE_INTRO_TEXT");
  expect(pdf.text).toContain("OVERFLOW_IMAGE_OUTRO_TEXT");
});

test("本当に2ページ分の文章量がある文書は、正しく2ページになる(過剰縮小ではない)(§32-35)", async ({ page }) => {
  const path = await convertAndDownload(page, fixtures.wordGenuineTwoPageDocx);
  const pdf = await extractPdfContent(path);
  // 「1ページに収めるためのフォント縮小」等を行っていないことの確認でもある:
  // 50段落という明確に1ページの収容量を超える量なら、必ず2ページ目に溢れる
  expect(pdf.pageCount, "本来2ページになるはずの文章量が1ページに収まってしまっています").toBe(2);
  expect(pdf.pages[0].text).toContain("OVERFLOW_GENUINE_FIRST_TEXT");
  expect(pdf.pages[0].text).not.toContain("OVERFLOW_GENUINE_LAST_TEXT");
  expect(pdf.pages[1].text).toContain("OVERFLOW_GENUINE_LAST_TEXT");
});
