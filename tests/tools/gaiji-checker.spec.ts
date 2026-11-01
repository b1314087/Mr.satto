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
  // 入力の準備（hydration）が終わる前に入れた文字は、画面の状態に入らない。文字数の表示に反映されるまで待つ
  await expect(async () => {
    await page.getByTestId("gaiji-text").fill("x");
    await expect(page.locator("#gaiji-text-count")).toHaveText(/^1文字/, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByTestId("gaiji-text").fill("");
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
  // 結果の欄と「できること・できないこと」の両方で、保証ではないことを示す
  await expect(page.getByTestId("gaiji-summary").getByText(/保証ではありません/)).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "問題がないことの保証ではありません" })).toBeVisible();
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

test("gaiji-checker: 空のままでは「貼り付けた文字を調べる」を押せず、何をすればよいかを案内する", async ({ page }) => {
  await openTool(page);
  await expect(page.getByTestId("gaiji-run")).toBeDisabled();
  await expect(page.getByTestId("gaiji-run")).toHaveText("貼り付けた文字を調べる");
  await expect(page.getByTestId("gaiji-status")).toContainText("文字を貼り付けるか、ファイルを選んでください");
  // 検査前は、結果の欄を出さない
  await expect(page.getByTestId("tool-preview")).toHaveCount(0);
  // 使い方の枠は出さない（利用者の依頼で削除）。入力欄にはラベルが付いている
  await expect(page.getByTestId("gaiji-intro")).toHaveCount(0);
  await expect(page.getByLabel("方法1：文字を貼り付ける")).toBeVisible();
  await expect(page.getByText("方法2：ファイルを選ぶ")).toBeVisible();
  // 文字を入れると押せるようになり、押す前の案内に変わる
  await page.getByTestId("gaiji-text").fill("山田");
  await expect(page.getByTestId("gaiji-run")).toBeEnabled();
  await expect(page.getByTestId("gaiji-status")).toContainText("押すと、下に結果が出ます");
  await expect(page.getByTestId("gaiji-clear")).toBeEnabled();
});

// ---------------------------------------------------------------------------
// 工程19（使いやすさの改善）
// ---------------------------------------------------------------------------

test("gaiji-checker: 結果の数（種類・か所）と重要度ごとの内訳が、見つかった文字と一致する。結果の見出しへ移動する", async ({ page }) => {
  await openTool(page);
  // 外字1種類×2か所、ゼロ幅スペース1種類×1か所、①1種類×3か所
  await pasteAndRun(page, "\ue001あ\ue001\n\u200bい\n①①①");
  await expect(page.getByTestId("gaiji-found")).toContainText("3種類（合計6か所）");
  const counts = page.getByTestId("gaiji-severity-counts");
  await expect(counts.locator("li").nth(0)).toContainText("要確認");
  await expect(counts.locator("li").nth(0)).toContainText("1種類");
  await expect(counts.locator("li").nth(1)).toContainText("2種類");
  await expect(counts.locator("li").nth(2)).toContainText("0種類");
  await expect(page.locator('[data-category="private-use"]')).toContainText("1種類・2か所");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+2460"]')).toContainText("件数：3か所");
  // 結果が出たら、結果の見出しにフォーカスが移る（キーボード・読み上げの利用者にも結果が出たことが分かる）
  await expect(page.locator("#gaiji-step2")).toBeFocused();
});

test("gaiji-checker: 入力を変えると前の結果を消し、理由を知らせる。もう一度調べると新しい結果が出る", async ({ page }) => {
  await openTool(page);
  await pasteAndRun(page, "髙橋");
  await expect(page.getByTestId("gaiji-found")).toBeVisible();
  await page.getByTestId("gaiji-text").fill("山田");
  await expect(page.getByTestId("tool-preview")).toHaveCount(0);
  await expect(page.getByTestId("gaiji-status")).toContainText("前の結果を消しました");
  await page.getByTestId("gaiji-run").click();
  await expect(page.getByTestId("gaiji-none")).toContainText("調べ終わりました");
  await expect(page.getByTestId("gaiji-summary")).toContainText("貼り付けたテキスト（2文字）");
  // 「入力を消す」で、入力と結果の両方が消える
  await page.getByTestId("gaiji-clear").click();
  await expect(page.getByTestId("gaiji-text")).toHaveValue("");
  await expect(page.getByTestId("tool-preview")).toHaveCount(0);
  await expect(page.getByTestId("gaiji-run")).toBeDisabled();
});

