import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 「準備中」から公開した5ツールの動作検証。
 * 表示だけでなく、計算結果・生成されたファイルの中身まで確認する。
 */

test.describe("単位変換", () => {
  test("長さ・温度・面積(坪)が正しく換算され、換算表も出る", async ({ page }) => {
    await page.goto("/tools/unit-converter");
    const input = page.getByLabel("変換する値");
    await input.fill("1");
    await page.getByLabel("変換元の単位").selectOption("m");
    await page.getByLabel("変換先の単位").selectOption("ft");
    await expect(page.getByTestId("unit-result")).toHaveText("3.280839895");

    await page.getByRole("tab", { name: "温度" }).click();
    await page.getByLabel("変換する値").fill("100");
    await page.getByLabel("変換元の単位").selectOption("c");
    await page.getByLabel("変換先の単位").selectOption("f");
    await expect(page.getByTestId("unit-result")).toHaveText("212");

    await page.getByRole("tab", { name: "面積" }).click();
    await page.getByLabel("変換する値").fill("1");
    await page.getByLabel("変換元の単位").selectOption("tsubo");
    await page.getByLabel("変換先の単位").selectOption("m2");
    await expect(page.getByTestId("unit-result")).toHaveText("3.305785124");
    // 全単位の換算表
    await expect(page.getByRole("row").filter({ hasText: "畳" })).toBeVisible();
  });

  test("数値でない入力にはエラーを出す", async ({ page }) => {
    await page.goto("/tools/unit-converter");
    await page.getByLabel("変換する値").fill("abc");
    await expect(page.locator('p[role="alert"]')).toContainText("数値");
  });
});

test.describe("グラデーション生成", () => {
  test("色を変えるとプレビューとCSSが変わり、PNGで保存できる", async ({ page }) => {
    await page.goto("/tools/gradient-generator");
    const css = page.getByTestId("gradient-css");
    await expect(css).toContainText("linear-gradient(90deg, #6366f1 0%, #ec4899 100%)");

    await page.getByLabel("色1のカラーコード").fill("#112233");
    await expect(css).toContainText("#112233 0%");

    await page.getByRole("button", { name: "円形(放射)" }).click();
    await expect(css).toContainText("radial-gradient");
    await page.getByRole("button", { name: "色を追加" }).click();
    await expect(page.getByLabel("色3の位置")).toBeVisible();

    const download = await clickAndDownload(page, "PNG画像として保存");
    await assertDownloadedFile(download, { format: "png", minBytes: 100 });
  });
});

test.describe("参考文献リスト整形", () => {
  test("書籍を入力すると形式ごとに整形され、論文はAPAで斜体になる", async ({ page }) => {
    await page.goto("/tools/citation-formatter");
    await page.getByLabel("文献1の著者").fill("山田太郎、佐藤花子");
    await page.getByLabel("文献1の発行年").fill("2020");
    await page.getByLabel("文献1の題名").fill("データ分析入門");
    await page.getByLabel("文献1の出版社").fill("技術評論社");
    const list = page.getByTestId("citation-result-list");
    await expect(list).toContainText("[1] 山田太郎, 佐藤花子. データ分析入門. 技術評論社, 2020.");

    await page.getByLabel("書き方").selectOption("apa");
    await expect(list).toContainText("(2020).");

    await page.getByRole("button", { name: "文献を追加" }).click();
    await page.getByRole("group", { name: "文献2の種類" }).getByRole("button", { name: "論文・記事" }).click();
    await page.getByLabel("文献2の著者").fill("John Smith");
    await page.getByLabel("文献2の発行年").fill("2019");
    await page.getByLabel("文献2の題名").fill("Deep learning");
    await page.getByLabel("文献2の雑誌名").fill("Journal of AI");
    await page.getByLabel("文献2の巻").fill("12");
    await page.getByLabel("文献2の号").fill("3");
    await page.getByLabel("文献2のページ").fill("45-67");
    await expect(list).toContainText("Smith, J. (2019). Deep learning. Journal of AI, 12(3), 45-67.");
    await expect(list.locator("i").first()).toBeVisible();

    await page.getByLabel("書き方").selectOption("ieee");
    await expect(list).toContainText("J. Smith, “Deep learning,” Journal of AI, vol. 12, no. 3, pp. 45-67, 2019.");

    const download = await clickAndDownload(page, ".txtで保存");
    expect(download.suggestedFilename()).toBe("references.txt");
  });
});

