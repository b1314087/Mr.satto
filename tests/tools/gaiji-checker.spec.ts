import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";
import { buildMinimalDocx } from "../fixtures/docx-writer";
import { buildMinimalXlsx } from "../fixtures/xlsx-writer";
import { assertDownloadedFile, clickAndDownload } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";

/**
 * 外字・特殊文字チェック（gaiji-checker）の画面テスト。判定の規則そのものは gaiji-detect.spec.ts（単体）で確認する。
 * ここでは、実際に文字を貼り付け・ファイルを選び、結果・整えたテキスト・CSV・通信を確認する。値はすべて架空。
 */

const MARKER = "架空の名前ゲンカイ検証用";

async function openTool(page: Page) {
  await page.goto("/tools/gaiji-checker");
  await expect(page.getByTestId("gaiji-text")).toBeVisible({ timeout: 30_000 });
}

async function pasteAndRun(page: Page, text: string) {
  // 開発サーバーの初回は、入力の準備（hydration）が終わる前の入力が無視されることがあるため、結果が出るまで繰り返す
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByTestId("gaiji-text").fill(text);
    await page.getByTestId("gaiji-run").click();
    const shown = await page.getByTestId("gaiji-summary").waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
    if (shown) return;
  }
  await expect(page.getByTestId("gaiji-summary")).toBeVisible();
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gaiji-"));
}

function groupCategories(page: Page): Promise<string[]> {
  return page.getByTestId("gaiji-group").evaluateAll((els) => els.map((e) => e.getAttribute("data-category") ?? ""));
}

test("gaiji-checker: 貼り付けた文字を調べ、種類ごとに、コード・件数・場所の例つきで表示する", async ({ page }) => {
  await openTool(page);
  const text = ["山田 太郎", "髙橋 花子​", "佐藤次郎", "ﾀﾅｶ ㈱サンプル", "がき"].join("\n");
  await pasteAndRun(page, text);

  await expect(page.getByTestId("gaiji-found")).toContainText("問題になりうる文字");
  const cats = await groupCategories(page);
  // 要確認 → 注意 → 参考 の順（外字が先頭）
  expect(cats[0]).toBe("private-use");
  expect(cats).toEqual(expect.arrayContaining(["private-use", "invisible", "combining", "ext-dep", "halfwidth-kana"]));
  expect(cats.indexOf("private-use")).toBeLessThan(cats.indexOf("halfwidth-kana"));

  const zw = page.locator('[data-testid="gaiji-row"][data-code="U+200B"]');
  await expect(zw).toContainText("ゼロ幅スペース");
  await expect(zw).toContainText("2行目（6文字目）");
  const pua = page.locator('[data-testid="gaiji-row"][data-code="U+E001"]');
  await expect(pua).toContainText("3行目（3文字目）");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+9AD9"]')).toContainText("髙");
  // 問題のない文字（山田太郎など）は結果に出ない
  await expect(page.getByTestId("gaiji-row").filter({ hasText: "山" })).toHaveCount(0);
  // 対処の説明が出る
  await expect(page.locator('[data-category="private-use"]')).toContainText("対処：");
  // できないことの説明が、いつも出ている
  await expect(page.getByText("このチェックでできること・できないこと")).toBeVisible();
});

test("gaiji-checker: 問題のない文字は「見つかりませんでした」と出し、保証ではないことも示す", async ({ page }) => {
  await openTool(page);
  await pasteAndRun(page, "山田太郎\n東京都千代田区1-1\nABC abc 123");
  await expect(page.getByTestId("gaiji-none")).toContainText("見つかりませんでした");
  await expect(page.getByTestId("gaiji-group")).toHaveCount(0);
  await expect(page.getByText(/保証ではありません/)).toBeVisible();
});

