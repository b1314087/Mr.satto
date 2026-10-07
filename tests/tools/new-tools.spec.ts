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