test("gaiji-checker: 結果が出ているときにShift_JISの設定を変えると、ボタンを押さなくても同じ内容を調べ直す", async ({ page }) => {
  await openTool(page);
  await pasteAndRun(page, "髙橋①\u200b");
  expect(await groupCategories(page)).toEqual(expect.arrayContaining(["ext-dep", "invisible"]));
  await page.getByTestId("gaiji-sjis").uncheck();
  await expect.poll(() => groupCategories(page)).toEqual(["invisible"]);
  await expect(page.getByTestId("gaiji-status")).toContainText("調べ直しました");
  await expect(page.getByTestId("gaiji-summary")).toContainText("Shift_JISの問題は調べていません");
  await page.getByTestId("gaiji-sjis").check();
  await expect.poll(() => groupCategories(page)).toEqual(expect.arrayContaining(["ext-dep", "invisible"]));
  await expect(page.getByTestId("gaiji-summary")).toContainText("Shift_JISの問題も調べました");
});

test("gaiji-checker: 大量の文字・多くの種類でも表示が崩れない。種類が多い分類は50種類まで出し、すべて表示に広げられる。CSVにはすべて入る", async ({ page }) => {
  await openTool(page);
  // 外字300種類（それぞれ2か所）＋ 通常の文字約20万文字
  let pua = "";
  for (let i = 0; i < 300; i++) pua += String.fromCodePoint(0xe000 + i);
  const text = "山田太郎の名簿です。".repeat(20_000) + "\n" + pua + "\n" + pua;
  await page.evaluate((t) => {
    const el = document.querySelector('[data-testid="gaiji-text"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(el, t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.getByTestId("gaiji-run").click();
  await expect(page.getByTestId("gaiji-found")).toContainText("300種類（合計600か所）", { timeout: 30_000 });
  const group = page.locator('[data-category="private-use"]');
  await expect(group.getByTestId("gaiji-row")).toHaveCount(50);
  await expect(page.getByTestId("gaiji-group-toggle")).toHaveText("すべて表示する（残り250種類）");
  await page.getByTestId("gaiji-group-toggle").click();
  await expect(group.getByTestId("gaiji-row")).toHaveCount(300);
  await expect(page.getByTestId("gaiji-group-toggle")).toHaveAttribute("aria-expanded", "true");
  // 横にはみ出さない
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const download = await clickAndDownload(page, "結果をCSVでダウンロード");
  const { path: p } = await assertDownloadedFile(download, { minBytes: 50 });
  const lines = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  expect(lines.length).toBe(301); // 見出し＋300種類
});

test("gaiji-checker: 整えたテキストのコピーに失敗したときは、その場で手作業の方法を案内する。直せる文字がないときは、そのことを示す", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
  });
  await openTool(page);
  await pasteAndRun(page, "髙橋");
  await expect(page.getByTestId("gaiji-clean-unchanged")).toContainText("直せる文字はありませんでした");
  await page.getByTestId("gaiji-copy").click();
  await expect(page.getByTestId("gaiji-clean")).toContainText("コピーできませんでした");
  await expect(page.getByTestId("gaiji-copied")).toHaveCount(0);
});

test("gaiji-checker: コピーしたあとに直す内容を変えると、「コピーしました」の表示を消す", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTool(page);
  await pasteAndRun(page, "a\u200bb ①");
  await page.getByTestId("gaiji-copy").click();
  await expect(page.getByTestId("gaiji-copied")).toBeVisible();
  await page.getByTestId("gaiji-clean-replaceCompat").uncheck();
  await expect(page.getByTestId("gaiji-copied")).toHaveCount(0);
  await expect(page.getByTestId("gaiji-clean-output")).toHaveValue("ab ①");
});