test("gaiji-checker: Shift_JISのチェックをオフにすると、機種依存文字などは出さず、外字と見えない文字は出す", async ({ page }) => {
  await openTool(page);
  const text = "髙橋①㈱ｱ〜é​";
  await pasteAndRun(page, text);
  const withSjis = await groupCategories(page);
  expect(withSjis).toEqual(expect.arrayContaining(["ext-dep", "halfwidth-kana", "sjis-mismatch", "not-sjis", "private-use", "invisible"]));

  await page.getByTestId("gaiji-sjis").uncheck();
  await page.getByTestId("gaiji-run").click();
  await expect.poll(() => groupCategories(page)).toEqual(["private-use", "invisible"]);
});

test("gaiji-checker: 整えたテキストは、置き換えられる文字だけ直し、外字は残す。コピーもできる", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTool(page);
  await pasteAndRun(page, "a​b が ﾊﾞﾅﾅ ①㈱ 髙");
  const out = page.getByTestId("gaiji-clean-output");
  await expect(out).toHaveValue("ab が バナナ 1(株) 髙");
  await expect(page.getByTestId("gaiji-clean-summary")).toContainText("置き換えられず残った問題の文字：2種類");

  // 操作をオフにすると、その文字は直さない
  await page.getByTestId("gaiji-clean-removeInvisible").uncheck();
  await expect(out).toHaveValue("a​b が バナナ 1(株) 髙");
  await page.getByTestId("gaiji-clean-removeInvisible").check();

  await page.getByTestId("gaiji-copy").click();
  await expect(page.getByText("コピーしました")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("ab が バナナ 1(株) 髙");
});

test("gaiji-checker: UTF-8のテキスト・CSVを選ぶと、先頭のBOMは問題にせず、本文の文字を調べる", async ({ page }) => {
  await openTool(page);
  const dir = tmpDir();
  const file = path.join(dir, "名簿.csv");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("氏名,所属\n山田,営業\n﨑田,総務​\n", "utf8")]));
  await uploadWhenReady(page, file, page.getByTestId("gaiji-summary"), { readyTimeoutMs: 30_000 });
  await expect(page.getByTestId("gaiji-summary")).toContainText("名簿.csv");
  const cats = await groupCategories(page);
  expect(cats).toEqual(expect.arrayContaining(["compat-ideograph", "invisible"]));
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+FEFF"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+FA11"]')).toContainText("3行目（1文字目）");
  // テキスト欄にも、読み込んだ内容が入る（整えたテキストが使える）
  await expect(page.getByTestId("gaiji-text")).toHaveValue(/氏名,所属/);
});

test("gaiji-checker: Shift_JISのテキストは、そのことを知らせて読み、機種依存文字を見つける", async ({ page }) => {
  await openTool(page);
  const dir = tmpDir();
  const file = path.join(dir, "sjis.txt");
  // 「あ」「髙」「①」をShift_JIS（Windows系）で保存したバイト列
  fs.writeFileSync(file, Buffer.from([0x82, 0xa0, 0xfb, 0xfc, 0x87, 0x40, 0x0a]));
  await uploadWhenReady(page, file, page.getByTestId("gaiji-summary"), { readyTimeoutMs: 30_000 });
  await expect(page.getByTestId("tool-preview")).toContainText("Shift_JISとして読み込みました");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+9AD9"]')).toBeVisible();
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+2460"]')).toBeVisible();
});

test("gaiji-checker: Wordを選ぶと、本文・表の中の文字を、段落ごとの場所つきで調べる", async ({ page }) => {
  await openTool(page);
  const dir = tmpDir();
  const file = path.join(dir, "文書.docx");
  fs.writeFileSync(
    file,
    buildMinimalDocx({
      blocks: [
        { kind: "paragraph", runs: [{ text: "通常の段落です。" }] },
        { kind: "paragraph", runs: [{ text: "外字を含む段落" }] },
        { kind: "table", rows: [["氏名", "髙橋"]] },
      ],
    })
  );
  await uploadWhenReady(page, file, page.getByTestId("gaiji-summary"), { readyTimeoutMs: 30_000 });
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+E010"]')).toContainText("本文の段落2（3文字目）");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+9AD9"]')).toBeVisible();
  // 整えたテキスト欄は、ファイルが文字だけでないときは出さない
  await expect(page.getByTestId("gaiji-clean")).toHaveCount(0);
  await expect(page.getByTestId("tool-preview")).toContainText("箇条書きの記号");
});

