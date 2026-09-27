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

test("pdf-fill-annotate操作中、PDF・入力したテキスト・画像が自社API・外部APIへ送信されない", async ({ page, baseURL }) => {
  // Phase 15: テキスト・チェック・手書き・画像すべてを配置し、書き出し・ダウンロードまで
  // 一連の操作を行っている間、フィクスチャ内容がネットワークへ一切送信されないことを確認する。
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/pdf-fill-annotate");

  const marker = "PRIVACY-CHECK-9f3a1";
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(fixtures.singlePagePdf);
  await expect(page.locator('[data-testid="pdf-annotate-canvas"]')).toBeVisible({ timeout: 15_000 });

  // テキスト
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await page.locator('[data-testid="pdf-annotate-canvas"]').click({ position: { x: 50, y: 50 } });
  await page.locator('[data-testid="pdf-annotate-object-list"]').locator('input[type="text"]').first().fill(marker);
  await page.locator('[data-testid="pdf-annotate-object-list"]').locator('input[type="text"]').first().blur();

  // チェック
  await page.getByRole("button", { name: "チェック", exact: true }).click();
  await page.locator('[data-testid="pdf-annotate-canvas"]').click({ position: { x: 100, y: 100 } });

  // 手書き
  await page.getByRole("button", { name: "手書き", exact: true }).click();
  // page.mouse.*はビューポート座標を使い、自動スクロールしないため先にスクロールしておく
  await page.locator('[data-testid="pdf-annotate-canvas"]').scrollIntoViewIfNeeded();
  const box = await page.locator('[data-testid="pdf-annotate-canvas"]').boundingBox();
  if (box) {
    await page.mouse.move(box.x + 30, box.y + 150);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 180, { steps: 4 });
    await page.mouse.up();
  }

  // 画像
  await page.getByRole("button", { name: "画像", exact: true }).click();
  await page.locator('input[type="file"]').last().setInputFiles(fixtures.png);
  await page.locator('[data-testid="pdf-annotate-canvas"]').click({ position: { x: 150, y: 200 } });

  // 書き出し・ダウンロード
  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await expect(page.getByText("書き出しが完了しました", { exact: false })).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDFをダウンロード" }).click();
  await downloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
  const markerLeaks = findLeakedRequests(recorder, marker).filter((r) => !r.url.startsWith(origin) || r.method !== "GET");

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  expect(markerLeaks, `入力したテキストの漏えいが疑われるリクエスト: ${JSON.stringify(markerLeaks)}`).toEqual([]);
});
