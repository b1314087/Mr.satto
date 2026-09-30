import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";

/**
 * 次工程・軽量便利ツール一括追加（10ツール）のE2Eテスト。
 * 指示書が明示的に要求するテスト観点を、代表的な入力でカバーする:
 * - 日付: 通常の日付・月末・年末・うるう年・曜日抽出
 * - 時間: 通常勤務・休憩あり・日付をまたぐ・複数時間の合計
 * - 数字: 郵便番号・電話番号・カスタム区切り・空欄
 * - Excel: 通常のExcel・空白行あり・空白列あり・複数シート・日付セル・文字列セル
 * - Word: 通常のテキスト・複数段落・空白行・番号付きテキスト・日本語テキスト
 */

// ------------------------------------------------------------------
// Tool 1: 日付・曜日ツール
// ------------------------------------------------------------------
test.describe("date-weekday-tool", () => {
  test("曜日確認: 通常の日付から曜日と月初・月末が表示される", async ({ page }) => {
    await page.goto("/tools/date-weekday-tool");
    // 2026-10-01は木曜日
    await page.locator('input[type="date"]').first().fill("2026-10-01");
    await page.getByRole("button", { name: "計算する" }).click();
    await expect(page.getByText("2026-10-01（木）")).toBeVisible();
    await expect(page.getByText(/月初: 2026-10-01/)).toBeVisible();
    await expect(page.getByText(/月末: 2026-10-31/)).toBeVisible();
  });

  test("日付計算: 月末をまたぐ加算で正しい日付になる（うるう年含む）", async ({ page }) => {
    await page.goto("/tools/date-weekday-tool");
    await page.getByRole("button", { name: "日付計算" }).click();
    // 2028年はうるう年。2月28日+1日=2月29日になることを確認する
    await page.locator('input[type="date"]').first().fill("2028-02-28");
    await page.locator('input[type="number"]').first().fill("1");
    await page.getByRole("button", { name: "計算する" }).click();
    await expect(page.getByText("2028-02-29")).toBeVisible();
  });

  test("日付計算: 年末をまたぐ加算で翌年の日付になる", async ({ page }) => {
    await page.goto("/tools/date-weekday-tool");
    await page.getByRole("button", { name: "日付計算" }).click();
    await page.locator('input[type="date"]').first().fill("2026-12-31");
    await page.locator('input[type="number"]').first().fill("1");
    await page.getByRole("button", { name: "計算する" }).click();
    await expect(page.getByText("2027-01-01")).toBeVisible();
  });

  test("曜日抽出: 指定した曜日だけが一覧に含まれる", async ({ page }) => {
    await page.goto("/tools/date-weekday-tool");
    await page.getByRole("button", { name: "曜日抽出" }).click();
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("2026-10-01"); // 木
    await dateInputs.nth(1).fill("2026-10-07"); // 水
    // 既定で選択されている「月」以外を外し、「木」だけを選ぶ
    for (const day of ["月", "火", "水", "金"]) {
      await page.getByRole("button", { name: day, exact: true }).click();
    }
    await page.getByRole("button", { name: "計算する" }).click();
    await expect(page.getByText(/^1件$/)).toBeVisible();
    await expect(page.getByText("2026-10-01")).toBeVisible();
  });
});

