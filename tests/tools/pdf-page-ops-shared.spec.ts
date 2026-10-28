import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { test as processorTest, expect as processorExpect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { clickWhenReady, uploadWhenReady } from "../helpers/tool-ready";
import { inspectOutputPdf, writeSequentialPdf, type OutputPdfInfo } from "../helpers/pdf-page-quality";
import {
  PdfDeletePagesProcessor,
  PdfExtractPagesProcessor,
  PdfReorderPagesProcessor,
  PdfSplitProcessor,
} from "@/lib/processors/browser/pdf";
import { assertValidPageRange, parsePageRanges, rangeToIndices } from "@/lib/pdf/page-selection";

/**
 * PDFページ編集4ツール（削除・抽出・並べ替え・分割）の共通処理のテスト。
 *
 * 共通化した処理（ページを写して新しいPDFを作る処理・ページ範囲の検証・出力名・画面の「古い結果の破棄」）が、
 * 各ツールの仕様を変えていないことを確認する。出力の本文の確認は、既存の出力品質テスト
 * （pdf-page-ops-quality.spec.ts）と同じ合成PDF・検査ヘルパーを使う。
 *  - 前半: 処理ロジックを直接呼ぶ（境界条件・エラー・壊れたPDF・分割の出力名）
 *  - 後半: 画面（設定を変えたら古い結果をダウンロードできなくなること・分割の出力）
 */

let workDir = "";
processorTest.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfshared-"));
});
processorTest.afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
const workPath = (name: string) => path.join(workDir, name);

async function makeFile(pages: number, name = "input.pdf"): Promise<File> {
  const p = workPath(`src-${name}`);
  await writeSequentialPdf(p, pages);
  return new File([fs.readFileSync(p)], name, { type: "application/pdf" });
}

async function inspectBlob(blob: Blob, name: string): Promise<OutputPdfInfo> {
  const p = workPath(name);
  fs.writeFileSync(p, Buffer.from(await blob.arrayBuffer()));
  return inspectOutputPdf(p);
}

