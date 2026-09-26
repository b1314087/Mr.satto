import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile, waitForSuccess } from "../helpers/tool-runner";

/**
 * その他カテゴリの代表E2E（Phase 14）:
 * qr-generator / password-generator / char-count / json-formatter / text-line-cleaner
 *
 * このカテゴリはファイルアップロードを伴わない、テキスト入力ベースのツールが
 * 中心のため、共通ヘルパー（uploadFixture）は使わず、テキスト入力→処理→
 * 結果確認、という流れで検証する。
 */

test("qr-generator: テキストからQRコードを生成し画像としてダウンロードできる", async ({ page }) => {
  await page.goto("/tools/qr-generator");
  await page.getByRole("textbox").first().fill("https://mrmatto.vercel.app/");

  await page.getByRole("button", { name: "QRコードを生成する" }).click();
  await waitForSuccess(page, "生成しました");

  await expect(page.getByRole("img", { name: "生成されたQRコード" })).toBeVisible();

  const download = await clickAndDownload(page, "画像としてダウンロード");
  await assertDownloadedFile(download, { format: "png", minBytes: 10 });
});

test("password-generator: パスワードを生成できる", async ({ page }) => {
  await page.goto("/tools/password-generator");

  await page.getByRole("button", { name: "パスワードを生成する" }).click();
  await waitForSuccess(page, "生成しました");

  const code = page.locator("code");
  await expect(code).toBeVisible();
  const passwordText = (await code.textContent())?.trim() ?? "";
  // デフォルトの文字数レンジ（4〜64）内であることの最低限の確認。
  expect(passwordText.length).toBeGreaterThanOrEqual(4);
  expect(passwordText.length).toBeLessThanOrEqual(64);
});

test("char-count: テキストを入力すると文字数などがリアルタイムに表示される", async ({ page }) => {
  await page.goto("/tools/char-count");

  const textarea = page.locator("textarea").first();
  await textarea.fill("あいうえお\nかきくけこ");

  // 「文字数」ラベル付近に、入力に応じた数値が表示される（ライブ集計・ボタンなし）。
  await expect(page.getByText(/文字数/).first()).toBeVisible();
  await expect(page.getByText(/行数/).first()).toBeVisible();
});

test("json-formatter: JSONを整形できる", async ({ page }) => {
  await page.goto("/tools/json-formatter");

  const textareas = page.locator("textarea");
  await textareas.nth(0).fill('{"b":2,"a":1}');

  await page.getByRole("button", { name: "整形する" }).click();
  await waitForSuccess(page, "完了");

  const output = await textareas.nth(1).inputValue();
  expect(output).toContain('"a": 1');
  expect(output).toContain('"b": 2');
});

test("text-line-cleaner: テキストを整理してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/text-line-cleaner");

  const textarea = page.locator("textarea").first();
  await textarea.fill("  行1  \n\n行1\n行2  ");

  await page.getByRole("button", { name: "整理する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, ".txtをダウンロード");
  const { path } = await assertDownloadedFile(download, { minBytes: 1 });
  const fs = await import("node:fs");
  const content = fs.readFileSync(path, "utf8");
  expect(content).toContain("行1");
});
