import { test as plainTest, expect as plainExpect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";
import { clearDevOverrides, setDevAdOutcome } from "../helpers/dev-plan";
import { PDF_FIX_TOOL_PATH } from "@/lib/tools/pdf-fix-modes";

/**
 * 工程25：PDF記入・注釈で、保存していない編集があるときだけ、ブラウザを閉じる・再読み込みする直前に
 * ブラウザ標準の確認（beforeunload）を出す。
 *
 * 確認の方法は2つ。
 *  1. wouldWarn(): ページ上で beforeunload を発火させ、確認を要求する（preventDefault された）かを見る。
 *     ページを閉じずに何度でも確認できるので、状態の移り変わり（編集→保存→再編集…）の検証に使う。
 *  2. page.close({ runBeforeUnload: true }) と dialog イベント: 実際にブラウザの確認ダイアログが出るかを見る。
 *
 * 「保存した」と扱うのは、ダウンロードの保存処理が実際に実行された時点。ブラウザがファイルを書き終えたか
 * （OSへの保存完了）はアプリから検出できないので、ここでも検証していない。
 */

const CANVAS = '[data-testid="pdf-annotate-canvas"]';
const OBJECT_LIST = '[data-testid="pdf-annotate-object-list"]';

test.use({ viewport: { width: 1280, height: 1400 } });

async function openToolWithPdf(page: Page) {
  await page.goto("/tools/pdf-fill-annotate");
  await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS));
}

async function addText(page: Page, x: number, y: number) {
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await page.locator(CANVAS).click({ position: { x, y } });
}

/** ページを閉じずに、いま離脱確認が出る状態か（beforeunload が確認を要求するか）を調べる */
async function wouldWarn(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function exportPdf(page: Page) {
  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await waitForSuccess(page, "書き出しが完了しました");
}

async function exportAndDownload(page: Page) {
  await exportPdf(page);
  const download = await clickAndDownload(page, "PDFをダウンロード");
  await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
}

test.describe("PDF記入・注釈: 未保存の編集を離れるときの確認（工程25）", () => {
  test("PDFを開いただけ（未編集）では、離脱確認を要求しない。実際にページを閉じても確認は出ない", async ({ page }) => {
    await openToolWithPdf(page);
    expect(await wouldWarn(page)).toBe(false);

    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    // 確認なしで、ページが閉じる（閉じる処理は非同期なので、閉じ終わるまで待つ）
    await expect.poll(() => page.isClosed()).toBe(true);
    expect(dialogs).toEqual([]);
  });

  test("編集すると離脱確認を要求する。実際にページを閉じようとすると、ブラウザの確認ダイアログが出て、キャンセルすればページに残れる", async ({
    page,
  }) => {
    await openToolWithPdf(page);
    await addText(page, 60, 80);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    expect(await wouldWarn(page)).toBe(true);

    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => dialogs).toEqual(["beforeunload"]);
    // 「キャンセル」したので、ページは閉じておらず、編集もそのまま
    expect(page.isClosed()).toBe(false);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });

  test("ダウンロードして保存したあと、再編集していなければ確認を要求しない。保存後に再編集すると要求し、元に戻して保存時点と同じになれば要求しなくなる", async ({
    page,
  }) => {
    await openToolWithPdf(page);
    await addText(page, 60, 80);
    await page.locator(OBJECT_LIST).locator("textarea").first().fill("保存する文字");
    expect(await wouldWarn(page)).toBe(true);

    // 書き出しただけ（まだダウンロードしていない）では、保存済みにならない
    await exportPdf(page);
    expect(await wouldWarn(page)).toBe(true);

    // ダウンロードの保存処理が実行されたら、保存済み
    const download = await clickAndDownload(page, "PDFをダウンロード");
    await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
    await expect.poll(() => wouldWarn(page)).toBe(false);

    // 保存後の再編集は、また未保存
    await addText(page, 60, 200);
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();
    expect(await wouldWarn(page)).toBe(true);

    // 元に戻して、保存したときと同じ内容になれば、保存済みに戻る
    await page.getByRole("button", { name: "元に戻す" }).click();
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    expect(await wouldWarn(page)).toBe(false);

    // 保存後に、すでにある文字を書き換えるのも再編集
    await page.locator(OBJECT_LIST).locator("textarea").first().fill("保存したあとに書き換えた文字");
    expect(await wouldWarn(page)).toBe(true);
  });

  test("書き出し後に編集を加えて、古い書き出し結果をダウンロードしても、新しい編集は保存済みにならない", async ({ page }) => {
    await openToolWithPdf(page);
    await addText(page, 60, 80);
    await exportPdf(page);

    // 書き出したあとに編集を足す（画面には古い書き出し結果が残っている）
    await addText(page, 60, 200);
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

    const download = await clickAndDownload(page, "PDFをダウンロード");
    await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
    // 保存できたのは1件目までの内容。画面の2件の状態は未保存のまま
    expect(await wouldWarn(page)).toBe(true);
  });

  test("保存の処理が失敗したときは、未保存のまま", async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        // ダウンロード用のリンクのクリックだけを失敗させる（保存の処理が途中で失敗した状況）
        if (this.download) throw new Error("テスト用: 保存に失敗");
        return original.call(this);
      };
    });
    await openToolWithPdf(page);
    await addText(page, 60, 80);
    await exportPdf(page);

    await page.getByRole("button", { name: "PDFをダウンロード" }).click();
    // 保存に失敗したので、編集は未保存のまま
    expect(await wouldWarn(page)).toBe(true);
  });

  test("別のPDFを選び直して編集を破棄（確認のうえ）すると、確認は要求されなくなる", async ({ page }) => {
    await openToolWithPdf(page);
    await addText(page, 60, 80);
    expect(await wouldWarn(page)).toBe(true);

    await page.locator('input[type="file"]').first().setInputFiles(fixtures.singlePagePdf);
    await page.getByTestId("pdf-annotate-replace-ok").click();
    await expect(page.getByText("配置した注釈（1件）")).toHaveCount(0);
    expect(await wouldWarn(page)).toBe(false);
  });
});

