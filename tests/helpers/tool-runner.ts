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

/**
 * ファイル入力欄（`input[type="file"]` の先頭）のhydration（Reactの準備）完了を待つ。
 * 上限時間までに完了しなければ false を返す（例外にはしない）。
 *
 * ここに置く理由：`uploadFixture` が内部で使うため。tool-ready.ts は tool-runner.ts を読み込むので、
 * 逆向きの読み込み（循環）を避けるために、実体はこちらに置き、tool-ready.ts から再公開している。
 */
export async function waitForFileInputHydrated(page: Page, timeoutMs = 20_000): Promise<boolean> {
  return page
    .waitForFunction(
      (selector) => {
        const input = document.querySelector(selector);
        return !!input && Object.keys(input).some((k) => k.startsWith("__reactProps$"));
      },
      'input[type="file"]',
      { timeout: timeoutMs }
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * フィクスチャのファイルを、ページ最初のファイル入力欄に設定する。
 *
 * 入力欄のhydrationが終わる前に設定すると、選択が無視されて画面が初期状態のままになることがある
 * （tool-ready.ts 冒頭の調査メモを参照）。そのため、設定の前に入力欄の準備完了を条件で待つ
 * （固定時間の待機ではない）。上限までに準備できなくても例外にはせず、従来どおり設定を試みる
 * ＝ 失敗は、これまでと同じ形で呼び出し側のテストの確認で報告される。
 * すでに準備できている場合は待たずに進むため、事前に待っている呼び出し側（uploadWhenReady 等）と
 * 二重に待っても時間は増えない。
 */
export async function uploadFixture(page: Page, filePathOrPaths: string | string[]) {
  await waitForFileInputHydrated(page);
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
  webp: (buf) => buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP",
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

/**
 * PNGファイルのIHDRチャンクから幅・高さを読み取る（新規パッケージを追加せず、
 * PNGフォーマットのバイト構造を直接パースする）。
 * ダウンロードされた画像が「マジックバイトが一致するだけの空データ」ではなく、
 * 実際に寸法を持つ画像として成立していることを確認するために使う。
 */
export function getPngDimensions(buf: Buffer): { width: number; height: number } {
  // シグネチャ8バイト + 長さ4バイト + "IHDR" 4バイト = オフセット16から幅・高さ(各4バイト、ビッグエンディアン)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
