import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { createEmptyDocumentForm } from "@/lib/documents/types";
import { memoTemplate, parseDocumentMemo, parseMemoDate, splitItemFields } from "@/lib/documents/memo-import";

/** メモの貼り付けで、帳票の入力欄をまとめて埋める（AIなし・ブラウザの中だけ） */

test.describe("メモから入力: 読み取り（計算）", () => {
  test("基本の項目・宛先・発行者・明細・税率・備考を読む", () => {
    const form = createEmptyDocumentForm("estimate");
    const r = parseDocumentMemo(
      [
        "書類番号：EST-20261101-001",
        "発行日：2026年11月1日",
        "有効期限: ２０２６/１１/３０",
        "宛先：株式会社お客様商事",
        "宛先担当：山田 太郎",
        "【発行者】住所：大阪府大阪市2-2-2",
        "",
        "# これはコメント",
        "明細：外壁塗装工事, 1, 式, ¥100,000",
        "明細：足場設置、2、日、15000円",
        "明細：諸経費, 5000",
        "税率：８％",
        "端数：四捨五入",
        "備考：1行目",
        "備考：2行目",
      ].join("\n"),
      form
    );
    expect(r.issues).toEqual([]);
    expect(r.patch.documentNumber).toBe("EST-20261101-001");
    expect(r.patch.issueDate).toBe("2026-11-01");
    expect(r.patch.secondaryDate).toBe("2026-11-30");
    expect(r.patch.recipient).toMatchObject({ companyName: "株式会社お客様商事", contactName: "山田 太郎" });
    expect(r.patch.issuer).toMatchObject({ address: "大阪府大阪市2-2-2", companyName: "" });
    expect(r.patch.items?.map((i) => [i.name, i.quantity, i.unit, i.unitPrice])).toEqual([
      ["外壁塗装工事", "1", "式", "100000"],
      ["足場設置", "2", "日", "15000"],
      ["諸経費", "1", "式", "5000"],
    ]);
    expect(r.patch.taxRatePercent).toBe(8);
    expect(r.patch.taxRounding).toBe("round");
    expect(r.patch.notes).toBe("1行目\n2行目");
    expect(r.applied).toContain("明細（3行）");
  });

  test("読めない行は、行番号と理由を返し、他の行は入れる", () => {
    const form = createEmptyDocumentForm("estimate");
    const r = parseDocumentMemo(
      ["宛先：A社", "これは項目名がない行", "発行日：来週", "明細：作業, 一, 式, 100", "色：青", "銀行：〇〇銀行", "納期：2026/12/01"].join("\n"),
      form
    );
    expect(r.patch.recipient?.companyName).toBe("A社");
    expect(r.issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(r.issues[0].reason).toContain("項目名：中身");
    expect(r.issues[1].reason).toContain("2026/11/01");
    expect(r.issues[2].reason).toContain("数量「一」");
    expect(r.issues[3].reason).toContain("「色」という項目はありません");
    expect(r.issues[4].reason).toContain("請求書だけ");
    expect(r.issues[5].reason).toContain("納期の欄がありません");
  });

  test("金額の桁区切りのカンマと、区切りのカンマを見分ける。日付の形", () => {
    expect(splitItemFields("工事, 1, 式, 1,000,000")).toEqual(["工事", "1", "式", "1,000,000"]);
    expect(splitItemFields("工事,100,個,500")).toEqual(["工事", "100", "個", "500"]);
    expect(splitItemFields("工事\t2\t日\t15,000")).toEqual(["工事", "2", "日", "15,000"]);
    expect(parseMemoDate("2026.2.30")).toBeNull();
    expect(parseMemoDate("2026-2-3")).toBe("2026-02-03");
  });

  test("請求書は振込先、注文書は納期（日付）、一体作成は納期（文字）に入る。記入例はそのまま読める", () => {
    const inv = parseDocumentMemo("口座種別：当座\n口座番号：１２３ ４５６７", createEmptyDocumentForm("invoice"));
    expect(inv.patch.bankAccount).toMatchObject({ accountType: "当座", accountNumber: "1234567", bankName: "" });
    const ord = parseDocumentMemo("納期：2026/12/01", createEmptyDocumentForm("order"));
    expect(ord.patch.secondaryDate).toBe("2026-12-01");
    const qo = parseDocumentMemo("納期：受注後2週間", createEmptyDocumentForm("estimate"), { deliveryTextField: true });
    expect(qo.deliveryText).toBe("受注後2週間");
    for (const t of ["estimate", "invoice", "order"] as const) {
      const r = parseDocumentMemo(memoTemplate(t), createEmptyDocumentForm(t));
      expect(r.issues, t).toEqual([]);
    }
    const r = parseDocumentMemo(memoTemplate("estimate", { deliveryTextField: true }), createEmptyDocumentForm("estimate"), { deliveryTextField: true });
    expect(r.issues).toEqual([]);
  });
});

async function openMemo(page: Page, slug: string) {
  await page.goto(`/tools/${slug}`);
  const box = page.getByTestId("memo-import");
  await box.waitFor({ timeout: 60_000 });
  // 画面の準備（ハイドレーション）が終わるまで、開いて入力し直す
  await expect(async () => {
    if (!(await box.evaluate((d) => (d as HTMLDetailsElement).open))) await box.locator("summary").click();
    await page.getByTestId("memo-import-text").fill("宛先：x");
    await expect(page.getByTestId("memo-import-apply")).toBeEnabled({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
}

test.describe("メモから入力: 画面", () => {
  test("請求書: 記入例を入れて取り込むと、各欄・明細・振込先に入り、プレビューに出る", async ({ page }) => {
    test.setTimeout(120_000);
    await openMemo(page, "invoice-generator");
    await page.getByTestId("memo-import-example").click();
    await page.getByTestId("memo-import-apply").click();
    await expect(page.getByTestId("memo-import-result")).toContainText("項目を入れました");
    await expect(page.getByTestId("memo-import-issues")).toHaveCount(0);

    await expect(page.getByTestId("document-number")).toHaveValue("INV-20261101-001");
    await expect(page.locator('input[type="date"]').first()).toHaveValue("2026-11-01");
    await expect(page.getByLabel("会社名・屋号", { exact: true }).nth(0)).toHaveValue("株式会社お客様商事");
    await expect(page.getByLabel("会社名・屋号", { exact: true }).nth(1)).toHaveValue("株式会社テスト工務店");
    await expect(page.getByPlaceholder("商品名・作業内容")).toHaveCount(2);
    await expect(page.getByPlaceholder("商品名・作業内容").nth(1)).toHaveValue("足場設置");
    const preview = page.getByTestId("tool-preview");
    await expect(preview).toContainText("外壁塗装工事");
    await expect(preview).toContainText("〇〇銀行");
  });

  test("見積書: 読めない行は一覧で出し、読めた行だけ入れる", async ({ page }) => {
    test.setTimeout(120_000);
    await openMemo(page, "estimate-generator");
    await page.getByTestId("memo-import-text").fill("宛先：株式会社テスト\n色：青\n発行日：来週");
    await page.getByTestId("memo-import-apply").click();
    await expect(page.getByLabel("会社名・屋号", { exact: true }).nth(0)).toHaveValue("株式会社テスト");
    const issues = page.getByTestId("memo-import-issues");
    await expect(issues).toContainText("2行");
    await expect(issues).toContainText("2行目「色：青」");
    await expect(issues).toContainText("3行目「発行日：来週」");
  });

  test("見積書・注文書一体: 納期は注文書の納期の欄に入る", async ({ page }) => {
    test.setTimeout(120_000);
    await openMemo(page, "quote-order-generator");
    await page.getByTestId("memo-import-text").fill("宛先：株式会社テスト\n納期：受注後2週間\n明細：作業, 1, 式, 5000");
    await page.getByTestId("memo-import-apply").click();
    await expect(page.getByPlaceholder("例: 2026年11月30日 / 受注後2週間")).toHaveValue("受注後2週間");
    await expect(page.getByTestId("tool-preview")).toContainText("受注後2週間");
  });
});