test.describe("PDF修正: 記入・注釈の機能にも同じ離脱確認が働く（工程25）", () => {
  const modeButton = (page: Page, mode: string) => page.getByTestId(`pdf-fix-mode-${mode}`);

  async function openFixWithPdf(page: Page) {
    await page.goto(PDF_FIX_TOOL_PATH);
    await expect(page.getByTestId("pdf-fix-modes")).toBeVisible({ timeout: 25_000 });
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS), { readyTimeoutMs: 25_000 });
  }

  test("未編集では要求せず、編集すると要求し、保存すると要求しなくなる", async ({ page }) => {
    await openFixWithPdf(page);
    expect(await wouldWarn(page)).toBe(false);
    await addText(page, 60, 80);
    expect(await wouldWarn(page)).toBe(true);
    await exportAndDownload(page);
    await expect.poll(() => wouldWarn(page)).toBe(false);
  });

  test("編集を破棄して別の機能へ切り替えると、確認の登録も外れる（既存の切り替え確認は、そのまま働く）", async ({ page }) => {
    await openFixWithPdf(page);
    await addText(page, 60, 80);
    expect(await wouldWarn(page)).toBe(true);

    await modeButton(page, "page-numbers").click();
    await expect(page.getByTestId("pdf-fix-switch-confirm")).toBeVisible();
    // 「編集を続ける」なら、編集も離脱確認もそのまま
    await page.getByTestId("pdf-fix-switch-cancel").click();
    await expect(modeButton(page, "annotate")).toHaveAttribute("aria-pressed", "true");
    expect(await wouldWarn(page)).toBe(true);

    await modeButton(page, "page-numbers").click();
    await page.getByTestId("pdf-fix-switch-confirm-ok").click();
    await expect(modeButton(page, "page-numbers")).toHaveAttribute("aria-pressed", "true");
    expect(await wouldWarn(page)).toBe(false);
  });
});

plainTest.describe("PDF記入・注釈: Freeプランの広告確認と保存状態（工程25）", () => {
  plainTest.use({ viewport: { width: 1280, height: 1400 } });
  plainTest.beforeEach(async ({ context }) => {
    await clearDevOverrides(context);
  });

  plainTest("広告の確認画面を出しただけ・取りやめたときは、未保存のまま", async ({ page }) => {
    const dialog = page.getByTestId("download-gate-dialog");
    await page.goto("/tools/pdf-fill-annotate");
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS));
    await addText(page, 60, 80);
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    await waitForSuccess(page, "書き出しが完了しました");

    await page.getByRole("button", { name: "PDFをダウンロード" }).click();
    await plainExpect(dialog).toHaveAttribute("data-phase", "prompt");
    // 確認画面が出ているだけで、まだ保存していない
    plainExpect(await wouldWarn(page)).toBe(true);
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await plainExpect(dialog).toHaveCount(0);
    plainExpect(await wouldWarn(page)).toBe(true);
  });

  plainTest("広告の確認を済ませて、保存の処理が実行されたら、保存済みになる", async ({ page, context, baseURL }) => {
    const dialog = page.getByTestId("download-gate-dialog");
    await setDevAdOutcome(context, "granted", baseURL!);
    await page.goto("/tools/pdf-fill-annotate");
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS));
    await addText(page, 60, 80);
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    await waitForSuccess(page, "書き出しが完了しました");

    await page.getByRole("button", { name: "PDFをダウンロード" }).click();
    await dialog.getByRole("button", { name: "広告を見てダウンロード" }).click();
    await plainExpect(dialog).toHaveAttribute("data-phase", "unlocked", { timeout: 15_000 });
    // 広告を見終わっても、保存の処理はまだ。ユーザー自身の「ダウンロードする」で実行される
    plainExpect(await wouldWarn(page)).toBe(true);

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: /ダウンロードする/ }).click();
    await assertDownloadedFile(await downloadPromise, { format: "pdf", minBytes: 10 });
    await plainExpect.poll(() => wouldWarn(page)).toBe(false);
  });
});
