import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
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
  PDF_HANDOFF_MAX_SIZE_MB,
  PDF_HANDOFF_TTL_MS,
  clearPdfHandoff,
  hasPendingPdfHandoff,
  offerPdfHandoff,
  pdfBlobToFile,
  takePdfHandoff,
  validateHandoffFile,
} from "@/lib/pdf/file-handoff";
import {
  WHITEOUT_COLOR,
  WHITEOUT_NOTICE,
  isWhiteoutObject,
  whiteoutInsertIndex,
} from "@/lib/pdf-annotate/whiteout";
import type { AnnotationObject, RectangleShapeObject } from "@/lib/pdf-annotate/types";
import sitemap from "@/app/sitemap";

/**
 * 工程12：PDF修正（統合ツール）と、PDF編集からのファイル引き継ぎのテスト。
 *  - 前半: ツール登録・一覧・関連リンク・sitemap・SEO・引き継ぎ部品（メモリ上の受け渡し）・白消し部品
 *  - 後半: 画面（機能の切り替え・白消しと書き直し・ページ番号・PDF編集の処理結果の引き継ぎ・再読み込み・送信/保存がないこと）
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

  plainTest("SEO文言：タイトル・説明・白消しの注意・引き継ぎの説明がある", () => {
    const seo = toolSeoContent[PDF_FIX_TOOL_ID];
    plainExpect(seo.metaTitle.startsWith("PDF修正")).toBe(true);
    const faqText = seo.faq.map((f) => `${f.question}${f.answer}`).join("\n");
    const answerText = seo.faq.map((f) => f.answer).join("\n");
    // 白消しは「完全に消える」とは書かない。元の文字が残る場合があることを明記する
    plainExpect(faqText).toContain("元の文字情報がファイル内に残る場合があり");
    plainExpect(faqText).toContain("機密情報を完全に削除する機能ではありません");
    plainExpect(answerText).not.toMatch(/完全に(消え|削除され)ます/);
    plainExpect(faqText).toContain("この結果をPDF修正で開く");
    plainExpect(faqText).toContain("元のファイルではありません");
    plainExpect(faqText).toContain("サーバーへの送信や保存はありません");
    plainExpect(seo.howTo.join("\n")).toContain("上限50MB");
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
// 2. 引き継ぎ部品（メモリ上の受け渡し）・白消し部品
// ---------------------------------------------------------------------------
function pdfFile(name = "result.pdf", bytes = 100): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

plainTest.describe("ファイル引き継ぎ部品（file-handoff）", () => {
  plainTest.beforeEach(() => clearPdfHandoff());
  plainTest.afterEach(() => clearPdfHandoff());

  plainTest("1回だけ受け取れ、受け取ると空になる（意図しない再利用がない）", () => {
    offerPdfHandoff(pdfFile("a.pdf"), "PDF編集", PDF_FIX_TOOL_ID);
    plainExpect(hasPendingPdfHandoff()).toBe(true);
    const first = takePdfHandoff(PDF_FIX_TOOL_ID);
    plainExpect(first?.file.name).toBe("a.pdf");
    plainExpect(first?.sourceLabel).toBe("PDF編集");
    plainExpect(hasPendingPdfHandoff()).toBe(false);
    plainExpect(takePdfHandoff(PDF_FIX_TOOL_ID)).toBeNull();
  });

  plainTest("宛先が違うツールは受け取れず、引き継ぎも消えない", () => {
    offerPdfHandoff(pdfFile(), "PDF編集", PDF_FIX_TOOL_ID);
    plainExpect(takePdfHandoff("pdf-compress")).toBeNull();
    plainExpect(hasPendingPdfHandoff()).toBe(true);
    plainExpect(takePdfHandoff(PDF_FIX_TOOL_ID)).not.toBeNull();
  });

  plainTest("期限切れの引き継ぎは破棄され、受け取れない", () => {
    offerPdfHandoff(pdfFile(), "PDF編集", PDF_FIX_TOOL_ID);
    plainExpect(takePdfHandoff(PDF_FIX_TOOL_ID, Date.now() + PDF_HANDOFF_TTL_MS + 1000)).toBeNull();
    plainExpect(hasPendingPdfHandoff()).toBe(false);
  });

  plainTest("新しい引き継ぎは古い引き継ぎを置き換える（取り違えない）", () => {
    offerPdfHandoff(pdfFile("old.pdf"), "PDF編集", PDF_FIX_TOOL_ID);
    offerPdfHandoff(pdfFile("new.pdf"), "PDF編集", PDF_FIX_TOOL_ID);
    plainExpect(takePdfHandoff(PDF_FIX_TOOL_ID)?.file.name).toBe("new.pdf");
    plainExpect(takePdfHandoff(PDF_FIX_TOOL_ID)).toBeNull();
  });

  plainTest("受け取り側の確認：PDF以外・空・上限超過は拒否し、通常のPDFは通す", () => {
    plainExpect(validateHandoffFile(pdfFile("ok.pdf"))).toBeNull();
    plainExpect(validateHandoffFile(new File([new Uint8Array(10)], "ok2.PDF", { type: "" }))).toBeNull();
    plainExpect(validateHandoffFile(new File([new Uint8Array(10)], "a.png", { type: "image/png" }))).toContain("PDFではありません");
    plainExpect(validateHandoffFile(pdfFile("empty.pdf", 0))).toContain("空");
    const big = { name: "big.pdf", type: "application/pdf", size: (PDF_HANDOFF_MAX_SIZE_MB + 1) * 1024 * 1024 } as File;
    plainExpect(validateHandoffFile(big)).toContain(`${PDF_HANDOFF_MAX_SIZE_MB}MB`);
  });

  plainTest("処理結果のBlobは、指定したファイル名のPDFファイルになる", async () => {
    const file = pdfBlobToFile(new Blob([new Uint8Array([1, 2, 3])]), "doc-rotated.pdf");
    plainExpect(file.name).toBe("doc-rotated.pdf");
    plainExpect(file.type).toBe("application/pdf");
    plainExpect(file.size).toBe(3);
  });

  plainTest("プライバシー：引き継ぎ部品は通信・永続保存・URLを使わない", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/lib/pdf/file-handoff.ts"), "utf-8");
    // コメント行を除いて確認する
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "fetch(", "XMLHttpRequest", "sendBeacon", "location", "console."]) {
      plainExpect(code, forbidden).not.toContain(forbidden);
    }
    const button = fs.readFileSync(path.join(process.cwd(), "src/components/tools/implementations/shared/open-in-pdf-fix-button.tsx"), "utf-8");
    plainExpect(button).toContain("router.push(PDF_FIX_TOOL_PATH)");
    // 遷移先のURLにファイル名・内容を付けない（クエリ・フラグメントなし）
    plainExpect(PDF_FIX_TOOL_PATH).not.toMatch(/[?#]/);
  });
});

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

/** PDF編集で、2ページのPDFを回転し、「PDF修正で開く」まで進める。回転済みの結果ファイル名（-rotated）を返す */
async function rotateInEditAndOpenInFix(page: Page, sourceName: string): Promise<void> {
  const src = workPath(sourceName);
  await writeSequentialPdf(src, 2);
  // 開発サーバーは操作画面の部品を初めて読み込むときに一瞬失敗することがあるため、先に1度開いて読み込んでおく
  await page.goto("/tools/pdf-rotate");
  await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-edit-modes")).toBeVisible({ timeout: 25_000 });
  await uploadWhenReady(page, src, page.getByRole("button", { name: "回転する" }), { readyTimeoutMs: 25_000 });
  await clickWhenReady(page.getByRole("button", { name: "回転する" }), { expectAfter: page.getByText("回転が完了しました") });
  const open = page.getByTestId("open-in-pdf-fix");
  await expect(open).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(/\/tools\/pdf-fix$/, { timeout: 25_000 });
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

test.describe("PDF修正: PDF編集の処理結果の引き継ぎ", () => {
  test("PDF編集の処理結果（元ファイルではない）がPDF修正に読み込まれ、そのまま修正できる", async ({ page }) => {
    await rotateInEditAndOpenInFix(page, "seq.pdf");

    // ファイル名と、PDF編集の処理結果であることが表示される
    const banner = page.getByTestId("pdf-fix-handoff-banner");
    await expect(banner).toBeVisible({ timeout: 25_000 });
    await expect(banner).toContainText("PDF編集の処理結果");
    await expect(banner).toContainText("元のファイルではなく");
    await expect(page.getByTestId("pdf-fix-handoff-filename")).toHaveText("seq-rotated.pdf");
    // 再アップロードなしで、すでにPDFが読み込まれている
    await expect(page.locator(CANVAS)).toBeVisible({ timeout: 25_000 });

    // ページ番号の機能に切り替えても、そのまま使える。出力は「回転済み」＝処理結果であることを確認する
    await modeButton(page, "page-numbers").click();
    await clickWhenReady(page.getByRole("button", { name: "ページ番号を追加する" }), { expectAfter: page.getByText("追加が完了しました") });
    const download = await clickAndDownload(page, /^ダウンロード$/);
    const saved = workPath("fixed.pdf");
    await download.saveAs(saved);
    // 元のPDFは回転なし。回転済みの処理結果を引き継いでいれば、全ページの/Rotateが90になる
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(saved), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) expect(p.getRotation().angle).toBe(90);
    // ダウンロード名は引き継ぎ後のファイル名をもとにする
    expect(download.suggestedFilename()).toContain("seq-rotated");
  });

  test("「別のファイルを選ぶ」で引き継いだPDFを外し、通常のファイル選択から始められる", async ({ page }) => {
    await rotateInEditAndOpenInFix(page, "seq2.pdf");
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toBeVisible({ timeout: 25_000 });
    await page.getByTestId("pdf-fix-choose-another").click();
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toHaveCount(0);
    await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible();
    await expect(page.locator(CANVAS)).toHaveCount(0);
  });

  test("再読み込みすると引き継ぎは残らず、空の状態から通常どおり始められる（永続保存なし）", async ({ page }) => {
    await rotateInEditAndOpenInFix(page, "seq3.pdf");
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toBeVisible({ timeout: 25_000 });
    await page.reload();
    await expect(page.getByTestId("pdf-fix-modes")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toHaveCount(0);
    await expect(page.getByTestId("pdf-fix-handoff-error")).toHaveCount(0);
    await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible();
    await expect(page.locator(CANVAS)).toHaveCount(0);
    // 通常のファイル選択は動く
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
  });

  test("引き継ぎは1回だけ：PDF編集へ戻ってからPDF修正を開き直しても、前のファイルは読み込まれない", async ({ page }) => {
    await rotateInEditAndOpenInFix(page, "seq4.pdf");
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toBeVisible({ timeout: 25_000 });
    await page.goBack();
    await expect(page.getByTestId("pdf-edit-modes")).toBeVisible({ timeout: 25_000 });
    // 画面内のリンクで開き直す（ページ全体の再読み込みなし）。回転の個別ページ → PDF編集 → PDF修正（関連ツール）の順に移動する
    await page.locator('main a[href="/tools/pdf-edit"]').first().click();
    await expect(page).toHaveURL(/\/tools\/pdf-edit$/, { timeout: 25_000 });
    await page.locator('main a[href="/tools/pdf-fix"]').first().click();
    await expect(page).toHaveURL(/\/tools\/pdf-fix$/, { timeout: 25_000 });
    await expect(page.getByTestId("pdf-fix-modes")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toHaveCount(0);
    await expect(page.locator(CANVAS)).toHaveCount(0);
  });

  test("プライバシー：引き継ぎ中にPDFが送信されず、ストレージ・Cookie・URLにも残らない", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    await rotateInEditAndOpenInFix(page, "private-name.pdf");
    await expect(page.getByTestId("pdf-fix-handoff-banner")).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(CANVAS)).toBeVisible({ timeout: 25_000 });

    const origin = new URL(baseURL!).origin;
    const apiLeaks = findSuspiciousApiUploads(recorder, origin, ["/api/stripe"]);
    const externalLeaks = findSuspiciousExternalUploads(recorder, origin);
    expect(apiLeaks, `自社APIへの不審なアップロード: ${JSON.stringify(apiLeaks)}`).toEqual([]);
    expect(externalLeaks, `外部への不審なアップロード: ${JSON.stringify(externalLeaks)}`).toEqual([]);

    // URLにファイル名・内容がない
    expect(new URL(page.url()).search).toBe("");
    expect(new URL(page.url()).hash).toBe("");
    // localStorage / sessionStorage / IndexedDB / Cookie にファイル名・内容が保存されていない
    const stored = await page.evaluate(async () => {
      const dump: Record<string, string> = {};
      for (const [name, store] of [["local", window.localStorage], ["session", window.sessionStorage]] as const) {
        try {
          dump[name] = JSON.stringify(Object.fromEntries(Object.entries(store)));
        } catch {
          dump[name] = "";
        }
      }
      dump.cookie = document.cookie;
      try {
        const dbs = (await indexedDB.databases?.()) ?? [];
        dump.idb = JSON.stringify(dbs.map((d) => d.name));
      } catch {
        dump.idb = "";
      }
      return dump;
    });
    for (const [where, value] of Object.entries(stored)) {
      expect(value, `${where}にファイル名が残っている`).not.toContain("private-name");
      expect(value, `${where}にPDFの内容が残っている`).not.toContain("%PDF");
    }
  });
});