test("gaiji-checker: キーボードだけで調べられ、ボタンにはフォーカスの枠が出る", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("gaiji-text").focus();
  await page.keyboard.type("髙橋");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("gaiji-run")).toBeFocused();
  const outline = await page.getByTestId("gaiji-run").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("gaiji-found")).toBeVisible();
  await expect(page.locator("#gaiji-step2")).toBeFocused();
});

test.describe("スマートフォンの幅", () => {
  test.use({ viewport: { width: 375, height: 740 } });
  test("gaiji-checker: 入力・調べる・結果の確認ができ、場所の例まで横にはみ出さずに読める", async ({ page }) => {
    await openTool(page);
    await pasteAndRun(page, "山田 太郎\n髙橋 花子\u200b\n佐藤\ue001次郎（㈱サンプル）");
    const row = page.locator('[data-testid="gaiji-row"][data-code="U+200B"]');
    await expect(row).toContainText("場所：2行目（6文字目）");
    const box = await row.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByTestId("gaiji-run")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 形の違う字（異体字）：「高橋」と打っても「髙橋」の字が出てくる
// ---------------------------------------------------------------------------

test("gaiji-checker: 高橋と入力すると、髙・槗が形の違う字として出る。Shift_JISでの扱いとコピー", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTool(page);
  await pasteAndRun(page, "高橋 太郎\n山田 花子\n高木");
  // 注意が必要な文字は無いが、形の違う字は出る
  await expect(page.getByTestId("gaiji-none")).toBeVisible();
  const section = page.getByTestId("gaiji-variants");
  // 高・橋・郎（郞）・花（芲）の4文字
  await expect(section).toContainText("4文字");
  const taka = page.locator('[data-testid="gaiji-variant-row"][data-char="高"]');
  await expect(taka).toContainText("U+9AD8");
  await expect(taka).toContainText("件数：2か所");
  await expect(taka).toContainText("1行目、3行目");
  const hashigo = taka.locator('[data-testid="gaiji-variant"][data-char="髙"]');
  await expect(hashigo).toContainText("U+9AD9");
  await expect(hashigo).toContainText("機種依存文字");
  await expect(page.locator('[data-testid="gaiji-variant-row"][data-char="橋"] [data-testid="gaiji-variant"][data-char="槗"]')).toContainText("Shift_JISにない");
  // 形違いの字が無い文字（山・田など）は出ない
  await expect(page.locator('[data-testid="gaiji-variant-row"][data-char="山"]')).toHaveCount(0);
  // コピー
  await hashigo.getByTestId("gaiji-variant-copy").click();
  await expect(hashigo.getByTestId("gaiji-variant-copy")).toHaveText("コピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("髙");
});

test("gaiji-checker: 髙橋と入力すると、髙は機種依存文字として見つかり、形違いの高も出る。辺は邊・邉が出る", async ({ page }) => {
  await openTool(page);
  await pasteAndRun(page, "髙橋\n渡辺");
  await expect(page.locator('[data-testid="gaiji-row"][data-code="U+9AD9"]')).toBeVisible();
  await expect(page.locator('[data-testid="gaiji-variant-row"][data-char="髙"] [data-testid="gaiji-variant"][data-char="高"]')).toContainText("Shift_JISで使える");
  const be = page.locator('[data-testid="gaiji-variant-row"][data-char="辺"]');
  await expect(be.locator('[data-testid="gaiji-variant"]')).toHaveCount(2);
  await expect(be).toContainText("邊");
  await expect(be).toContainText("邉");
});

test("gaiji-checker: 寝と入力すると、旧字体の寢が出る（新字体・旧字体の一覧から）", async ({ page }) => {
  await openTool(page);
  await pasteAndRun(page, "寝屋川");
  await expect(page.locator('[data-testid="gaiji-variant-row"][data-char="寝"] [data-testid="gaiji-variant"][data-char="寢"]')).toContainText("U+5BE2");
});

test("gaiji-checker: 形違いの字が無い文字だけなら、形の違う字の欄は出ない", async ({ page }) => {
  await openTool(page);
  await pasteAndRun(page, "山田 木子");
  await expect(page.getByTestId("gaiji-none")).toBeVisible();
  await expect(page.getByTestId("gaiji-variants")).toHaveCount(0);
});
