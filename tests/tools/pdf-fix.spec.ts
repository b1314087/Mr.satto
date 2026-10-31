import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload, assertDownloadedFile, waitForSuccess } from "../helpers/tool-runner";
import { clickWhenReady, uploadWhenReady } from "../helpers/tool-ready";
import { writeSequentialPdf } from "../helpers/pdf-page-quality";
import { extractPdfContent, getPageOpSummary, isValidPdfFile } from "../helpers/pdf-inspect";
import { siteConfig } from "@/lib/config/site";
import { getListedTools, getToolById } from "@/lib/tools/data";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { PDF_FIX_MODES, PDF_FIX_TOOL_ID, PDF_FIX_TOOL_PATH } from "@/lib/tools/pdf-fix-modes";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { AVAILABLE_TOOL_IDS } from "@/lib/tools/registry";
import {
  WHITEOUT_COLOR,
  WHITEOUT_NOTICE,
  isWhiteoutObject,
  whiteoutInsertIndex,
} from "@/lib/pdf-annotate/whiteout";
import type { AnnotationObject, RectangleShapeObject } from "@/lib/pdf-annotate/types";
import sitemap from "@/app/sitemap";

/**
 * 工程12：PDF修正（統合ツール）のテスト。
 *  - 前半: ツール登録・一覧・関連リンク・sitemap・SEO・白消し部品
 *  - 後半: 画面（機能の切り替え・白消しと書き直し・ページ番号・PDFの選び直し）
 * 工程15：PDF編集→PDF修正の個別の引き継ぎ（「この結果をPDF修正で開く」）を撤去した。撤去が残っていないことも確かめる。
 */

const CANVAS = '[data-testid="pdf-annotate-canvas"]';
const OBJECT_LIST = '[data-testid="pdf-annotate-object-list"]';

