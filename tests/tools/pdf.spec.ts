import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * PDFカテゴリの代表E2E（Phase 14 優先度1位）:
 * pdf-merge / pdf-split / pdf-to-image / pdf-to-text
 */

test("pdf-merge: 複数PDFを結合してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/pdf-merge");
  await uploadFixture(page, [fixtures.singlePagePdf, fixtures.multiPagePdf]);

  await page.getByRole("button", { name: /件のPDFを結合する$/ }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ダウンロード");
  await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
});

test("pdf-split: 複数ページPDFを分割してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/pdf-split");
  await uploadFixture(page, fixtures.multiPagePdf);

  await page.getByRole("button", { name: "分割する" }).click();
  await waitForSuccess(page, "完了");

  // 3ページ分割 → 複数出力のため「ZIPでダウンロード」になる想定だが、
  // 実装の分岐に依存しすぎないよう正規表現で両方を許容する。
  const download = await clickAndDownload(page, /ダウンロード/);
  await assertDownloadedFile(download, { minBytes: 10 });
});

test("pdf-to-image: PDFを画像化してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/pdf-to-image");
  await uploadFixture(page, fixtures.singlePagePdf);

  await page.getByRole("button", { name: "画像化する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, /ダウンロード/);
  await assertDownloadedFile(download, { minBytes: 10 });
});

test("pdf-to-text: PDFからテキストを抽出してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/pdf-to-text");
  await uploadFixture(page, fixtures.multiPagePdf);

  await page.getByRole("button", { name: "テキストを抽出する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "テキストをダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1 });
  expect(path).toBeTruthy();
});
