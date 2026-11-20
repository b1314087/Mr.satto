import type { Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { extractPdfContent } from "../helpers/pdf-inspect";
import { getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import {
  createEmptyCoverLetter,
  defaultGreeting,
  formatJapaneseDate,
  itemLines,
  parseStoredSender,
  recipientLines,
  senderLines,
  validateCoverLetter,
} from "@/lib/documents/cover-letter";

/** 送付状作成（書類送付状・FAX送付状）のテスト */

test.describe("送付状：文面の組み立て", () => {
  test("敬称：担当者名があれば「様」、なければ最後の行に「御中」。重ねて付けない", () => {
    expect(recipientLines({ companyName: "株式会社サンプル", department: "総務部", contactName: "山田 太郎", fax: "", tel: "" })).toEqual(["株式会社サンプル", "総務部", "山田 太郎 様"]);
    expect(recipientLines({ companyName: "株式会社サンプル", department: "総務部", contactName: "", fax: "", tel: "" })).toEqual(["株式会社サンプル", "総務部 御中"]);
    expect(recipientLines({ companyName: "株式会社サンプル", department: "", contactName: "", fax: "", tel: "" })).toEqual(["株式会社サンプル 御中"]);
    expect(recipientLines({ companyName: "", department: "", contactName: "山田様", fax: "", tel: "" })).toEqual(["山田様"]);
    expect(recipientLines({ companyName: "株式会社サンプル御中", department: "", contactName: "", fax: "", tel: "" })).toEqual(["株式会社サンプル御中"]);
    expect(recipientLines({ companyName: "", department: "", contactName: "", fax: "", tel: "" })).toEqual([]);
  });

  test("送付書類：空の行は除き、数字の部数は「◯部」を付ける", () => {
    expect(
      itemLines([
        { id: "1", name: "見積書", copies: "1" },
        { id: "2", name: " ", copies: "2" },
        { id: "3", name: "契約書", copies: "" },
        { id: "4", name: "資料", copies: "一式" },
      ]),
    ).toEqual(["見積書　1部", "契約書", "資料　一式"]);
  });

  test("差出人・日付・あいさつ文", () => {
    expect(senderLines({ companyName: "株式会社テスト", department: "", contactName: "佐藤", postalCode: "650-0001", address: "神戸市", tel: "078-1", fax: "", email: "" })).toEqual([
      "株式会社テスト",
      "佐藤",
      "〒650-0001",
      "神戸市",
      "TEL：078-1",
    ]);
    expect(formatJapaneseDate("2026-11-20")).toBe("2026年11月20日");
    expect(defaultGreeting("document")).toContain("下記の書類をお送りいたします");
    expect(defaultGreeting("fax")).toContain("FAXにてお送りいたします");
    expect(defaultGreeting("fax").split("\n").at(-1)).toBe("敬具");
  });

  test("入力の確認：宛先・差出人・（書類送付状は）送付書類が必要。FAXの送信枚数は数字だけ", () => {
    const f = createEmptyCoverLetter("document");
    expect(validateCoverLetter(f)).toContain("宛先");
    f.recipient.companyName = "株式会社サンプル";
    expect(validateCoverLetter(f)).toContain("差出人");
    f.sender.companyName = "株式会社テスト";
    expect(validateCoverLetter(f)).toContain("送付書類");
    f.items[0].name = "見積書";
    expect(validateCoverLetter(f)).toBeNull();
    const fax = { ...f, kind: "fax" as const, items: [], faxPages: "三" };
    expect(validateCoverLetter(fax)).toContain("数字");
    expect(validateCoverLetter({ ...fax, faxPages: "3" })).toBeNull();
  });

  test("保存した差出人：壊れた値・空の値は使わず、知らない項目は捨てる", () => {
    expect(parseStoredSender(null)).toBeNull();
    expect(parseStoredSender("{")).toBeNull();
    expect(parseStoredSender(JSON.stringify({ companyName: "" }))).toBeNull();
    const s = parseStoredSender(JSON.stringify({ companyName: "株式会社テスト", evil: "<script>", tel: 123 }));
    expect(s?.companyName).toBe("株式会社テスト");
    expect(s?.tel).toBe("");
    expect(s && "evil" in s).toBe(false);
  });

  test("ツールの登録：生成ツールにあり、「送付状」「FAX送付状」「添え状」で見つかる", () => {
    const tool = getToolById("cover-letter");
    expect(tool?.name).toBe("送付状作成");
    expect(tool?.category).toBe("generator");
    for (const q of ["送付状", "FAX送付状", "添え状"]) expect(searchTools(tools, q).map((t) => t.id), q).toContain("cover-letter");
  });
});

async function openTool(page: Page) {
  await page.goto("/tools/cover-letter");
  // 画面の準備（ハイドレーション）ができるまで、入力し直す
  await expect(async () => {
    // 同じ値を入れ直しても変化が伝わらないので、いったん空にしてから入れる
    await page.getByLabel("会社名", { exact: true }).fill("");
    await page.getByLabel("会社名", { exact: true }).fill("株式会社サンプル");
    await expect(page.getByTestId("cover-letter-preview")).toContainText("株式会社サンプル 御中", { timeout: 3000 });
  }).toPass({ timeout: 90_000 });
}

async function savePdf(page: Page): Promise<string> {
  await page.getByTestId("cover-letter-generate").click();
  await expect(page.getByText("PDFを作成しました")).toBeVisible({ timeout: 30_000 });
  const download = await clickAndDownload(page, /PDFをダウンロード/);
  expect(download.suggestedFilename()).toMatch(/^(書類送付状|FAX送付状)_.*\.pdf$/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cover-")), "out.pdf");
  await download.saveAs(file);
  return file;
}

test.describe("送付状：画面", () => {
  test.describe.configure({ timeout: 150_000 });

  test("書類送付状：宛先・差出人・送付書類を入れると、プレビューとPDFに同じ内容が出る", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("担当者名（入れると「様」、空なら「御中」）").fill("山田 太郎");
    await expect(page.getByTestId("cover-letter-preview")).toContainText("山田 太郎 様");
    await expect(page.getByTestId("cover-letter-preview")).not.toContainText("御中");
    await page.getByLabel("会社名・屋号").fill("株式会社テスト");
    await page.getByLabel("住所").fill("兵庫県神戸市中央区1-1-1");
    await page.getByLabel("書類1", { exact: true }).fill("見積書");
    await page.getByTestId("cover-letter-add-item").click();
    await page.getByLabel("書類2", { exact: true }).fill("請求書");
    const preview = page.getByTestId("cover-letter-preview");
    await expect(preview).toContainText("書類送付のご案内");
    await expect(preview).toContainText("1．見積書　1部");
    await expect(preview).toContainText("2．請求書　1部");
    await expect(preview).toContainText("拝啓");

    const pdf = await extractPdfContent(await savePdf(page));
    expect(pdf.pageCount).toBe(1);
    const text = pdf.text.replace(/\s+/g, "");
    for (const s of ["書類送付のご案内", "株式会社サンプル", "山田太郎様", "株式会社テスト", "兵庫県神戸市中央区1-1-1", "見積書", "請求書", "拝啓", "敬具", "記", "以上"]) {
      expect(text, s).toContain(s);
    }
  });

  test("FAX送付状：宛先のFAX番号・送信枚数を出し、送付書類なしでも作れる", async ({ page }) => {
    await openTool(page);
    await page.getByTestId("cover-letter-kind-fax").click();
    await page.getByLabel("宛先のFAX番号").fill("03-1234-5679");
    await page.getByLabel("会社名・屋号").fill("株式会社テスト");
    await page.getByLabel("送信枚数（この送付状を含む）").fill("3");
    const preview = page.getByTestId("cover-letter-preview");
    await expect(preview).toContainText("FAX送付のご案内");
    await expect(preview).toContainText("FAX：03-1234-5679");
    await expect(preview).toContainText("送信枚数：3枚（本紙を含む）");
    await expect(preview).toContainText("FAXにてお送りいたします");
    const pdf = await extractPdfContent(await savePdf(page));
    const text = pdf.text.replace(/\s+/g, "");
    for (const s of ["FAX送付のご案内", "03-1234-5679", "送信枚数：3枚（本紙を含む）"]) expect(text, s).toContain(s);
  });

  test("差出人の保存を選ぶと、次に開いたときに自動で入る（この端末のブラウザの中だけ）", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("会社名・屋号").fill("株式会社保存テスト");
    await page.getByLabel("書類1", { exact: true }).fill("見積書");
    await page.getByTestId("cover-letter-remember-sender").check();
    await savePdf(page);
    await page.reload();
    await expect(page.getByLabel("会社名・屋号")).toHaveValue("株式会社保存テスト", { timeout: 60_000 });
    await expect(page.getByTestId("cover-letter-remember-sender")).toBeChecked();
  });

  test("プライバシーポリシーに、差出人をこの端末に保存することが書いてある", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator("main")).toContainText("送付状作成でも、ユーザーが「差出人をこの端末に保存」を選んだ場合に限り");
  });
});