// ---------------------------------------------------------------------------
// 1. ページ範囲の共通処理（純粋関数）
// ---------------------------------------------------------------------------
processorTest.describe("ページ範囲の共通処理", () => {
  processorTest("parsePageRanges: 個別ページ・範囲・空白を解釈し、指定順を保つ", () => {
    processorExpect(parsePageRanges(" 1-3 , 5, 8-10 ", 10)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 5 },
      { start: 8, end: 10 },
    ]);
    processorExpect(parsePageRanges("4,1", 4)).toEqual([
      { start: 4, end: 4 },
      { start: 1, end: 1 },
    ]);
  });

  processorTest("parsePageRanges: 先頭・末尾・全ページの境界は有効", () => {
    processorExpect(parsePageRanges("1", 5)).toEqual([{ start: 1, end: 1 }]);
    processorExpect(parsePageRanges("5", 5)).toEqual([{ start: 5, end: 5 }]);
    processorExpect(parsePageRanges("1-5", 5)).toEqual([{ start: 1, end: 5 }]);
  });

  const invalid: { input: string; message: string }[] = [
    { input: "", message: "ページ範囲を入力してください" },
    { input: " , ", message: "ページ範囲を入力してください" },
    { input: "0", message: "1〜5の範囲で指定してください" },
    { input: "6", message: "1〜5の範囲で指定してください" },
    { input: "1-6", message: "1〜5の範囲で指定してください" },
    { input: "4-2", message: "1〜5の範囲で指定してください" },
    { input: "abc", message: "ページ範囲の指定が正しくありません" },
    { input: "1-", message: "ページ範囲の指定が正しくありません" },
  ];
  for (const c of invalid) {
    processorTest(`parsePageRanges: 不正な指定「${c.input}」はエラーになる`, () => {
      processorExpect(() => parsePageRanges(c.input, 5)).toThrow(c.message);
    });
  }

  processorTest("assertValidPageRange / rangeToIndices: 小数・負数・範囲外は不正、位置は0始まり", () => {
    processorExpect(() => assertValidPageRange({ start: 1.5, end: 2 }, 5)).toThrow("ページ範囲の指定が正しくありません");
    processorExpect(() => assertValidPageRange({ start: -1, end: 2 }, 5)).toThrow("ページ範囲の指定が正しくありません");
    processorExpect(() => assertValidPageRange({ start: 1, end: 5 }, 5)).not.toThrow();
    processorExpect(rangeToIndices({ start: 2, end: 4 })).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 2. 4つの処理ロジックの出力（境界条件）
// ---------------------------------------------------------------------------
processorTest.describe("PDF分割（処理ロジック）", () => {
  processorTest("1ページごとに分割: ページ数分のPDFができ、桁をそろえた名前で、各ファイルは元の1ページだけを持つ", async () => {
    const file = await makeFile(10, "book.pdf");
    const outputs = await new PdfSplitProcessor().process({ file, mode: "each-page" });
    processorExpect(outputs.map((o) => o.suggestedName)).toEqual(
      Array.from({ length: 10 }, (_, i) => `book-${String(i + 1).padStart(2, "0")}.pdf`)
    );
    for (const i of [0, 9]) {
      const info = await inspectBlob(outputs[i].blob, `each-${i}.pdf`);
      processorExpect(info.pageCount).toBe(1);
      processorExpect(info.originalOrder).toEqual([i + 1]);
    }
  });

  processorTest("ページ範囲で分割: 範囲ごとにPDFができ、名前は単ページ p3 / 複数ページ p1-2。先頭・末尾・全ページも正しい", async () => {
    const file = await makeFile(5, "doc.pdf");
    const outputs = await new PdfSplitProcessor().process({
      file,
      mode: "range",
      ranges: [
        { start: 1, end: 2 },
        { start: 3, end: 3 },
        { start: 5, end: 5 },
        { start: 1, end: 5 },
      ],
    });
    processorExpect(outputs.map((o) => o.suggestedName)).toEqual(["doc-p1-2.pdf", "doc-p3.pdf", "doc-p5.pdf", "doc-p1-5.pdf"]);
    const expected = [[1, 2], [3], [5], [1, 2, 3, 4, 5]];
    for (let i = 0; i < outputs.length; i++) {
      const info = await inspectBlob(outputs[i].blob, `range-${i}.pdf`);
      processorExpect(info.originalOrder, outputs[i].suggestedName).toEqual(expected[i]);
    }
  });

  processorTest("範囲が空・範囲外・逆順のときはエラーになり、出力は作られない", async () => {
    const file = await makeFile(3);
    const split = (ranges: { start: number; end: number }[]) => new PdfSplitProcessor().process({ file, mode: "range", ranges });
    await processorExpect(split([])).rejects.toThrow("分割するページ範囲を指定してください");
    await processorExpect(split([{ start: 0, end: 1 }])).rejects.toThrow("1〜3の範囲で指定してください");
    await processorExpect(split([{ start: 1, end: 4 }])).rejects.toThrow("1〜3の範囲で指定してください");
    await processorExpect(split([{ start: 3, end: 2 }])).rejects.toThrow("1〜3の範囲で指定してください");
    // 1つでも不正なら全体がエラー（有効な範囲だけを黙って出力しない）
    await processorExpect(split([{ start: 1, end: 1 }, { start: 2, end: 9 }])).rejects.toThrow("1〜3の範囲で指定してください");
  });
});

processorTest.describe("PDFページ削除・抽出・並べ替え（処理ロジックの境界条件）", () => {
  processorTest("削除: 先頭だけ・末尾だけを削除しても、残りは元の順序のまま", async () => {
    const file = await makeFile(4);
    for (const [target, rest] of [[1, [2, 3, 4]], [4, [1, 2, 3]]] as const) {
      const out = await new PdfDeletePagesProcessor().process({ file, pagesToDelete: [target] });
      processorExpect(out.pageCount).toBe(rest.length);
      processorExpect((await inspectBlob(out.blob, `del-${target}.pdf`)).originalOrder).toEqual(rest);
      URL.revokeObjectURL(out.url);
    }
  });

  processorTest("削除: 全ページ・未選択はエラー。範囲外の番号や重複は無視され、有効なページだけが削除される", async () => {
    const file = await makeFile(3);
    const del = (pagesToDelete: number[]) => new PdfDeletePagesProcessor().process({ file, pagesToDelete });
    await processorExpect(del([1, 2, 3])).rejects.toThrow("すべてのページを削除することはできません");
    await processorExpect(del([])).rejects.toThrow("削除するページを選択してください");
    await processorExpect(del([0, 9])).rejects.toThrow("削除するページを選択してください");
    const out = await del([2, 2, 99]);
    processorExpect((await inspectBlob(out.blob, "del-dup.pdf")).originalOrder).toEqual([1, 3]);
    URL.revokeObjectURL(out.url);
  });

  processorTest("抽出: 先頭だけ・末尾だけ・全ページ(1-N)を指定どおりに出力する。範囲外・0は誤った出力を作らない", async () => {
    const file = await makeFile(4);
    const extract = (pageSelection: string) => new PdfExtractPagesProcessor().process({ file, pageSelection });
    for (const [sel, expected] of [["1", [1]], ["4", [4]], ["1-4", [1, 2, 3, 4]], ["4,1", [4, 1]]] as const) {
      const out = await extract(sel);
      processorExpect((await inspectBlob(out.blob, `ex-${sel}.pdf`)).originalOrder, sel).toEqual(expected);
      URL.revokeObjectURL(out.url);
    }
    await processorExpect(extract("5")).rejects.toThrow("存在しないページが指定されています");
    await processorExpect(extract("0")).rejects.toThrow("1以上のページ番号を指定してください");
  });

  processorTest("並べ替え: 全ページの並べ替えのみ受け付け、欠落・重複・範囲外はエラー", async () => {
    const file = await makeFile(3);
    const reorder = (newOrder: number[]) => new PdfReorderPagesProcessor().process({ file, newOrder });
    const out = await reorder([3, 1, 2]);
    processorExpect((await inspectBlob(out.blob, "re.pdf")).originalOrder).toEqual([3, 1, 2]);
    URL.revokeObjectURL(out.url);
    for (const bad of [[1, 2], [1, 1, 2], [1, 2, 4], [0, 1, 2], [1, 2, 3, 3]]) {
      await processorExpect(reorder(bad), bad.join(",")).rejects.toThrow("ページの並び順が正しくありません");
    }
  });

  processorTest("PDFでないファイル・壊れたPDFは、4つのツールすべてで安全にエラーになる（例外で落ちず、結果を作らない）", async () => {
    const bad = new File([new TextEncoder().encode("this is not a pdf")], "broken.pdf", { type: "application/pdf" });
    const message = "broken.pdf の読み込みに失敗しました";
    await processorExpect(new PdfDeletePagesProcessor().process({ file: bad, pagesToDelete: [1] })).rejects.toThrow(message);
    await processorExpect(new PdfExtractPagesProcessor().process({ file: bad, pageSelection: "1" })).rejects.toThrow(message);
    await processorExpect(new PdfReorderPagesProcessor().process({ file: bad, newOrder: [1] })).rejects.toThrow(message);
    await processorExpect(new PdfSplitProcessor().process({ file: bad, mode: "each-page" })).rejects.toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// 3. 画面: 設定を変えたら、古い結果はダウンロードできない／分割の出力
// ---------------------------------------------------------------------------
test.describe("PDFページ編集4ツールの画面", () => {
  async function open(page: Page, slug: string, pdfPath: string, ready: Locator) {
    await page.goto(`/tools/${slug}`);
    await uploadWhenReady(page, pdfPath, ready, { readyTimeoutMs: 25_000 });
  }

  async function downloadPdf(page: Page, name: string): Promise<OutputPdfInfo> {
    const download = await clickAndDownload(page, /^ダウンロード$/);
    const saved = workPath(name);
    await download.saveAs(saved);
    await assertDownloadedFile(download, { format: "pdf", minBytes: 100 });
    return inspectOutputPdf(saved);
  }

  const downloadButton = (page: Page) => page.getByRole("button", { name: /ダウンロード/ });

  test("削除: 実行後に選択ページを変えると古い結果は消え、再実行した結果が出力される", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 3);
    await open(page, "pdf-delete-pages", input, page.getByText(/削除するページを選択/));

    await clickWhenReady(page.getByRole("button", { name: /^2$/ }));
    await clickWhenReady(page.getByRole("button", { name: "1ページを削除する", exact: true }), {
      expectAfter: page.getByText("削除が完了しました"),
    });
    await expect(downloadButton(page)).toBeVisible();

    // 選択を変える → 古い結果（ページ2を削除した結果）は表示もダウンロードもできない
    await clickWhenReady(page.getByRole("button", { name: /^3( 削除)?$/ }));
    await expect(page.getByText("削除が完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);

    await clickWhenReady(page.getByRole("button", { name: "2ページを削除する", exact: true }), {
      expectAfter: page.getByText("削除が完了しました"),
    });
    expect((await downloadPdf(page, "deleted.pdf")).originalOrder).toEqual([1]);
  });

  test("抽出: 実行後にページ指定を変えると古い結果は消え、再実行した結果が出力される", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 4);
    const field = page.getByPlaceholder("例: 1,3,5-7");
    await open(page, "pdf-extract-pages", input, field);

    await field.fill("1");
    await clickWhenReady(page.getByRole("button", { name: "ページを抽出する" }), { expectAfter: page.getByText("抽出が完了しました") });
    await expect(downloadButton(page)).toBeVisible();

    await field.fill("4,2");
    await expect(page.getByText("抽出が完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);

    await clickWhenReady(page.getByRole("button", { name: "ページを抽出する" }), { expectAfter: page.getByText("抽出が完了しました") });
    expect((await downloadPdf(page, "extracted.pdf")).originalOrder).toEqual([4, 2]);
  });

  test("並べ替え: 実行後に順序を変えると古い結果は消え、再実行した結果が出力される", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 3);
    await open(page, "pdf-reorder-pages", input, page.getByText(/↑↓ で並び替え/));

    await clickWhenReady(page.getByRole("button", { name: "1番目を下へ移動", exact: true })); // [2,1,3]
    await clickWhenReady(page.getByRole("button", { name: "並び替えを適用する" }), { expectAfter: page.getByText("並び替えが完了しました") });
    await expect(downloadButton(page)).toBeVisible();

    await clickWhenReady(page.getByRole("button", { name: "2番目を下へ移動", exact: true })); // [2,3,1]
    await expect(page.getByText("並び替えが完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);

    await clickWhenReady(page.getByRole("button", { name: "並び替えを適用する" }), { expectAfter: page.getByText("並び替えが完了しました") });
    expect((await downloadPdf(page, "reordered.pdf")).originalOrder).toEqual([2, 3, 1]);
  });

  test("分割: 範囲指定の複数出力はZIP（範囲ごとのPDF・指定の名前）、分割方法を変えると古い結果は消える", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 4);
    await open(page, "pdf-split", input, page.getByText("このPDFは4ページです"));

    // 1ページごと → 完了 → 方法を変えると結果が消える
    await clickWhenReady(page.getByRole("button", { name: "分割する" }), { expectAfter: page.getByText("分割が完了しました") });
    await expect(downloadButton(page)).toBeVisible();
    await clickWhenReady(page.getByRole("button", { name: "ページ範囲を指定" }));
    await expect(page.getByText("分割が完了しました")).toHaveCount(0);
    await expect(downloadButton(page)).toHaveCount(0);

    const field = page.getByPlaceholder("例: 1-3,5,8-10");
    await field.fill("1-2,4");
    await clickWhenReady(page.getByRole("button", { name: "分割する" }), { expectAfter: page.getByText("分割が完了しました") });

    // 範囲を変えても古い結果は出ない
    await field.fill("1-2,3-4");
    await expect(page.getByText("分割が完了しました")).toHaveCount(0);
    await field.fill("1-2,4");
    await clickWhenReady(page.getByRole("button", { name: "分割する" }), { expectAfter: page.getByText("分割が完了しました") });

    const download = await clickAndDownload(page, /ZIPでダウンロード/);
    const saved = workPath("split.zip");
    await download.saveAs(saved);
    await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
    const files = unzipSync(new Uint8Array(fs.readFileSync(saved)));
    expect(Object.keys(files).sort()).toEqual(["input-p1-2.pdf", "input-p4.pdf"]);
    const expected: Record<string, number[]> = { "input-p1-2.pdf": [1, 2], "input-p4.pdf": [4] };
    for (const [name, originals] of Object.entries(expected)) {
      const p = workPath(name);
      fs.writeFileSync(p, Buffer.from(files[name]));
      expect((await inspectOutputPdf(p)).originalOrder, name).toEqual(originals);
    }
  });

  test("分割: 範囲が1つだけなら、ZIPではなくPDFが1つダウンロードされる", async ({ page }) => {
    const input = workPath("input.pdf");
    await writeSequentialPdf(input, 4);
    await open(page, "pdf-split", input, page.getByText("このPDFは4ページです"));
    await clickWhenReady(page.getByRole("button", { name: "ページ範囲を指定" }));
    await page.getByPlaceholder("例: 1-3,5,8-10").fill("2-3");
    await clickWhenReady(page.getByRole("button", { name: "分割する" }), { expectAfter: page.getByText("分割が完了しました") });
    const download = await clickAndDownload(page, /^ダウンロード$/);
    expect(download.suggestedFilename()).toBe("input-p2-3.pdf");
    const saved = workPath("p23.pdf");
    await download.saveAs(saved);
    await assertDownloadedFile(download, { format: "pdf", minBytes: 100 });
    expect((await inspectOutputPdf(saved)).originalOrder).toEqual([2, 3]);
  });

  const invalidSplit: { range: string; message: string }[] = [
    { range: "0-2", message: "ページ範囲の指定が正しくありません（1〜4の範囲で指定してください）" },
    { range: "3-9", message: "ページ範囲の指定が正しくありません（1〜4の範囲で指定してください）" },
    { range: "4-2", message: "ページ範囲の指定が正しくありません（1〜4の範囲で指定してください）" },
    { range: "abc", message: "ページ範囲の指定が正しくありません（\"abc\"）" },
  ];
  for (const c of invalidSplit) {
    test(`分割: 不正な範囲「${c.range}」は理由が表示され、出力は作られない`, async ({ page }) => {
      const input = workPath("input.pdf");
      await writeSequentialPdf(input, 4);
      await open(page, "pdf-split", input, page.getByText("このPDFは4ページです"));
      await clickWhenReady(page.getByRole("button", { name: "ページ範囲を指定" }));
      await page.getByPlaceholder("例: 1-3,5,8-10").fill(c.range);
      await expect(page.locator("p").filter({ hasText: c.message })).toBeVisible();
      await clickWhenReady(page.getByRole("button", { name: "分割する" }), { expectAfter: page.getByRole("alert").filter({ hasText: c.message }) });
      await expect(page.getByText("分割が完了しました")).toHaveCount(0);
      await expect(downloadButton(page)).toHaveCount(0);
    });
  }

  for (const slug of ["pdf-delete-pages", "pdf-extract-pages", "pdf-reorder-pages", "pdf-split"]) {
    test(`${slug}: 壊れたPDFを選ぶと、エラーが表示され、操作画面・結果は出ない`, async ({ page }) => {
      const bad = workPath("broken.pdf");
      fs.writeFileSync(bad, "this is not a pdf");
      await page.goto(`/tools/${slug}`);
      await uploadWhenReady(page, bad, page.getByRole("alert").filter({ hasText: "読み込みに失敗しました" }), { readyTimeoutMs: 25_000 });
      await expect(downloadButton(page)).toHaveCount(0);
    });
  }
});