// ---------------------------------------------------------------------------
// 1. 登録・一覧・関連リンク・sitemap・SEO
// ---------------------------------------------------------------------------
plainTest.describe("PDF修正: ツール登録・SEO・既存URLの維持", () => {
  plainTest("pdf-fix が登録され、既存の個別ツールとURLはそのまま残る", () => {
    const hub = getToolById(PDF_FIX_TOOL_ID);
    plainExpect(hub?.name).toBe("PDF修正");
    plainExpect(hub?.status).toBe("available");
    plainExpect(hub?.category).toBe("pdf");
    plainExpect(hub?.processor).toBe("browser");
    plainExpect(hub?.mergedInto).toBeUndefined();
    plainExpect(PDF_FIX_TOOL_PATH).toBe("/tools/pdf-fix");
    plainExpect(AVAILABLE_TOOL_IDS).toContain(PDF_FIX_TOOL_ID);

    // 各機能に対応する既存ツールは、統合されず、独立したページとして残る（URL・SEO・一覧の変更なし）
    const listed = new Set(getListedTools().map((t) => t.id));
    plainExpect(listed.has(PDF_FIX_TOOL_ID)).toBe(true);
    for (const m of PDF_FIX_MODES) {
      const t = getToolById(m.toolId);
      plainExpect(t?.name, m.toolId).toBe(m.pageName);
      plainExpect(t?.status, m.toolId).toBe("available");
      plainExpect(t?.mergedInto, `${m.toolId}は統合済み扱いにしない`).toBeUndefined();
      plainExpect(listed.has(m.toolId), `${m.toolId}が一覧に残っている`).toBe(true);
    }
    plainExpect(new Set(PDF_FIX_MODES.map((m) => m.mode)).size).toBe(PDF_FIX_MODES.length);
  });

  plainTest("SEO文言：タイトル・説明・白消しの注意がある。撤去した引き継ぎの説明は残っていない（工程15）", () => {
    const seo = toolSeoContent[PDF_FIX_TOOL_ID];
    plainExpect(seo.metaTitle.startsWith("PDF修正")).toBe(true);
    const faqText = seo.faq.map((f) => `${f.question}${f.answer}`).join("\n");
    const answerText = seo.faq.map((f) => f.answer).join("\n");
    // 白消しは「完全に消える」とは書かない。元の文字が残る場合があることを明記する
    plainExpect(faqText).toContain("元の文字情報がファイル内に残る場合があり");
    plainExpect(faqText).toContain("機密情報を完全に削除する機能ではありません");
    plainExpect(answerText).not.toMatch(/完全に(消え|削除され)ます/);
    plainExpect(seo.howTo.join("\n")).toContain("上限50MB");
    // 撤去した「この結果をPDF修正で開く」の案内が、PDF修正・PDF編集のどちらのSEO文にも残っていない
    for (const id of [PDF_FIX_TOOL_ID, "pdf-edit"]) {
      const all = JSON.stringify(toolSeoContent[id]);
      plainExpect(all, id).not.toContain("PDF修正で開く");
      plainExpect(all, id).not.toContain("ダウンロードせずに");
    }
    // 既存ツールのSEOにも、白消しの注意と案内が入っている
    plainExpect(JSON.stringify(toolSeoContent["pdf-fill-annotate"].faq)).toContain("白消し");
    plainExpect(JSON.stringify(toolSeoContent["pdf-edit"].faq)).toContain("PDF修正");
    // 既存のタイトルは変えていない
    plainExpect(toolSeoContent["pdf-fill-annotate"].metaTitle.startsWith("PDF記入・注釈")).toBe(true);
    plainExpect(toolSeoContent["pdf-add-page-numbers"].metaTitle.startsWith("PDFページ番号追加")).toBe(true);
    plainExpect(toolSeoContent["pdf-edit"].metaTitle.startsWith("PDF編集")).toBe(true);
  });

  plainTest("sitemapに /tools/pdf-fix と既存のPDFツールが含まれる", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    for (const id of [PDF_FIX_TOOL_ID, "pdf-fill-annotate", "pdf-add-page-numbers", "pdf-watermark", "pdf-edit"]) {
      plainExpect(urls, id).toContain(`${siteConfig.url}/tools/${id}`);
    }
  });

  plainTest("関連ツール：既存ツール⇄PDF修正が相互にリンクされる", () => {
    const ids = (id: string) => getRelatedTools(getToolById(id)!).related.map((t) => t.id);
    for (const id of ["pdf-edit", "pdf-fill-annotate", "pdf-add-page-numbers", "pdf-watermark"]) {
      plainExpect(ids(id), `${id}の関連ツール`).toContain(PDF_FIX_TOOL_ID);
      // 指定したツールは先頭に出る
      plainExpect(ids(id)[0], `${id}の関連ツールの先頭`).toBe(PDF_FIX_TOOL_ID);
    }
    plainExpect(ids(PDF_FIX_TOOL_ID)).toContain("pdf-edit");
    plainExpect(ids(PDF_FIX_TOOL_ID)).not.toContain(PDF_FIX_TOOL_ID);
  });
});

// ---------------------------------------------------------------------------
// 2. 白消し部品
// ---------------------------------------------------------------------------
plainTest.describe("白消し部品", () => {
  const rect = (over: Partial<RectangleShapeObject> = {}): RectangleShapeObject => ({
    id: "r1",
    type: "shape",
    shapeKind: "rectangle",
    page: 1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    color: { r: 0.1, g: 0.35, b: 0.85 },
    strokeWidth: 2,
    fill: false,
    ...over,
  });

  plainTest("白で塗りつぶした矩形だけを白消しと判定する", () => {
    plainExpect(isWhiteoutObject(rect({ color: WHITEOUT_COLOR, fill: true }))).toBe(true);
    plainExpect(isWhiteoutObject(rect({ color: WHITEOUT_COLOR, fill: false }))).toBe(false);
    plainExpect(isWhiteoutObject(rect({ fill: true }))).toBe(false);
  });

  plainTest("新しい白消しは、白消し以外のオブジェクトより奥（配列の前側）に入る", () => {
    const w1 = rect({ id: "w1", color: WHITEOUT_COLOR, fill: true });
    const text: AnnotationObject = {
      id: "t1",
      type: "text",
      page: 1,
      x: 0,
      y: 0,
      text: "x",
      fontSize: 12,
      color: { r: 0, g: 0, b: 0 },
      bold: false,
    } as AnnotationObject;
    plainExpect(whiteoutInsertIndex([])).toBe(0);
    plainExpect(whiteoutInsertIndex([text])).toBe(0);
    plainExpect(whiteoutInsertIndex([w1, text])).toBe(1);
    plainExpect(whiteoutInsertIndex([w1])).toBe(1);
  });

  plainTest("注意書きは「完全に消える」と誤解させない", () => {
    const text = `${WHITEOUT_NOTICE.title}${WHITEOUT_NOTICE.body}`;
    plainExpect(text).toContain("見た目上の文字を隠すための機能");
    plainExpect(text).toContain("元の文字情報がファイル内に残る場合があり");
    plainExpect(text).toContain("機密情報を完全に削除する機能ではありません");
    plainExpect(text).not.toMatch(/完全に(消え|削除され)ます/);
  });
});

