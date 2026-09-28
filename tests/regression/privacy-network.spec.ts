import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { fieldDisplayId } from "@/lib/pdf-template/types";
import { TEMPLATE_FIELDS } from "../fixtures/template-layout";

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
  await page.locator('[data-testid="pdf-annotate-object-list"]').locator('textarea').first().fill(marker);
  await page.locator('[data-testid="pdf-annotate-object-list"]').locator('textarea').first().blur();

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

test("pdf-fill-annotate(Phase17: 図形・回転・複製・印影)操作中、内容が自社API・外部APIへ送信されない", async ({ page, baseURL }) => {
  // Phase 17: 図形の追加、画像(印影)の回転、オブジェクトの複製、電子印鑑生成PNGの
  // 印影としての取り込み、という新しい操作を一通り行い、書き出し・ダウンロードまでの間、
  // フィクスチャ内容（印影画像データ）がネットワークへ一切送信されないことを確認する。
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/pdf-fill-annotate");

  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(fixtures.singlePagePdf);
  await expect(page.locator('[data-testid="pdf-annotate-canvas"]')).toBeVisible({ timeout: 15_000 });

  // 図形（矩形）を配置
  await page.getByRole("button", { name: "図形", exact: true }).click();
  await page.locator('[data-testid="pdf-annotate-canvas"]').click({ position: { x: 60, y: 60 } });

  // 配置した図形を複製
  await page.locator('[data-testid="pdf-annotate-object-list"]').getByRole("button", { name: "複製" }).first().click();

  // 印影（電子印鑑生成PNGを画像オブジェクトとして取り込む）を配置し、回転させる
  await page.getByRole("button", { name: "印影", exact: true }).click();
  await page.locator('input[type="file"]').last().setInputFiles(fixtures.stampTransparentPng);
  await page.locator('[data-testid="pdf-annotate-canvas"]').click({ position: { x: 420, y: 420 } });
  const rotateButton = page
    .locator('[data-testid="pdf-annotate-object-list"]')
    .getByRole("button", { name: /回転/ })
    .first();
  if (await rotateButton.count()) {
    await rotateButton.click();
  }

  // 書き出し・ダウンロード
  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await expect(page.getByText("書き出しが完了しました", { exact: false })).toBeVisible({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDFをダウンロード" }).click();
  await downloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
});

test("電子印鑑生成(文字から作る)操作中、入力した文字が自社API・外部APIへ送信されない", async ({ page, baseURL }) => {
  // Phase 16: 文字入力から印影PNGを生成・ダウンロードするまでの一連の操作中、
  // 入力した文字がネットワークへ一切送信されないことを確認する。
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/electronic-stamp-generator");

  // 文字から生成モードは実用上の上限として8文字以内に制限しているため、
  // その範囲に収まるユニークなマーカー文字列を使う。
  const marker = "印9f3a1";
  await page.locator("#stamp-text-input").fill(marker);
  await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
  await expect(page.getByText("印影画像が完成しました", { exact: false })).toBeVisible({ timeout: 15_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNGをダウンロード" }).click();
  await downloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
  const markerLeaks = findLeakedRequests(recorder, marker).filter((r) => !r.url.startsWith(origin) || r.method !== "GET");

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  expect(markerLeaks, `入力した文字の漏えいが疑われるリクエスト: ${JSON.stringify(markerLeaks)}`).toEqual([]);
});

test("電子印鑑生成(印鑑を取り込む)操作中、画像・PDFの中身が自社API・外部APIへ送信されない", async ({ page, baseURL }) => {
  // Phase 16: 画像・PDFの取り込み〜範囲選択〜背景透過〜書き出し・ダウンロードまでの
  // 一連の操作中、ファイルの中身がネットワークへ一切送信されないことを確認する。
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/electronic-stamp-generator");

  await page.getByRole("button", { name: "印鑑を取り込む", exact: true }).click();
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(fixtures.stampPdf);
  await expect(page.locator('[data-testid="stamp-crop-container"]')).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "次へ", exact: true }).click();
  await page.getByRole("button", { name: "切り抜く", exact: true }).click();
  await expect(page.locator('[data-testid="stamp-final-preview"]')).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
  await expect(page.getByText("印影画像が完成しました", { exact: false })).toBeVisible({ timeout: 15_000 });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNGをダウンロード" }).click();
  await downloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
});

test("filled-pdf-to-excel(テンプレートモード)操作中、PDF・OCR結果が自社API・外部APIへ送信されず、コンソールにも出力されない", async ({
  page,
  baseURL,
}) => {
  // Phase 18: テンプレート登録(枠の指定)〜記入済みPDFのアップロード〜抽出〜
  // Excelダウンロードまでの一連の操作中、ダミーの記入内容（tests/fixtures/
  // template-layout.ts の山田太郎氏のデータ、実在の人物・個人情報ではない）が
  // ネットワークへ送信されないこと、かつブラウザのコンソールにも出力されない
  // こと（開発指示書25章・39章：console.logへのPDF本文・OCR結果・個人情報の
  // 出力禁止）を確認する。
  const recorder = new NetworkRecorder(page);
  const consoleTexts: string[] = [];
  page.on("console", (msg) => consoleTexts.push(msg.text()));

  const marker = "山田太郎";

  await page.goto("/tools/filled-pdf-to-excel");
  // 既知の環境要因: このページが静的importしているwrite-excel-file起因のチャンクを
  // `next dev`(Turbopack)が初回アクセス時にオンデマンドコンパイルするため、
  // 初回表示だけ数秒〜まれに30秒超まで遅延することがある(tests/tools/work.spec.tsの
  // filled-pdf-to-excel smokeテストのコメント参照。本番ビルドでは再現しない)。
  await expect(page.getByRole("button", { name: "テンプレート", exact: false })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "テンプレート", exact: false }).click();
  await expect(page.getByText("空のテンプレートPDFをドラッグ&ドロップ")).toBeVisible({ timeout: 30_000 });

  await page.locator('input[type="file"]').first().setInputFiles(fixtures.templateBlankPdf);
  await expect(page.locator('[data-testid="template-canvas"]')).toBeVisible({ timeout: 15_000 });

  // 1人目の「氏名」欄のみを登録する(プライバシー検証が目的のため、テンプレート
  // 自体は最小限にする)。座標はtests/fixtures/template-layout.tsのTEMPLATE_FIELDS[0]
  // (フィクスチャPDF生成にも使われている、単一の情報源)と一致させる。
  const field = TEMPLATE_FIELDS[0];
  const badge = fieldDisplayId(field.personIndex, field.fieldIndex);
  await page.getByRole("button", { name: "項目を追加" }).first().click();
  await page.locator('[data-testid="template-canvas"]').click({ position: { x: 20, y: 20 } });
  await page.getByLabel(`X (${badge})`).fill(String(field.x));
  await page.getByLabel(`Y (${badge})`).fill(String(field.y));
  await page.getByLabel(`幅 (${badge})`).fill(String(field.width));
  await page.getByLabel(`高さ (${badge})`).fill(String(field.height));
  await page.getByLabel(`項目名 (${badge})`).fill(field.label);

  await page.getByRole("button", { name: "テンプレート確認へ" }).click();
  await page.getByRole("button", { name: "テンプレートを確定して記入済みPDFへ進む" }).click();
  await expect(page.getByText("記入済みのPDFをドラッグ&ドロップ")).toBeVisible({ timeout: 30_000 });

  await page.locator('input[type="file"]').first().setInputFiles(fixtures.templateFilledPdf);
  const runButton = page.getByRole("button", { name: "抽出する" });
  await expect(runButton).toBeEnabled({ timeout: 20_000 });
  await runButton.click();
  await expect(page.getByText(/出力人数: \d+/)).toBeVisible({ timeout: 45_000 });
  await expect(page.getByLabel("1人目 氏名")).toHaveValue(marker);

  const excelDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Excelをダウンロード" }).click();
  await excelDownloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
  const markerLeaks = findLeakedRequests(recorder, marker).filter((r) => !r.url.startsWith(origin) || r.method !== "GET");
  const consoleLeaks = consoleTexts.filter((t) => t.includes(marker));

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  expect(markerLeaks, `記入内容の漏えいが疑われるリクエスト: ${JSON.stringify(markerLeaks)}`).toEqual([]);
  expect(consoleLeaks, `記入内容がコンソールへ出力されています: ${JSON.stringify(consoleLeaks)}`).toEqual([]);
});

test("excel-to-pdf操作中、Excelのセル内容が自社API・外部APIへ送信されず、コンソールにも出力されない(Phase 18.2 L章)", async ({
  page,
  baseURL,
}) => {
  // Phase 18.2 B節: 印刷設定(印刷範囲・用紙・余白・Fit to Page等)をXLSX内部XMLから
  // 直接読み取るようになった(ooxml-page-settings.ts)ため、セル内容だけでなく
  // その読み取り処理自体もネットワーク送信・コンソール出力を伴わないことを確認する。
  const recorder = new NetworkRecorder(page);
  const consoleTexts: string[] = [];
  page.on("console", (msg) => consoleTexts.push(msg.text()));

  const marker = "FIT1X1_R0C0";
  await page.goto("/tools/excel-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.excelFit1x1Xlsx);
  await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 30_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDFをダウンロード" }).click();
  await downloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
  const markerLeaks = findLeakedRequests(recorder, marker).filter((r) => !r.url.startsWith(origin) || r.method !== "GET");
  const consoleLeaks = consoleTexts.filter((t) => t.includes(marker));

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  expect(markerLeaks, `セル内容の漏えいが疑われるリクエスト: ${JSON.stringify(markerLeaks)}`).toEqual([]);
  expect(consoleLeaks, `セル内容がコンソールへ出力されています: ${JSON.stringify(consoleLeaks)}`).toEqual([]);
});

test("word-to-pdf操作中、Word文書の内容が自社API・外部APIへ送信されず、コンソールにも出力されない(Phase 18.2 L章)", async ({
  page,
  baseURL,
}) => {
  // Phase 18.2 C節: 用紙設定(セクション・余白・pageBreakBefore)をDOCX内部XMLから
  // 直接読み取るようになった(section-settings.ts)ため、本文だけでなくその読み取り
  // 処理自体もネットワーク送信・コンソール出力を伴わないことを確認する。
  const recorder = new NetworkRecorder(page);
  const consoleTexts: string[] = [];
  page.on("console", (msg) => consoleTexts.push(msg.text()));

  const marker = "RICH_HEADING_TEXT";
  await page.goto("/tools/word-to-pdf");
  await page.locator('input[type="file"]').first().setInputFiles(fixtures.wordRichContentDocx);
  await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 30_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "PDFをダウンロード" }).click();
  await downloadPromise;

  const origin = new URL(baseURL!).origin;
  const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
  const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
  const markerLeaks = findLeakedRequests(recorder, marker).filter((r) => !r.url.startsWith(origin) || r.method !== "GET");
  const consoleLeaks = consoleTexts.filter((t) => t.includes(marker));

  expect(apiLeaks, `自社APIへの不審なアップロードが検出されました: ${JSON.stringify(apiLeaks)}`).toEqual([]);
  expect(externalLeaks, `外部への不審なアップロードが検出されました: ${JSON.stringify(externalLeaks)}`).toEqual([]);
  expect(markerLeaks, `文書内容の漏えいが疑われるリクエスト: ${JSON.stringify(markerLeaks)}`).toEqual([]);
  expect(consoleLeaks, `文書内容がコンソールへ出力されています: ${JSON.stringify(consoleLeaks)}`).toEqual([]);
});