test("gaiji-checker: Excelを選ぶと、文字のセルを、シート名・セル番地つきで調べる", async ({ page }) => {
  await openTool(page);
  const dir = tmpDir();
  const file = path.join(dir, "名簿.xlsx");
  fs.writeFileSync(
    file,
    buildMinimalXlsx([
      { name: "社員", rows: [[{ value: "氏名" }, { value: "備考" }], [{ value: "山田" }, { value: "㈱サンプル" }], [{ value: 123 }, { value: "ｱｲｳ" }]] },
      { name: "メモ", rows: [[{ value: "特記 事項" }]] },
    ])
  );
  await uploadWhenReady(page, file, page.getByTestId("gaiji-summary"), { readyTimeoutMs: 30_000 });
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+3231"]')).toContainText("「社員」のB2");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+FF71"]')).toContainText("「社員」のB3");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+00A0"]')).toContainText("「メモ」のA1");
});

test("gaiji-checker: PDFを選ぶと、ページごとの場所つきで調べる。文字情報のないPDFは、その旨を知らせる", async ({ page }) => {
  await openTool(page);
  const dir = tmpDir();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(process.cwd(), "public/fonts/NotoSansJP-Regular.ttf")), { subset: true });
  doc.addPage([300, 200]).drawText("山田 太郎", { x: 20, y: 150, size: 14, font, color: rgb(0, 0, 0) });
  doc.addPage([300, 200]).drawText("髙橋 ①", { x: 20, y: 150, size: 14, font, color: rgb(0, 0, 0) });
  const file = path.join(dir, "書類.pdf");
  fs.writeFileSync(file, await doc.save());
  await uploadWhenReady(page, file, page.getByTestId("gaiji-summary"), { readyTimeoutMs: 30_000 });
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+9AD9"]')).toContainText("2ページ（1文字目）");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+2460"]')).toContainText("2ページ");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+5C71"]')).toHaveCount(0); // 「山」は問題なし

  // 文字のないPDF（白紙）
  const blank = await PDFDocument.create();
  blank.addPage([200, 200]);
  const blankFile = path.join(dir, "白紙.pdf");
  fs.writeFileSync(blankFile, await blank.save());
  await uploadWhenReady(page, blankFile, page.getByTestId("tool-preview").getByText("文字の情報がありません"), { readyTimeoutMs: 30_000 });
});

test("gaiji-checker: 古い形式（.doc）と対応外の形式は、理由を知らせる", async ({ page }) => {
  await openTool(page);
  const dir = tmpDir();
  const doc = path.join(dir, "古い.doc");
  fs.writeFileSync(doc, "dummy");
  await uploadWhenReady(page, doc, page.getByText("古い形式（.doc・.xls）は、読み込めません"), { readyTimeoutMs: 30_000 });
});

test("gaiji-checker: 結果をCSVでダウンロードでき、元の文章は含まれない。文字は外部に送信されない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  await pasteAndRun(page, `${MARKER}\n髙橋​\n外字`);
  const download = await clickAndDownload(page, "結果をCSVでダウンロード");
  expect(download.suggestedFilename()).toBe("外字・特殊文字チェック結果.csv");
  const { path: p } = await assertDownloadedFile(download, { minBytes: 50 });
  const buf = fs.readFileSync(p);
  expect(buf.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); // BOM付きUTF-8
  const csv = buf.toString("utf8");
  expect(csv).toContain("重要度,分類,文字,コード,名前,件数,場所の例,対処");
  expect(csv).toContain("U+E002");
  expect(csv).toContain("U+9AD9");
  expect(csv).toContain("U+200B");
  expect(csv).not.toContain(MARKER);

  expect(findLeakedRequests(recorder, MARKER)).toEqual([]);
  expect(findLeakedRequests(recorder, encodeURIComponent(MARKER))).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("gaiji-checker: 空のままでは「調べる」を押せない", async ({ page }) => {
  await openTool(page);
  await expect(page.getByTestId("gaiji-run")).toBeDisabled();
});