test.describe("議事録テンプレート生成", () => {
  test("入力がプレビューに反映され、Markdownに切り替えられる", async ({ page }) => {
    await page.goto("/tools/meeting-notes-template");
    await page.getByLabel("会議名").fill("週次営業会議");
    await page.getByLabel("日付").fill("2026-10-06");
    await page.getByLabel("出席者").fill("山田、佐藤");
    await page.getByRole("textbox", { name: "議題" }).fill("前回の振り返り\n今月の目標");
    const preview = page.getByTestId("meeting-preview");
    await expect(preview).toContainText("■ 週次営業会議 議事録");
    await expect(preview).toContainText("2026年10月6日(火)");
    await expect(preview).toContainText("出席者: 山田、佐藤");
    await expect(preview).toContainText("1. 前回の振り返り");
    await expect(preview).toContainText("【ToDo(担当・期限)】");

    await page.getByRole("button", { name: "Markdown" }).click();
    await expect(preview).toContainText("# 週次営業会議 議事録");
    await expect(preview).toContainText("| 内容 | 担当 | 期限 | 状況 |");

    await page.getByLabel("ToDo欄の行数").fill("0");
    await page.getByRole("checkbox", { name: "決定事項" }).uncheck();
    await expect(preview).not.toContainText("## 決定事項");

    // ヘッドレスChromiumは日本語のファイル名を suggestedFilename で返せないことがあるため、中身で確認する
    const download = await clickAndDownload(page, "ファイルで保存");
    const { path } = await assertDownloadedFile(download, { minBytes: 50 });
    const text = (await import("node:fs")).readFileSync(path, "utf-8");
    expect(text.startsWith("# 週次営業会議 議事録")).toBe(true);
    expect(text).not.toContain("## 決定事項");
  });
});

test.describe("背景透過", () => {
  async function open(page: import("@playwright/test").Page) {
    await page.goto("/tools/background-remover");
    await uploadFixture(page, fixtures.png);
    await expect(page.getByTestId("bg-preview")).toBeVisible({ timeout: 20_000 });
  }

  async function pixelAlpha(page: import("@playwright/test").Page, fx: number, fy: number): Promise<number> {
    return page.getByTestId("bg-preview").evaluate(
      (el, [x, y]) => {
        const c = el as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
        return d[3];
      },
      [fx, fy]
    );
  }

  test("色指定: 四隅の色(青)が透明になり、白い四角は残る。PNGで保存できる", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /色を指定して消す/ }).click();
    await expect.poll(async () => await pixelAlpha(page, 0.02, 0.02), { timeout: 10_000 }).toBe(0);
    expect(await pixelAlpha(page, 0.5, 0.5)).toBe(255);

    await page.getByRole("button", { name: "背景を透明にする" }).click();
    await expect(page.getByRole("button", { name: /ダウンロード/ })).toBeVisible({ timeout: 30_000 });
    const download = await clickAndDownload(page, "ダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 50 });
    expect(download.suggestedFilename()).toMatch(/-nobg\.png$/);
    expect(path).toBeTruthy();
  });

  test("AI: モデルが動いて解析が終わり、PNGで保存できる", async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    // 解析中の表示が消える = マスクが得られた
    await expect(page.getByText("AIで背景を解析しています")).toBeHidden({ timeout: 90_000 });
    await expect(page.locator('p[role="alert"]')).toHaveCount(0);
    await page.getByRole("button", { name: "背景を透明にする" }).click();
    await expect(page.getByRole("button", { name: /ダウンロード/ })).toBeVisible({ timeout: 60_000 });
    const download = await clickAndDownload(page, "ダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 50 });
  });
});

test.describe("PDFパスワード保護", () => {
  test("先頭ページがプレビューされ、保護後はパスワードなしで開けず、パスワードありで開ける", async ({ page }) => {
    await page.goto("/tools/pdf-password-protect");
    await uploadFixture(page, fixtures.multiPagePdf);
    await expect(page.getByTestId("protect-preview")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => page.getByTestId("protect-preview").evaluate((el) => (el as HTMLCanvasElement).width), { timeout: 15_000 }).toBeGreaterThan(50);

    await page.getByLabel("開くためのパスワード").fill("open-me-123");
    await page.getByLabel("パスワード(確認用)").fill("different");
    await expect(page.getByRole("button", { name: "パスワードを設定する" })).toBeDisabled();
    await page.getByLabel("パスワード(確認用)").fill("open-me-123");
    await page.getByLabel("印刷", { exact: true }).uncheck();
    await page.getByRole("button", { name: "パスワードを設定する" }).click();

    await expect(page.getByText("パスワードなしでは開けないことを確認しました")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("protected-preview")).toBeVisible();
    const download = await clickAndDownload(page, /ダウンロード/);
    const { path } = await assertDownloadedFile(download, { format: "pdf", minBytes: 500 });
    const bytes = (await import("node:fs")).readFileSync(path);
    // 暗号化辞書があり、AES-256(V5/R6)であること
    const text = bytes.toString("latin1");
    expect(text).toContain("/Encrypt");
    expect(text).toContain("/AESV3");
  });
});
