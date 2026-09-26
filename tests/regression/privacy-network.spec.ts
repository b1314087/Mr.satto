import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";

/**
 * privacy回帰テスト（Phase 14）。
 *
 * Mr.Sattoの各ツールは「ブラウザ内で処理し、ファイルの中身をサーバーへ送らない」
 * ことをうたっているため（README・各ツールの説明文、Phase 13棚卸しでも確認済み）、
 * 代表的なファイル処理ツールを実際に操作している間、テスト用フィクスチャの内容が
 * 自社API・外部APIへ送信されていないことを、Playwrightのネットワーク監視で確認する。
 *
 * 注意: これはベストエフォートの検証であり、絶対的な証明ではない
 * （tests/helpers/network-guard.ts のコメント参照）。
 */

test("pdf-merge操作中、PDFの中身が自社API・外部APIへ送信されない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/pdf-merge");

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles([fixtures.singlePagePdf, fixtures.multiPagePdf]);
  await page.getByRole("button", { name: /件のPDFを結合する$/ }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 30_000 });

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
});

test("csv-format操作中、入力したCSV内容がリクエストに含まれない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/csv-format");

  // フィクスチャに含まれる、他では出現しないユニークな文字列をマーカーとして使う。
  const marker = "テスト商品A";
  const fs = await import("node:fs");
  const csvContent = fs.readFileSync(fixtures.csv, "utf8");
  expect(csvContent).toContain(marker);

  await page.locator("textarea").first().fill(csvContent);
  await page.getByRole("button", { name: "整形する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 15_000 });

  const leaked = findLeakedRequests(recorder, marker);
  const origin = new URL(baseURL!).origin;
  // 同一オリジンのページ遷移・アセット取得以外に、マーカー文字列を含むリクエストがないこと。
  const suspicious = leaked.filter((r) => !r.url.startsWith(origin) || r.method !== "GET");
  expect(suspicious, `フィクスチャ内容の漏えいが疑われるリクエスト: ${JSON.stringify(suspicious)}`).toEqual([]);
});