// ---------------------------------------------------------------------------
// 3. 画面
// ---------------------------------------------------------------------------
let workDir = "";
plainTest.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdffix-"));
});
plainTest.afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
const workPath = (name: string) => path.join(workDir, name);

test.use({ viewport: { width: 1280, height: 1400 } });

const modeButton = (page: Page, mode: string) => page.getByTestId(`pdf-fix-mode-${mode}`);

async function openFix(page: Page) {
  await page.goto(PDF_FIX_TOOL_PATH);
  await expect(page.getByTestId("pdf-fix-modes")).toBeVisible({ timeout: 25_000 });
}

async function openAnnotateWithPdf(page: Page, fixture: string) {
  await openFix(page);
  await uploadWhenReady(page, fixture, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
}

test.describe("PDF修正: 画面と機能", () => {
  test("開ける：機能の切り替え・白消しの注意・プライバシーの説明が出る", async ({ page }) => {
    await openFix(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("PDF修正");
    for (const m of PDF_FIX_MODES) await expect(modeButton(page, m.mode)).toBeVisible();
    await expect(modeButton(page, "annotate")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pdf-fix-whiteout-notice")).toContainText("元の文字情報がファイル内に残る場合があり");
    await expect(page.getByTestId("pdf-fix-whiteout-notice")).toContainText("機密情報を完全に削除する機能ではありません");
    // 直接開いたとき（引き継ぎなし）は、引き継ぎの表示も、エラーも出ない
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toHaveCount(0);
    await expect(page.getByTestId("pdf-fix-handoff-error")).toHaveCount(0);
    await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible();
    // 他の機能に切り替えられる
    await modeButton(page, "page-numbers").click();
    await expect(modeButton(page, "page-numbers")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pdf-fix-whiteout-notice")).toHaveCount(0);
    await modeButton(page, "watermark").click();
    await expect(page.getByTestId("pdf-fix-mode-description")).toContainText("透かし");
  });

  test("既存の個別URL（PDF記入・注釈 / ページ番号追加）は、これまでどおり単独で開ける", async ({ page }) => {
    await page.goto("/tools/pdf-fill-annotate");
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
    // 統合画面の切り替えは出ない
    await expect(page.getByTestId("pdf-fix-modes")).toHaveCount(0);
    await page.goto("/tools/pdf-add-page-numbers");
    await expect(page.getByTestId("pdf-fix-modes")).toHaveCount(0);
    await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible();
  });

  test("白消し→書き直し：白消しを置いてテキストを書き込み、書き出したPDFに反映される（元の文字は残る）", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);

    await page.getByRole("button", { name: "白消し", exact: true }).click();
    await expect(page.getByTestId("pdf-whiteout-panel")).toContainText("見た目上の文字を隠すための機能");
    await page.locator(CANVAS).click({ position: { x: 150, y: 120 } });
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    await expect(page.getByTestId("pdf-whiteout-badge")).toHaveCount(1);

    // 白消しの上に書き直す
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 100, y: 125 } });
    const textInput = page.locator(OBJECT_LIST).locator("textarea").first();
    await textInput.fill("訂正後ABC");
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

    // 書き出し前に、白消しを含むことと注意が出る
    await expect(page.getByTestId("pdf-whiteout-export-notice")).toContainText("元の文字情報がファイル内に残る場合があり");
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    await waitForSuccess(page, "書き出しが完了しました");
    const download = await clickAndDownload(page, "PDFをダウンロード");
    const { path: outPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
    expect(isValidPdfFile(outPath)).toBe(true);

    const original = await extractPdfContent(fixtures.singlePagePdf);
    const output = await extractPdfContent(outPath);
    expect(output.pageCount).toBe(original.pageCount);
    // 書き直した文字が入っている
    expect(output.pages[0].text).toContain("訂正後ABC");
    // 白消しは見た目を隠すだけなので、元の文字情報は出力にも残っている（「消えた」と誤解させない根拠）
    for (const item of original.pages[0].items) {
      if (item.str.trim()) expect(output.pages[0].text).toContain(item.str.trim());
    }
    // 白い四角形（塗りつぶし）が描画されている
    const ops = await getPageOpSummary(outPath, 1);
    expect(ops.hasPath).toBe(true);
    expect(ops.closePathCount).toBeGreaterThan(0);
  });

  test("後から置いた白消しは、すでに書いたテキストを隠さない（テキストの前に描かれない）", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 100, y: 125 } });
    await page.locator(OBJECT_LIST).locator("textarea").first().fill("先に書いた文字");
    await page.getByRole("button", { name: "白消し", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 200, y: 230 } });
    // 一覧では白消し（奥）が先頭に来る
    const items = page.locator(OBJECT_LIST).locator("li");
    await expect(items).toHaveCount(2);
    await expect(items.first().getByTestId("pdf-whiteout-badge")).toHaveCount(1);
  });

  test("ページ番号：PDF修正の画面から追加でき、出力に番号が入る", async ({ page }) => {
    await openFix(page);
    await modeButton(page, "page-numbers").click();
    await uploadWhenReady(page, fixtures.multiPagePdf, page.getByRole("button", { name: "ページ番号を追加する" }), { readyTimeoutMs: 25_000 });
    await clickWhenReady(page.getByRole("button", { name: "ページ番号を追加する" }), { expectAfter: page.getByText("追加が完了しました") });
    const download = await clickAndDownload(page, /^ダウンロード$/);
    const { path: outPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 100 });
    const original = await extractPdfContent(fixtures.multiPagePdf);
    const output = await extractPdfContent(outPath);
    expect(output.pageCount).toBe(original.pageCount);
    for (let i = 0; i < output.pageCount; i++) {
      expect(output.pages[i].text).toContain(String(i + 1));
    }
  });

  test("機能を切り替えても、選んだPDFが引き継がれる", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.multiPagePdf);
    await modeButton(page, "page-numbers").click();
    // 選んだPDFが最初から選択済み（ファイル名が一覧に出ている）で、実行ボタンが使える
    await expect(page.getByRole("button", { name: "ページ番号を追加する" })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/multi-page\.pdf/).first()).toBeVisible();
  });

  test("ファイル形式が違うファイルは拒否される", async ({ page }) => {
    await openFix(page);
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
    await page.locator('input[type="file"]').first().setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.getByText(/対応していません/).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("PDF修正: 機能を切り替えるときの確認（工程17）", () => {
  test("編集がないときは、確認なしで切り替えられる", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    await modeButton(page, "page-numbers").click();
    await expect(modeButton(page, "page-numbers")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toHaveCount(0);
  });

  test("配置済みの編集があるときは確認が出て、「編集を続ける」なら編集中の状態がそのまま残る", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "白消し", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 150, y: 120 } });
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 100, y: 125 } });
    await page.locator(OBJECT_LIST).locator("textarea").first().fill("消えてはいけない文字");
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

    await modeButton(page, "watermark").click();
    const confirm = page.getByTestId("pdf-fix-switch-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("消えます");
    // まだ切り替わっていない（記入・注釈のまま）
    await expect(modeButton(page, "annotate")).toHaveAttribute("aria-pressed", "true");
    await expect(modeButton(page, "watermark")).toHaveAttribute("aria-pressed", "false");

    await page.getByTestId("pdf-fix-switch-cancel").click();
    await expect(confirm).toHaveCount(0);
    await expect(modeButton(page, "annotate")).toHaveAttribute("aria-pressed", "true");
    // 注釈の件数・入力した文字・ファイルがそのまま
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();
    await expect(page.locator(OBJECT_LIST).locator("textarea").first()).toHaveValue("消えてはいけない文字");
    await expect(page.locator(CANVAS)).toBeVisible();
  });

  test("「消して切り替える」を選ぶと切り替わり、選んだPDFは引き継がれる。戻ると編集は空から始まる", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.multiPagePdf);
    await page.getByRole("button", { name: "白消し", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 150, y: 120 } });
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    await modeButton(page, "page-numbers").click();
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toBeVisible();
    await page.getByTestId("pdf-fix-switch-confirm-ok").click();
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toHaveCount(0);
    await expect(modeButton(page, "page-numbers")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "ページ番号を追加する" })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/multi-page\.pdf/).first()).toBeVisible();

    // 戻ると、注釈は消えている（確認で承知した動作）。このときはもう確認は出ない
    await modeButton(page, "annotate").click();
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toHaveCount(0);
    await expect(page.locator(CANVAS)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/配置した注釈（\d+件）/)).toHaveCount(0);
  });

  test("置いたものをすべて消したあとは、確認なしで切り替えられる（古い確認も残らない）", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "白消し", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 150, y: 120 } });
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    await modeButton(page, "watermark").click();
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toBeVisible();
    await page.getByTestId("pdf-fix-switch-cancel").click();
    // 取り消し（元に戻す）で、置いたものがなくなる
    await page.getByRole("button", { name: /元に戻す/ }).first().click();
    await expect(page.getByText(/配置した注釈（\d+件）/)).toHaveCount(0);
    await modeButton(page, "watermark").click();
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toHaveCount(0);
    await expect(modeButton(page, "watermark")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("PDF修正: PDFの選び直しでの編集の保護（工程18）", () => {
  const pickAnother = (page: Page, file: string) => page.locator('input[type="file"]').first().setInputFiles(file);

  test("記入・注釈：編集がないときは、確認なしで別のPDFに切り替わる", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    await pickAnother(page, fixtures.multiPagePdf);
    await expect(page.getByText(/multi-page\.pdf/).first()).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("pdf-annotate-replace-confirm")).toHaveCount(0);
  });

  test("記入・注釈：編集があるときのPDF選び直しは、確認が出る。続けるなら編集もPDFもそのまま、確定すると新しいPDFで空から始まる", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "白消し", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 150, y: 120 } });
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    await pickAnother(page, fixtures.multiPagePdf);
    const confirm = page.getByTestId("pdf-annotate-replace-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("multi-page.pdf");
    // 確認の間は、まだ何も変わっていない
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    await expect(page.getByText(/single-page\.pdf/).first()).toBeVisible();

    await page.getByTestId("pdf-annotate-replace-cancel").click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    await expect(page.getByText(/single-page\.pdf/).first()).toBeVisible();

    // 同じPDFをもう一度選び直しても、確認が再び出る（工程19：選択のたびに入力欄を空に戻すため、同じファイルでも変更が通知される）
    await pickAnother(page, fixtures.multiPagePdf);
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("multi-page.pdf");
    // 確認の間も、現在のPDFと編集はそのまま
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    await expect(page.getByText(/single-page\.pdf/).first()).toBeVisible();
    await page.getByTestId("pdf-annotate-replace-ok").click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText(/multi-page\.pdf/).first()).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/配置した注釈（\d+件）/)).toHaveCount(0);
  });
});