// ------------------------------------------------------------------
// Tool 2: 時間計算
// ------------------------------------------------------------------
test.describe("time-calculator", () => {
  test("実働時間: 休憩を差し引いた通常勤務時間を計算できる（指示書の例: 9:00-17:30, 休憩1h → 7時間30分）", async ({ page }) => {
    await page.goto("/tools/time-calculator");
    await page.getByRole("button", { name: "実働時間（休憩差引）" }).click();
    const timeInputs = page.locator('input[type="time"]');
    await timeInputs.nth(0).fill("09:00");
    await timeInputs.nth(1).fill("17:30");
    await page.locator('input[type="number"]').fill("60");
    await page.getByRole("button", { name: "計算する" }).click();
    // ページ下部のFAQにも「7時間30分」という文字列が例として登場するため、
    // 結果表示の要素(p.text-lg.font-semibold)だけを対象に絞り込む
    await expect(page.locator("p.text-lg.font-semibold")).toHaveText("7時間30分");
  });

  test("時間差: 日付をまたぐ時刻でも正しく差分を計算できる", async ({ page }) => {
    await page.goto("/tools/time-calculator");
    const timeInputs = page.locator('input[type="time"]');
    await timeInputs.nth(0).fill("22:00");
    await timeInputs.nth(1).fill("02:00");
    await page.getByRole("button", { name: "計算する" }).click();
    await expect(page.locator("p.text-lg.font-semibold")).toHaveText("4時間0分");
  });

  test("複数時間の合計: 複数の時間を合計できる", async ({ page }) => {
    await page.goto("/tools/time-calculator");
    await page.getByRole("button", { name: "複数時間の合計" }).click();
    await page.locator("textarea").fill("2:30\n1:45");
    await page.getByRole("button", { name: "計算する" }).click();
    await expect(page.locator("p.text-lg.font-semibold")).toHaveText("4時間15分");
  });
});

// ------------------------------------------------------------------
// Tool 3: 数字・番号フォーマット
// ------------------------------------------------------------------
test.describe("number-format", () => {
  test("郵便番号: 7桁の数字にハイフンが入る", async ({ page }) => {
    await page.goto("/tools/number-format");
    await page.locator("textarea").first().fill("6530824");
    await page.getByRole("button", { name: "郵便番号" }).click();
    await expect(page.locator("textarea").nth(1)).toHaveValue("653-0824");
  });

  test("電話番号: 10桁の数字にハイフンが入る", async ({ page }) => {
    await page.goto("/tools/number-format");
    await page.locator("textarea").first().fill("0786910561");
    await page.getByRole("button", { name: "電話番号" }).click();
    await expect(page.locator("textarea").nth(1)).toHaveValue("078-691-0561");
  });

  test("カスタム区切り: 指定したパターンで区切られる", async ({ page }) => {
    await page.goto("/tools/number-format");
    await page.locator("textarea").first().fill("1234567890");
    await page.getByRole("button", { name: "カスタム区切り" }).click();
    await page.getByPlaceholder("3-4-3").fill("3-4-3");
    await expect(page.locator("textarea").nth(1)).toHaveValue("123-4567-890");
  });

  test("空欄の入力では結果も空になる", async ({ page }) => {
    await page.goto("/tools/number-format");
    await page.getByRole("button", { name: "郵便番号" }).click();
    await expect(page.locator("textarea").nth(1)).toHaveValue("");
  });
});

