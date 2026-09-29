import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";

/**
 * Phase 22 C節（word-to-pdf）専用テスト。
 *
 * Phase 18.2では用紙設定・改ページ・表・画像等を扱ったが、「Wordで入れた空白行が
 * PDFでは詰まって消えてしまう」問題(開発指示書C-2〜C-4)は対象外だったため、
 * このファイルで単独に検証する。既存のword-to-pdf-phase18-2.spec.tsには
 * 手を加えず、新規ファイルとして追加する。
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
  return { path, page };
}

test("空白行・連続空行: 空行の数に比例して段落間隔が広がる(C-2/C-3/C-4)", async ({ page }) => {
  const { path } = await convertAndDownload(page, fixtures.wordBlankLinesDocx);
  const pdf = await extractPdfContent(path);
  expect(pdf.pageCount).toBe(1);

  const find = (ch: string) => pdf.pages[0].items.find((it) => it.str === ch);
  const p = find("P");
  const q = find("Q");
  const r = find("R");
  const s = find("S");
  expect(p, "P(空行なしの1行目)が見つかりません").toBeTruthy();
  expect(q, "Q(空行なしの2行目)が見つかりません").toBeTruthy();
  expect(r, "R(空行1つを挟んだ行)が見つかりません").toBeTruthy();
  expect(s, "S(空行2つを挟んだ行)が見つかりません").toBeTruthy();

  // word-to-pdf.tsのLINE_HEIGHT(15)+PARAGRAPH_GAP(6)=21ptが「段落1つぶん」の間隔。
  // 空行なし(P→Q)は21pt、空行1つ(Q→R)は42pt(21の2倍)、空行2つ(R→S)は63pt
  // (21の3倍)になるはず。空行を1行分として積んでいない場合(修正前の
  // lineHeight*0.6=9ptのみを消費する実装)は、Q→Rが30pt・R→Sが39ptなど、
  // 21の整数倍からずれた値になり、このテストで検出できる。
  const gapPQ = p!.y - q!.y;
  const gapQR = q!.y - r!.y;
  const gapRS = r!.y - s!.y;

  expect(gapPQ).toBeCloseTo(21, 0);
  expect(gapQR).toBeCloseTo(42, 0);
  expect(gapRS).toBeCloseTo(63, 0);

  // 比率としても「空行の数に比例して増える」ことを確認する(定数の細かな
  // チューニングが将来入っても、この比例関係だけは崩れてはいけない)。
  expect(gapQR / gapPQ).toBeCloseTo(2, 1);
  expect(gapRS / gapPQ).toBeCloseTo(3, 1);
});