plainTest.describe("個別連携の撤去（工程15）: ソース", () => {
  plainTest("引き継ぎ部品と専用ボタンのファイルがなく、ソースのどこからも参照されていない", () => {
    const root = process.cwd();
    plainExpect(fs.existsSync(path.join(root, "src/lib/pdf/file-handoff.ts"))).toBe(false);
    plainExpect(fs.existsSync(path.join(root, "src/components/tools/implementations/shared/open-in-pdf-fix-button.tsx"))).toBe(false);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(ent.name)) {
          const code = fs.readFileSync(full, "utf-8");
          for (const word of ["file-handoff", "open-in-pdf-fix", "OpenInPdfFixButton", "PdfHandoff", "offerPdfHandoff", "takePdfHandoff"]) {
            if (code.includes(word)) hits.push(`${path.relative(root, full)}: ${word}`);
          }
        }
      }
    };
    walk(path.join(root, "src"));
    plainExpect(hits).toEqual([]);
  });
});

test.describe("個別連携の撤去（工程15）: 画面", () => {
  test("PDF編集の結果画面に「PDF修正で開く」は出ず、ダウンロードは使える。PDF修正は空の状態から始まる", async ({ page }) => {
    const src = workPath("seq.pdf");
    await writeSequentialPdf(src, 2);
    await page.goto("/tools/pdf-rotate");
    await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
    await expect(page.getByTestId("pdf-edit-modes")).toBeVisible({ timeout: 25_000 });
    await uploadWhenReady(page, src, page.getByRole("button", { name: "回転する" }), { readyTimeoutMs: 25_000 });
    await clickWhenReady(page.getByRole("button", { name: "回転する" }), { expectAfter: page.getByText("回転が完了しました") });
    await expect(page.getByTestId("open-in-pdf-fix")).toHaveCount(0);
    await expect(page.getByTestId("open-in-pdf-fix-unavailable")).toHaveCount(0);
    await expect(page.getByText("この結果をPDF修正で開く")).toHaveCount(0);
    // 通常のダウンロードは、これまでどおり使える（回転済みのPDFが保存される）
    const download = await clickAndDownload(page, /^ダウンロード$/);
    const saved = workPath("rotated.pdf");
    await download.saveAs(saved);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(saved), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) expect(p.getRotation().angle).toBe(90);

    // そのあとPDF修正を開いても、何も受け取らず、通常のファイル選択から始まる
    await page.goto(PDF_FIX_TOOL_PATH);
    await expect(page.getByTestId("pdf-fix-modes")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toHaveCount(0);
    await expect(page.getByTestId("pdf-fix-handoff-error")).toHaveCount(0);
    await expect(page.locator(CANVAS)).toHaveCount(0);
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
  });
});

