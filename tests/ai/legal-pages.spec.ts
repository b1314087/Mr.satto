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
    // AIの対象（表・画像・スキャンPDF）と、画像の文字がすべて送られることが書かれている
    expect(text).toContain("Excel・CSV・PDF・画像");
    expect(text).toContain("先頭の最大4ページ");
    expect(text).toContain("画像に写っている文字や、PDFから取り出した文字は、すべてAIに送られます");
    // 記入済みPDF→Excelの「AIで項目を読み取る」（文字のPDFの文字だけを送る・5ページ・6,000文字）
    expect(text).toContain("「AIで項目を読み取る」");
    expect(text).toContain("最大5ページ、合計6,000文字まで");
    expect(text).toContain("通常の記入済みPDF→Excel（自動抽出・テンプレート）");
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
    // 形式ごとの送信内容（Excel・CSV=選んだ行・列、画像・スキャンPDF=縮小した画像）と、通常処理はAIなし
    expect(text).toContain("Excel（.xlsx・.xlsm）・CSV");
    expect(text).toContain("JPEGに縮小した画像");
    expect(text).toContain("先頭の最大4ページ");
    expect(text).toContain("およびPDFから取り出した文字は、すべてAIに送られます");
    // 記入済みPDF→Excelの「AIで項目を読み取る」: 送る内容（PDFの文字だけ・ファイルや画像は送らない）と、通常の変換はAIなし
    expect(text).toContain("「AIで項目を読み取る」は、同じく外部のAIサービス");
    expect(text).toContain("文字情報のあるPDF（スキャンした画像のPDFは対象外です）から、ブラウザの中で取り出した文字だけを送信します");
    expect(text).toContain("1つのPDFの最大5ページ、合計6,000文字まで");
    expect(text).toContain("PDFファイルそのもの、画像は送信しません");
    expect(text).toContain("通常の記入済みPDF→Excel（自動抽出・テンプレート）");
    expect(text).toContain("本サービスのサーバー側でも、AIによる処理を行いません");
    expect(text).toContain("通常の年度カレンダー作成");
    expect(text).toContain("元のファイルは送信しません");
    expect(text).toContain("自動では採用されません");
    await expect(ai.locator('a[href="https://developers.openai.com/api/docs/guides/your-data"]')).toBeVisible();
    // 「ファイルは送信されない」の説明に、AIの例外が明記されている
    const all = await page.locator("main").innerText();
    expect(all).toContain("AIによる読み取り補助を除きます");
  });

  test("料金ページ: プレミアムの内容（AIの利用枠・外部送信・PDF→Excelの制限差）が書かれ、全ツールが標準扱いの間は「プレミアム対象ツール」を書かない", async ({ page }) => {
    await page.goto("/pricing");
    const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    expect(text).toContain("月額1,100円");
    expect(text).toContain("AIの利用枠は、請求期間ごとに上限があり");
    expect(text).toContain("同意のうえで、選んだ内容が外部のAIサービス（OpenAI）へ送信されます");
    expect(text).toContain("「記入済みPDF→Excel」は、ページ数・回数の制限なし");
    expect(text).toContain("「記入済みPDF→Excel」は、1回1ページまで");
    expect(text).toContain("「記入済みPDF→Excel」の「AIで項目を読み取る」補助");
    expect(text).not.toContain("プレミアム対象ツール");
    expect(text).not.toContain("通常ツールを利用可能");
  });

  test("特定商取引法: 販売価格はPremium 月額1,100円のみ。旧料金の契約者の扱いも書かれている", async ({ page }) => {
    await page.goto("/tokushoho");
    const text = await page.locator("main").innerText();
    expect(text).toContain("月額1,100円（税込）");
    expect(text).toContain("移行が完了するまで、ご契約時の料金で請求されます");
    expect(text).not.toMatch(/スタンダードプラン: 月額/);
  });
});
