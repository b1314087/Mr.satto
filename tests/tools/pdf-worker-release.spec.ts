import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture } from "../helpers/tool-runner";

/**
 * ロードマップC 工程2：pdf.js の作業用スレッド（Worker）を、処理が終わったら必ず閉じること・
 * PDFを作る部品（pdf-lib・fontkit）を、ページを開いた時点では読み込まないことのテスト。
 *
 * pdf.js は、PDFを開くたびに作業用スレッド（pdf.worker.min.mjs）を1つ作る。以前は閉じていなかったため、
 * PDFを処理するたびに作業用スレッドが1つずつ増えていた（工程1の実測：4回で4つ）。
 */

/** 今動いている pdf.js の作業用スレッドの数 */
function pdfWorkers(page: Page): number {
  return page.workers().filter((w) => w.url().includes("pdf.worker")).length;
}

async function waitNoPdfWorker(page: Page) {
  await expect.poll(() => pdfWorkers(page), { timeout: 10_000 }).toBe(0);
}

async function removeFile(page: Page) {
  await page.getByRole("button", { name: /を削除$/ }).first().click();
}

test.describe("pdf.js の作業用スレッドを残さない", () => {
  test.setTimeout(180_000);

  test("PDF→画像：異なるPDF（ページ数もさまざま）を続けて処理しても、作業用スレッドが残らない", async ({ page }) => {
    const pdfs = [fixtures.multiPagePdf, fixtures.japanesePdf, fixtures.landscapePdf, fixtures.singlePagePdf, fixtures.templateFilledMultiPagePdf];
    let maxDuring = 0;
    page.on("worker", () => {
      maxDuring = Math.max(maxDuring, pdfWorkers(page));
    });
    await page.goto("/tools/pdf-to-image");
    for (const [i, file] of pdfs.entries()) {
      if (i > 0) await removeFile(page);
      await uploadFixture(page, file);
      await page.getByRole("button", { name: "画像化する", exact: true }).click();
      await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "閉じる" }).first().click();
      // 処理が終わったら、作業用スレッドは0に戻る（回数に比例して増えない）
      await waitNoPdfWorker(page);
    }
    // 同時に動く作業用スレッドは、いつも1つまで（プレビュー用と合わせても増え続けない）
    expect(maxDuring).toBeLessThanOrEqual(2);
  });

  test("同じPDFを繰り返し処理しても、作業用スレッドが残らない", async ({ page }) => {
    await page.goto("/tools/pdf-to-image");
    await uploadFixture(page, fixtures.multiPagePdf);
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "画像化する", exact: true }).click();
      await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "閉じる" }).first().click();
      await waitNoPdfWorker(page);
    }
  });

  test("壊れたPDFでエラーになっても作業用スレッドが残らず、そのあと別のPDFを正しく処理できる", async ({ page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-worker-"));
    const broken = path.join(dir, "broken.pdf");
    fs.writeFileSync(broken, fs.readFileSync(fixtures.multiPagePdf).subarray(0, 400));
    await page.goto("/tools/pdf-to-image");
    await uploadFixture(page, broken);
    await page.getByRole("button", { name: "画像化する", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "broken.pdf の読み込みに失敗しました" })).toBeVisible({ timeout: 30_000 });
    await waitNoPdfWorker(page);
    await removeFile(page);
    await uploadFixture(page, fixtures.japanesePdf);
    await page.getByRole("button", { name: "画像化する", exact: true }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 60_000 });
    await waitNoPdfWorker(page);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("PDF→Excel・PDF→Word：プレビューと変換のあとに、作業用スレッドが残らない", async ({ page }) => {
    await page.goto("/tools/pdf-to-excel");
    await uploadFixture(page, fixtures.pdfToExcelBorderedTablePdf);
    // 先頭ページのプレビュー（サムネイル）を描き終えたら、そのPDFも閉じる
    await waitNoPdfWorker(page);
    await page.getByRole("button", { name: "Excelに変換する", exact: true }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 90_000 });
    await waitNoPdfWorker(page);

    await page.goto("/tools/pdf-to-word");
    await uploadFixture(page, fixtures.japanesePdf);
    await waitNoPdfWorker(page);
    await page.getByRole("button", { name: "Wordに変換する", exact: true }).click();
    await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 90_000 });
    await waitNoPdfWorker(page);
  });

  test("OCR：処理の途中で中断しても、作業用スレッドが残らない", async ({ page }) => {
    await page.goto("/tools/ocr");
    await uploadFixture(page, fixtures.templateFilledScannedPdf);
    await waitNoPdfWorker(page);
    await page.getByRole("button", { name: "文字を読み取る", exact: true }).click();
    await expect.poll(() => pdfWorkers(page), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.getByRole("button", { name: "中断する" }).dispatchEvent("click");
    await expect(page.getByRole("button", { name: "文字を読み取る", exact: true })).toBeEnabled({ timeout: 120_000 });
    await waitNoPdfWorker(page);
  });
});

/**
 * 読み込んだスクリプトの中に、pdf-lib・fontkit が入っているか。
 * 開発用のサーバーでは、スクリプトの中に部品の定義（場所の名前つき）が入っているので、それで判断する。
 */
async function loadedPdfLibParts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((u) => u.includes("/_next/static/") && u.split("?")[0].endsWith(".js"));
    const found = new Set<string>();
    for (const u of urls) {
      const text = await fetch(u).then((r) => r.text()).catch(() => "");
      // 部品の中身（モジュールの定義：「"[project]/node_modules/pdf-lib/…(ecmascript)", ((」）が入っているときだけ数える
      // （読み込み方の案内として名前が書かれているだけのものは数えない）
      if (/"\[project\]\/node_modules\/pdf-lib\/[^"]*\(ecmascript\)", \(\(/.test(text)) found.add("pdf-lib");
      if (/"\[project\]\/node_modules\/@pdf-lib\/fontkit\/[^"]*\(ecmascript\)", \(\(/.test(text)) found.add("fontkit");
    }
    return [...found].sort();
  });
}

test.describe("PDFを作る部品は、ページを開いた時点では読み込まない", () => {
  test.setTimeout(120_000);

  for (const tool of ["seating-chart", "pdf-merge", "invoice-generator", "pdf-add-page-numbers"]) {
    test(`${tool}：ページを開いただけでは pdf-lib・fontkit を読み込まない`, async ({ page }) => {
      await page.goto(`/tools/${tool}`);
      await page.waitForTimeout(2500);
      expect(await loadedPdfLibParts(page)).toEqual([]);
    });
  }

  test("座席表：PDFで書き出すときに部品を読み込み、PDFが正しく作られる（日本語フォントも入る）", async ({ page }) => {
    await page.goto("/tools/seating-chart");
    await page.getByTestId("seat-purpose-meeting").click();
    await page.getByTestId("seat-names").fill("山田太郎\n佐藤花子");
    await page.getByTestId("seat-format-pdf").click();
    const wait = page.waitForEvent("download");
    await page.getByRole("button", { name: /PDFでダウンロード/ }).click();
    const dl = await wait;
    const file = path.join(os.tmpdir(), `seat-${Date.now()}.pdf`);
    await dl.saveAs(file);
    const head = fs.readFileSync(file).subarray(0, 5).toString();
    expect(head).toBe("%PDF-");
    expect(fs.statSync(file).size).toBeGreaterThan(1_000_000); // 日本語フォント（丸ごと）が入っている
    expect(await loadedPdfLibParts(page)).toEqual(["fontkit", "pdf-lib"]);
    fs.rmSync(file, { force: true });
  });
});