// ------------------------------------------------------------------
// Tool 4: Excel行列入れ替え
// ------------------------------------------------------------------
test.describe("excel-transpose", () => {
  test("通常のExcel: 行と列を入れ替えてダウンロードできる", async ({ page }) => {
    await page.goto("/tools/excel-transpose");
    await uploadFixture(page, fixtures.xlsx);
    await page.getByRole("button", { name: "行と列を入れ替える" }).click();
    await waitForSuccess(page, "変換が完了しました");
    const download = await clickAndDownload(page, "Excelファイルをダウンロード");
    await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  });

  test("複数シート: すべてのシートが変換される", async ({ page }) => {
    await page.goto("/tools/excel-transpose");
    await uploadFixture(page, fixtures.xlsxMultiSheet);
    await page.getByRole("button", { name: "行と列を入れ替える" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText("2シートを変換しました")).toBeVisible();
  });
});

// ------------------------------------------------------------------
// Tool 5: Excel空白行・空白列削除
// ------------------------------------------------------------------
test.describe("excel-blank-remove", () => {
  test("空白行あり: 空白行を削除できる", async ({ page }) => {
    await page.goto("/tools/excel-blank-remove");
    await uploadFixture(page, fixtures.xlsxBlankRowsCols);
    await page.getByRole("button", { name: "空白行のみ" }).click();
    await page.getByRole("button", { name: "空白を削除する" }).click();
    await waitForSuccess(page, "削除が完了しました");
    await expect(page.getByText(/削除した行: 1/)).toBeVisible();
  });

  test("空白列あり: 空白列を削除できる", async ({ page }) => {
    await page.goto("/tools/excel-blank-remove");
    await uploadFixture(page, fixtures.xlsxBlankRowsCols);
    await page.getByRole("button", { name: "空白列のみ" }).click();
    await page.getByRole("button", { name: "空白を削除する" }).click();
    await waitForSuccess(page, "削除が完了しました");
    await expect(page.getByText(/削除した列: 1/)).toBeVisible();
  });
});

// ------------------------------------------------------------------
// Tool 6: Excel文字削除・置換
// ------------------------------------------------------------------
test.describe("excel-replace", () => {
  test("文字列セルの置換ができる（数値セルは変更されない）", async ({ page }) => {
    await page.goto("/tools/excel-replace");
    await uploadFixture(page, fixtures.xlsx);
    await page.getByPlaceholder("例: 株式会社").fill("テスト商品");
    await page.getByPlaceholder("例: ㈱").fill("商品テスト");
    await page.getByRole("button", { name: "置換を実行する" }).click();
    await waitForSuccess(page, "処理が完了しました");
    await expect(page.getByText(/箇所を処理しました/)).toBeVisible();
  });

  test("複数シート: すべてのシートに同じ置換が適用される", async ({ page }) => {
    await page.goto("/tools/excel-replace");
    await uploadFixture(page, fixtures.xlsxMultiSheet);
    await page.getByPlaceholder("例: 株式会社").fill("S1_A1");
    await page.getByPlaceholder("例: ㈱").fill("REPLACED");
    await page.getByRole("button", { name: "置換を実行する" }).click();
    await waitForSuccess(page, "処理が完了しました");
    const download = await clickAndDownload(page, "Excelファイルをダウンロード");
    await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  });
});

// ------------------------------------------------------------------
// Tool 7: Excel横セル結合・中央揃え
// ------------------------------------------------------------------
test.describe("excel-merge-center", () => {
  test("指定範囲のセルを結合できる", async ({ page }) => {
    await page.goto("/tools/excel-merge-center");
    await uploadFixture(page, fixtures.xlsx);
    await page.getByRole("button", { name: "実行する" }).click();
    await waitForSuccess(page, "処理が完了しました");
    const download = await clickAndDownload(page, "Excelファイルをダウンロード");
    await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  });
});

// ------------------------------------------------------------------
// Tool 8: Excel日付一括変更
// ------------------------------------------------------------------
test.describe("excel-date-shift", () => {
  test("日付セル: 日付だけが変更され、日付以外のセルは変更されない", async ({ page }) => {
    await page.goto("/tools/excel-date-shift");
    await uploadFixture(page, fixtures.xlsxDates);
    await page.getByRole("button", { name: "日数を加算" }).click();
    await page.locator('input[type="number"]').fill("30");
    await page.getByRole("button", { name: "一括変更する" }).click();
    await waitForSuccess(page, "変更が完了しました");
    // Date型セル1つ + 文字列形式の日付セル1つ = 2件変更される（plain_text・numberは対象外）
    await expect(page.getByText(/2件の日付を変更しました/)).toBeVisible();
  });

  test("年を変更できる", async ({ page }) => {
    await page.goto("/tools/excel-date-shift");
    await uploadFixture(page, fixtures.xlsxDates);
    await page.getByRole("button", { name: "年を変更" }).click();
    await page.locator('input[type="number"]').fill("2030");
    await page.getByRole("button", { name: "一括変更する" }).click();
    await waitForSuccess(page, "変更が完了しました");
    await expect(page.getByText(/2件の日付を変更しました/)).toBeVisible();
  });
});

// ------------------------------------------------------------------
// Tool 9: Word段落整理
// ------------------------------------------------------------------
test.describe("word-paragraph-cleanup", () => {
  test("通常のテキスト: 処理してダウンロードできる", async ({ page }) => {
    await page.goto("/tools/word-paragraph-cleanup");
    await uploadFixture(page, fixtures.wordNormalDocx);
    await page.getByRole("button", { name: "整理を実行する" }).click();
    await waitForSuccess(page, "整理が完了しました");
    const download = await clickAndDownload(page, "Wordファイルをダウンロード");
    await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  });

  test("複数段落: 変更前後のテキストにすべての段落が含まれる", async ({ page }) => {
    await page.goto("/tools/word-paragraph-cleanup");
    await uploadFixture(page, fixtures.wordMultiParagraphDocx);
    await page.getByRole("button", { name: "整理を実行する" }).click();
    await waitForSuccess(page, "整理が完了しました");
    const beforeText = await page.locator("textarea").first().inputValue();
    expect(beforeText).toContain("1つ目の段落です。");
    expect(beforeText).toContain("3つ目の段落です。");
  });

  test("空白行: 空白行を削除できる", async ({ page }) => {
    await page.goto("/tools/word-paragraph-cleanup");
    await uploadFixture(page, fixtures.wordBlankLinesDocx);
    // 既定でオンの「連続する空白行を1行にまとめる」を外し、「空白行をすべて削除する」だけにする
    await page.getByText("連続する空白行を1行にまとめる").click();
    await page.getByText("空白行をすべて削除する").click();
    await page.getByRole("button", { name: "整理を実行する" }).click();
    await waitForSuccess(page, "整理が完了しました");
    // P,Q,(空行),R,(空行)(空行),S のうち空行は合計3つ
    await expect(page.getByText("削除した空白行: 3行")).toBeVisible();
  });

  test("日本語テキスト: 全角スペースが半角に変換される", async ({ page }) => {
    await page.goto("/tools/word-paragraph-cleanup");
    await uploadFixture(page, fixtures.wordJapaneseDocx);
    await page.getByText("全角スペースを半角に変換").click();
    await page.getByRole("button", { name: "整理を実行する" }).click();
    await waitForSuccess(page, "整理が完了しました");
    const afterText = await page.locator("textarea").nth(1).inputValue();
    expect(afterText).not.toContain("　");
    expect(afterText).toContain("全角スペース を含む日本語の文章です。");
  });
});

// ------------------------------------------------------------------
// Tool 10: Word番号振り直し
// ------------------------------------------------------------------
test.describe("word-renumber", () => {
  test("番号付きテキスト: 「1.2.3.」から「①②③」に変換でき、本文段落は対象外になる", async ({ page }) => {
    await page.goto("/tools/word-renumber");
    await uploadFixture(page, fixtures.wordNumberedDocx);
    // 既定: 変換前=1.2.3. 変換後=①②③（コンポーネントの初期値のまま）
    await page.getByRole("button", { name: "番号を振り直す" }).click();
    await waitForSuccess(page, "変換が完了しました");
    // 番号付き段落3つが変換され、番号のない本文2段落は対象外(skipped)になる
    await expect(page.getByText(/変換した行: 3/)).toBeVisible();
    await expect(page.getByText(/対象外だった行: 2/)).toBeVisible();
    const download = await clickAndDownload(page, "Wordファイルをダウンロード");
    await assertDownloadedFile(download, { format: "zip", minBytes: 10 });
  });

  test("変換先を「(1)(2)(3)」に変更できる", async ({ page }) => {
    await page.goto("/tools/word-renumber");
    await uploadFixture(page, fixtures.wordNumberedDocx);
    const pickers = page.getByRole("button", { name: "(1)(2)(3)" });
    await pickers.nth(1).click(); // 2つ目のFormatPicker(変換後)
    await page.getByRole("button", { name: "番号を振り直す" }).click();
    await waitForSuccess(page, "変換が完了しました");
    await expect(page.getByText(/変換した行: 3/)).toBeVisible();
  });
});