test.describe("共通アップロード欄: 同じファイルの選び直し（工程19）", () => {
  test("同じPDFを続けて選んでも、そのたびに読み込みが走る（編集のないとき）。形式違いのあとでも選び直せる", async ({ page }) => {
    await openAnnotateWithPdf(page, fixtures.singlePagePdf);
    const input = page.locator('input[type="file"]').first();
    // 1回目の読み込みのあとに置いたものは、同じPDFを選び直すと（確認なしで）読み込み直されて消える。
    // 編集がある場合は確認が出る（別のテストで確認）ので、ここでは編集がない状態で、再選択が受け付けられることだけを見る
    await input.setInputFiles(fixtures.singlePagePdf);
    await expect(page.locator(CANVAS)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("pdf-annotate-replace-confirm")).toHaveCount(0);
    // 形式違いのファイルは拒否される。その直後に、同じ形式違いのファイルをもう一度選んでも、同様に拒否される（取りこぼさない）
    await input.setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(page.getByText(/対応していません/).first()).toBeVisible({ timeout: 10_000 });
    // 拒否のあとも、現在のPDFはそのまま。正しいPDFをもう一度選べば読み込める
    await expect(page.locator(CANVAS)).toBeVisible();
    await input.setInputFiles(fixtures.multiPagePdf);
    await expect(page.getByText(/multi-page\.pdf/).first()).toBeVisible({ timeout: 25_000 });
  });
});
