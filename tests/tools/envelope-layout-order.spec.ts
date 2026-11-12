import { test, expect } from "../fixtures/premium-test";

/**
 * 封筒宛名作成の画面の順番: ① 封筒（サイズ・向き）→ ② 宛先の入力（手入力・ファイル取り込み・敬称・差出人）
 * → ③ レイアウト（書字方向・文字の大きさ・位置・自由テキスト）→ 作成ボタン。
 * 上の説明文は1行（短い文）にする。
 */
test.describe("封筒宛名作成: 画面の順番", () => {
  test("封筒 → 宛先 → レイアウト → 作成ボタン の順に、上から並ぶ", async ({ page }) => {
    await page.goto("/tools/envelope-address");
    const size = page.getByTestId("envelope-step-size");
    const input = page.getByTestId("envelope-step-input");
    const layout = page.getByTestId("envelope-step-layout");
    const run = page.getByRole("button", { name: /PDFを作成|作成中/ });
    await expect(size).toBeVisible({ timeout: 40_000 });

    // 画面上の並び（HTMLの順）で確かめる。作成ボタンは、設定が長いときに画面の下にくっつく実行バー（RunBar）の中にあり、
    // 見えている位置（座標）はスクロールで変わるため、座標では比べない
    const handles = await Promise.all([size, input, layout, run].map((l) => l.elementHandle()));
    const order = await page.evaluate((els) => {
      const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return [follows(els[0]!, els[1]!), follows(els[1]!, els[2]!), follows(els[2]!, els[3]!)];
    }, handles);
    expect(order).toEqual([true, true, true]);

    // 各手順の中身が、正しい手順に入っている
    await expect(size.getByText("封筒サイズ", { exact: true })).toBeVisible();
    await expect(size.getByText("封筒の向き", { exact: true })).toBeVisible();
    await expect(input.getByLabel("宛先1")).toBeVisible();
    await expect(input.getByText("CSV/Excelをドラッグ&ドロップ")).toBeVisible(); // ドラッグ&ドロップも、宛先の入力の中
    await expect(input.getByText("敬称（宛先の最後の行）", { exact: true })).toBeVisible();
    await expect(input.getByText("差出人を印刷する")).toBeVisible();
    await expect(layout.getByText("書字方向", { exact: true })).toBeVisible();
    await expect(layout.getByText("文字の大きさ・位置", { exact: true })).toBeVisible();
    await expect(layout.getByText(/自由入力テキスト/)).toBeVisible();
  });

  test("上の説明文は1行（短い文）で、長い項目の列挙はない", async ({ page }) => {
    await page.goto("/tools/envelope-address");
    const lead = page.getByText("封筒の大きさを選び、宛先を入れて、宛名のPDFを作成します。", { exact: true });
    await expect(lead).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText("スライダーで調整できます", { exact: false })).toHaveCount(0);
  });
});
