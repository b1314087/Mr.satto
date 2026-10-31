import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { clearDevOverrides, setDevAdOutcome } from "../helpers/dev-plan";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { writeSequentialPdf } from "../helpers/pdf-page-quality";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { clickWhenReady, uploadWhenReady } from "../helpers/tool-ready";

/**
 * 工程16：ツール間のファイル受け渡しの画面テスト（代表ツールで確認する）。
 *  - 編集ツール → 別の編集ツール（PDF編集の回転 → PDF圧縮）
 *  - 生成ツール → 変換ツール（二次元コード作成 → 画像形式変換）。生成ツールは候補に出ない
 *  - 複数ページ → ZIP（PDF→画像）。ZIPは展開せず、ZIPを受け取るツールだけが候補
 *  - 受け渡し先がないツールでは何も出ない
 *  - 見つからない・再読み込み・広告の確認（無料プラン）
 * 判定・置き場・設定の整合は tests/handoff/handoff-logic.spec.ts。
 */

let workDir = "";
plainTest.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
});
plainTest.afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
const workPath = (name: string) => path.join(workDir, name);

test.use({ viewport: { width: 1280, height: 1400 } });

const openButton = (page: Page) => page.getByTestId("handoff-open");
const panel = (page: Page) => page.getByTestId("handoff-panel");
const targetButton = (page: Page, id: string) => page.getByTestId(`handoff-target-${id}`);
const targetIds = async (page: Page) => {
  await expect(panel(page)).toBeVisible({ timeout: 15_000 });
  return panel(page).locator('[data-testid^="handoff-target-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("handoff-target-", "")));
};

/** PDF編集（回転）で2ページのPDFを回転し、結果を出すところまで */
async function rotatePdf(page: Page, name: string) {
  const src = workPath(name);
  await writeSequentialPdf(src, 2);
  await page.goto("/tools/pdf-rotate");
  await expect(page.locator('input[type="file"]').first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("pdf-edit-modes")).toBeVisible({ timeout: 25_000 });
  await uploadWhenReady(page, src, page.getByRole("button", { name: "回転する" }), { readyTimeoutMs: 25_000 });
  await clickWhenReady(page.getByRole("button", { name: "回転する" }), { expectAfter: page.getByText("回転が完了しました") });
}

test.describe("ツール間の受け渡し：代表的な経路", () => {
  test("編集→編集：PDF編集（回転）の結果を、PDF圧縮へ受け渡して処理できる。生成ツールや画像ツールは候補に出ない", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    await rotatePdf(page, "handoff-private.pdf");

    await openButton(page).click();
    await expect(panel(page)).toBeVisible();
    const ids = await targetIds(page);
    expect(ids).toEqual(expect.arrayContaining(["pdf-fix", "pdf-compress", "pdf-to-image", "file-zip"]));
    for (const id of ["pdf-edit", "qr-generator", "quote-order-generator", "image-resize", "excel-csv-convert"]) expect(ids).not.toContain(id);

    // 候補を閉じても、元の結果はそのままダウンロードできる
    await page.getByTestId("handoff-close").click();
    const original = await clickAndDownload(page, /^ダウンロード$/);
    expect(original.suggestedFilename()).toContain("handoff-private");

    await openButton(page).click();
    await targetButton(page, "pdf-compress").click();
    await expect(page).toHaveURL(/\/tools\/pdf-compress$/, { timeout: 25_000 });
    // 受け取ったファイルの名前と、送り元のツール名が表示される。識別子はURLから消えている
    await expect(page.getByTestId("handoff-received")).toContainText("PDF編集", { timeout: 25_000 });
    await expect(page.getByTestId("handoff-received-names")).toHaveText("handoff-private-rotated.pdf");
    expect(new URL(page.url()).search).toBe("");

    // 受け取ったPDFで、そのまま処理できる（回転済みの結果であることを、出力で確かめる）
    await clickWhenReady(page.getByRole("button", { name: "圧縮する" }), { expectAfter: page.getByText("処理が完了しました") });
    const download = await clickAndDownload(page, /^ダウンロード$/);
    const saved = workPath("compressed.pdf");
    await download.saveAs(saved);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(fs.readFileSync(saved), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    for (const p of doc.getPages()) expect(p.getRotation().angle).toBe(90);

    // ファイルはサーバーへ送られず、ブラウザの保存領域にも残らない
    const origin = new URL(baseURL!).origin;
    expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
    const stored = await page.evaluate(() => JSON.stringify({ l: Object.entries(localStorage), s: Object.entries(sessionStorage), c: document.cookie }));
    expect(stored).not.toContain("handoff-private");
    expect(stored).not.toContain("%PDF");

    // 受け渡しは1回だけ：再読み込みしても、もう一度受け取ることはない
    await page.reload();
    await expect(page.getByText("PDFをドラッグ&ドロップ").first()).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("handoff-received")).toHaveCount(0);
  });

  test("生成→変換：二次元コード作成の画像を、画像形式変換へ受け渡せる。PDFのツールは候補に出ない", async ({ page }) => {
    await page.goto("/tools/qr-generator");
    await page.locator("textarea").first().fill("https://example.com/handoff");
    await expect(openButton(page)).toBeEnabled({ timeout: 25_000 });
    await openButton(page).click();
    const ids = await targetIds(page);
    expect(ids).toEqual(expect.arrayContaining(["image-resize", "image-format-convert", "image-to-pdf"]));
    for (const id of ["pdf-compress", "pdf-fix", "qr-generator", "fiscal-calendar"]) expect(ids).not.toContain(id);

    await targetButton(page, "image-format-convert").click();
    await expect(page).toHaveURL(/\/tools\/image-format-convert$/, { timeout: 25_000 });
    await expect(page.getByTestId("handoff-received-names")).toHaveText("qrcode.png", { timeout: 25_000 });
    await page.getByRole("button", { name: /件をJPGに変換する/ }).click();
    await waitForSuccess(page, "変換が完了しました");
    const download = await clickAndDownload(page, /^ダウンロード$/);
    expect(download.suggestedFilename()).toMatch(/\.jpg$/);
  });

  test("複数ページ→ZIP：PDF→画像のZIPは展開せず、ZIPを受け取るツールだけが候補になる", async ({ page }) => {
    await page.goto("/tools/pdf-to-image");
    await uploadFixture(page, fixtures.multiPagePdf);
    await page.getByRole("button", { name: "画像化する" }).click();
    await waitForSuccess(page, "完了");
    await openButton(page).click();
    expect((await targetIds(page)).sort()).toEqual(["file-hash", "file-unzip", "file-zip"]);
    await targetButton(page, "file-unzip").click();
    await expect(page).toHaveURL(/\/tools\/file-unzip$/, { timeout: 25_000 });
    await expect(page.getByTestId("handoff-received-names")).toHaveText(/-images\.zip$/, { timeout: 25_000 });
  });

  test("受け渡し先がないツール（設定なし）では、「ほかのツールで使う」を出さない。通常のリンクでの移動はできる", async ({ page }) => {
    await page.goto("/tools/csv-format");
    await page.locator("textarea").first().fill(fs.readFileSync(fixtures.csv, "utf8"));
    await page.getByRole("button", { name: "整形する" }).click();
    await waitForSuccess(page, "完了");
    await expect(page.getByRole("button", { name: "CSVとしてダウンロード" })).toBeVisible();
    await expect(openButton(page)).toHaveCount(0);
    // ツール間の通常の移動（関連ツールなどのリンク）は、これまでどおり
    await expect(page.locator('main a[href^="/tools/"]').first()).toBeVisible();
  });
});

