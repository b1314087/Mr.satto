import fs from "node:fs";
import type { Page, Download } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * 代表ツールE2Eテスト共通ヘルパー（Phase 14）。
 *
 * 各ツールは共通の `FileDropzone`（src/components/common/file-dropzone.tsx）を
 * 使っており、実体は常に `<input type="file">` であるため（表示上は非表示でも
 * Playwrightの setInputFiles() は問題なく使える）、ツールごとに個別のセレクタを
 * 用意しなくても、この1つの共通ロケータで全ツールの入力ができる。
 *
 * 「ボタンを押しただけで成功扱いにしない」という方針に沿い、
 * 実際に生成されたファイルの中身（マジックバイト・サイズ）まで確認する。
 */

export async function uploadFixture(page: Page, filePathOrPaths: string | string[]) {
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(filePathOrPaths);
}

export async function waitForSuccess(page: Page, successText: string, timeoutMs = 30_000) {
  await expect(page.getByText(successText, { exact: false })).toBeVisible({ timeout: timeoutMs });
}

export async function clickAndDownload(page: Page, downloadButtonName: string | RegExp): Promise<Download> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: downloadButtonName }).click();
  return await downloadPromise;
}

/** ファイル先頭のマジックバイトから期待する形式かどうかを判定する */
const MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  pdf: (buf) => buf.subarray(0, 5).toString("latin1") === "%PDF-",
  // XLSX/ZIP はどちらもZIPコンテナ（PK\x03\x04）
  zip: (buf) => buf[0] === 0x50 && buf[1] === 0x4b,
  png: (buf) => buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  jpg: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
};

export async function assertDownloadedFile(
  download: Download,
  opts: { format?: keyof typeof MAGIC_BYTES; minBytes?: number } = {}
): Promise<{ path: string; size: number }> {
  const path = await download.path();
  expect(path, "ダウンロードされたファイルのパスが取得できませんでした").toBeTruthy();
  const buf = fs.readFileSync(path!);
  expect(buf.length, "ダウンロードされたファイルが空です").toBeGreaterThan(opts.minBytes ?? 0);
  if (opts.format) {
    const check = MAGIC_BYTES[opts.format];
    expect(check(buf), `ダウンロードされたファイルの形式が期待(${opts.format})と異なります`).toBe(true);
  }
  return { path: path!, size: buf.length };
}
