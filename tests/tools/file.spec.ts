import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * ファイルカテゴリの代表E2E（Phase 14 優先度1位）:
 * file-zip / file-unzip / file-bulk-rename
 */

test("file-zip: 複数ファイルをZIP化してダウンロードできる", async ({ page }) => {
  await page.goto("/tools/file-zip");
  await uploadFixture(page, [fixtures.csv, fixtures.txt]);

  await page.getByRole("button", { name: /件をZIP化する$/ }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "ZIPでダウンロード");
  await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
});

test("file-unzip: ZIPを解凍してまとめてダウンロードできる", async ({ page }) => {
  await page.goto("/tools/file-unzip");
  await uploadFixture(page, fixtures.zip);

  await page.getByRole("button", { name: "解凍する" }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, "まとめてZIPでダウンロード");
  await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
});

test("file-bulk-rename: 複数ファイルをリネームしてダウンロードできる", async ({ page }) => {
  await page.goto("/tools/file-bulk-rename");
  await uploadFixture(page, [fixtures.csv, fixtures.txt]);

  await page.getByRole("button", { name: /件をリネームする$/ }).click();
  await waitForSuccess(page, "完了");

  const download = await clickAndDownload(page, /ダウンロード/);
  const { size } = await assertDownloadedFile(download, { minBytes: 1 });
  expect(size).toBeGreaterThan(0);
});