test.describe("ツール間の受け渡し：失敗時の案内", () => {
  test("見つからない受け渡し（再読み込み・別タブ・古いURL）は、理由を案内し、通常のファイル選択から始められる", async ({ page }) => {
    await page.goto("/tools/pdf-compress?handoff=00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("handoff-error")).toContainText("見つかりませんでした", { timeout: 25_000 });
    await expect.poll(() => new URL(page.url()).search).toBe("");
    await uploadWhenReady(page, fixtures.singlePagePdf, page.getByRole("button", { name: "圧縮する" }), { readyTimeoutMs: 25_000 });

    // 形の不正な識別子も同じ
    await page.goto("/tools/pdf-compress?handoff=..%2F..%2Fetc");
    await expect(page.getByTestId("handoff-error")).toContainText("見つかりませんでした", { timeout: 25_000 });
  });

  test("受け取りの設定がないツールでは、受け取らずに案内する", async ({ page }) => {
    await page.goto("/tools/qr-generator?handoff=00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("handoff-error")).toContainText("ほかのツールからファイルを受け取れません", { timeout: 25_000 });
  });
});

plainTest.describe("ツール間の受け渡し：広告の確認（無料プラン）", () => {
  test("受け渡しも、ダウンロードと同じ広告の確認を通る。キャンセルすれば移動せず、広告の後に受け渡される", async ({ page, context, baseURL }) => {
    await clearDevOverrides(context);
    await setDevAdOutcome(context, "granted", baseURL!);
    await page.goto("/tools/image-resize");
    await uploadFixture(page, fixtures.png);
    await page.getByRole("button", { name: "リサイズする" }).click();
    await waitForSuccess(page, "完了");

    await page.getByTestId("handoff-open").click();
    await page.getByTestId("handoff-target-image-compress").click();
    const dialog = page.getByTestId("download-gate-dialog");
    await expect(dialog).toHaveAttribute("data-phase", "prompt");
    await expect(dialog).toContainText("画像圧縮で開く");

    // キャンセルすると、移動しない（受け渡しで広告の確認を回避できない）
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/tools/image-resize");

    // 広告の後、利用者のクリックで受け渡される
    await page.getByTestId("handoff-target-image-compress").click();
    await dialog.getByRole("button", { name: "広告を見てダウンロード" }).click();
    await expect(dialog).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    await dialog.getByRole("button", { name: /ダウンロードする/ }).click();
    await page.waitForURL(/\/tools\/image-compress$/, { timeout: 25_000 });
    await page.getByTestId("handoff-received").waitFor({ timeout: 25_000 });
  });
});
