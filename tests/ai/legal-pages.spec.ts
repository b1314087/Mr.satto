import { test, expect } from "@playwright/test";

/**
 * 利用規約・プライバシーポリシー・特定商取引法・料金ページが、実装した機能（Free / Premium 1,100円・AI読み取り補助）と一致していること。
 * 開発サーバーでは課金の機能スイッチがオンのため、課金・AIの記述が表示される。
 */
test.describe("法務ページ: 実装済みの機能と一致している", () => {
  test("利用規約: 現行プランはFree/Premium、AIの同意・利用枠・旧プランの扱いが書かれ、旧Standardを現行として案内しない", async ({ page }) => {
    await page.goto("/terms");
    const main = page.locator("main");
    const text = await main.innerText();
    expect(text).toContain("無料プランとプレミアムプランがあります");
    expect(text).toContain("月額1,100円（税込）");
    expect(text).toContain("第2条の2（AIによる読み取り補助）");
    expect(text).toContain("実行のたびに");
    expect(text).toContain("AIトークン");
    expect(text).toContain("自動では採用されません");
    expect(text).toContain("新規のお申し込みを終了");
    expect(text).toContain("移行が完了するまで");
    expect(text).not.toMatch(/スタンダードプランが月額|550円（税込）/);
  });

  test("プライバシーポリシー: OpenAIへの送信・同意・保存しない方針・OpenAI側の保持（最長30日）・国外処理が書かれている", async ({ page }) => {
    await page.goto("/privacy");
    const ai = page.getByTestId("privacy-ai");
    await expect(ai).toBeVisible();
    const text = await ai.innerText();
    expect(text).toContain("OpenAI");
    expect(text).toContain("同意");
    expect(text).toContain("保存しません");
    expect(text).toContain("最長30日");
    expect(text).toContain("学習");
    expect(text).toContain("日本国外");
    // 「ファイルは送信されない」の説明に、AIの例外が明記されている
    const all = await page.locator("main").innerText();
    expect(all).toContain("AIによる読み取り補助を除きます");
  });

  test("特定商取引法: 販売価格はPremium 月額1,100円のみ。旧料金の契約者の扱いも書かれている", async ({ page }) => {
    await page.goto("/tokushoho");
    const text = await page.locator("main").innerText();
    expect(text).toContain("月額1,100円（税込）");
    expect(text).toContain("移行が完了するまで、ご契約時の料金で請求されます");
    expect(text).not.toMatch(/スタンダードプラン: 月額/);
  });
});
