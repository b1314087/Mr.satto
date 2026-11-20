import type { Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload } from "../helpers/tool-runner";
import { extractPdfContent } from "../helpers/pdf-inspect";
import { readDocxPart, readDocxText } from "../helpers/docx-inspect";
import { getToolById, tools } from "@/lib/tools/data";
import { searchTools } from "@/lib/tools/search";
import {
  clampLayout,
  coverLetterBaseName,
  createEmptyCoverLetter,
  parsePartyText,
  parseRecipientRows,
  parseRecipientText,
  defaultGreeting,
  formatJapaneseDate,
  itemLines,
  parseStoredSender,
  recipientLineEntries,
  recipientLines,
  senderLineEntries,
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
    f.recipients[0].companyName = "株式会社サンプル";
    expect(validateCoverLetter(f)).toContain("差出人");
    f.sender.companyName = "株式会社テスト";
    expect(validateCoverLetter(f)).toContain("送付書類");
    f.items[0].name = "見積書";
    expect(validateCoverLetter(f)).toBeNull();
    const fax = { ...f, kind: "fax" as const, items: [], faxPages: "三" };
    expect(validateCoverLetter(fax)).toContain("数字");
    expect(validateCoverLetter({ ...fax, faxPages: "3" })).toBeNull();
  });

  test("宛先の貼り付け（Excelの表）：1行1件。見出しがあれば見出しの並び、なければ会社名・部署名・担当者名・FAX・電話の順。敬称は外す", () => {
    const noHeader = parseRecipientRows("株式会社サンプル\t総務部\t山田 太郎様\n合同会社テスト\t\t佐藤 花子\t03-1111-2222");
    expect(noHeader.map((r) => [r.companyName, r.department, r.contactName, r.fax])).toEqual([
      ["株式会社サンプル", "総務部", "山田 太郎", ""],
      ["合同会社テスト", "", "佐藤 花子", "03-1111-2222"],
    ]);
    const withHeader = parseRecipientRows("担当者\t会社名\tFAX\n鈴木 一郎\t有限会社ABC 御中\t06-1234-5678");
    expect(withHeader).toHaveLength(1);
    expect([withHeader[0].companyName, withHeader[0].contactName, withHeader[0].fax]).toEqual(["有限会社ABC", "鈴木 一郎", "06-1234-5678"]);
    const csv = parseRecipientRows('会社名,担当者名\n"株式会社A,B",田中');
    expect(csv[0].companyName).toBe("株式会社A,B");
    expect(new Set([...noHeader, ...withHeader].map((r) => r.id)).size).toBe(3);
  });

  test("署名の貼り付け：会社名・部署・氏名・〒・住所・TEL・FAX・メールに分ける", () => {
    const s = parsePartyText("株式会社サンプル\n営業部 佐藤 花子\n〒650-0001 兵庫県神戸市中央区1-1-1\nTEL 078-123-4567 / FAX 078-123-4568\nhanako@example.com");
    expect(s).toMatchObject({
      companyName: "株式会社サンプル",
      department: "営業部",
      contactName: "佐藤 花子",
      postalCode: "650-0001",
      address: "兵庫県神戸市中央区1-1-1",
      tel: "078-123-4567",
      fax: "078-123-4568",
      email: "hanako@example.com",
    });
    const r = parseRecipientText("株式会社テスト\n総務課\n山田 太郎 様");
    expect([r.companyName, r.department, r.contactName]).toEqual(["株式会社テスト", "総務課", "山田 太郎"]);
  });

  test("1行ずつの項目：宛先・差出人の各行が、どの項目かわかる", () => {
    expect(recipientLineEntries({ companyName: "A社", department: "総務部", contactName: "", fax: "", tel: "" })).toEqual([
      { key: "recipient.company", text: "A社" },
      { key: "recipient.department", text: "総務部 御中" },
    ]);
    expect(senderLineEntries({ companyName: "B社", department: "", contactName: "", postalCode: "650-0001", address: "", tel: "078", fax: "", email: "" }).map((e) => e.key)).toEqual([
      "sender.company",
      "sender.postal",
      "sender.tel",
    ]);
    expect(clampLayout({ "sender.address": { x: 99, y: 3 } } as never)["sender.address"]).toEqual({ x: 40, y: 3 });
  });

  test("位置のずらし量：範囲に収め、壊れた値は0。複数件のファイル名は件数", () => {
    const l = clampLayout({ date: { x: 999, y: -999 }, title: { x: Number.NaN, y: 5 } } as never);
    expect(l.date).toEqual({ x: 40, y: -20 });
    expect(l.title).toEqual({ x: 0, y: 5 });
    expect(l.notes).toEqual({ x: 0, y: 0 });
    const f = createEmptyCoverLetter("document");
    f.recipients = parseRecipientRows("A社\nB社\nC社");
    expect(coverLetterBaseName(f)).toMatch(/^書類送付状_3件_/);
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

/** 完成のポップアップを閉じる（続けて画面を操作するため） */
async function closePopup(page: Page) {
  const overlay = page.getByTestId("result-popup-overlay");
  if (await overlay.isVisible()) await overlay.getByRole("button", { name: "閉じる" }).first().click();
  await expect(overlay).toBeHidden();
}

async function savePdf(page: Page): Promise<string> {
  await page.getByTestId("cover-letter-generate").click();
  await expect(page.getByText("PDFを作成しました")).toBeVisible({ timeout: 30_000 });
  const download = await clickAndDownload(page, /PDFをダウンロード/);
  expect(download.suggestedFilename()).toMatch(/^(書類送付状|FAX送付状)_.*\.pdf$/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cover-")), "out.pdf");
  await download.saveAs(file);
  await closePopup(page);
  return file;
}

async function saveWord(page: Page): Promise<string> {
  await page.getByTestId("cover-letter-format-word").click();
  await page.getByTestId("cover-letter-generate").click();
  await expect(page.getByText("Wordを作成しました")).toBeVisible({ timeout: 30_000 });
  const download = await clickAndDownload(page, /Wordをダウンロード/);
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cover-")), "out.docx");
  await download.saveAs(file);
  await closePopup(page);
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
    await page.getByLabel("住所", { exact: true }).fill("兵庫県神戸市中央区1-1-1");
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

  test("Wordで出力できる：Wordの文字として、宛先・差出人・本文・送付書類が入る", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("担当者名（入れると「様」、空なら「御中」）").fill("山田 太郎");
    await page.getByLabel("会社名・屋号").fill("株式会社テスト");
    await page.getByLabel("書類1", { exact: true }).fill("見積書");
    const file = await saveWord(page);
    const text = (await readDocxText(file)).replace(/\s+/g, "");
    for (const s of ["書類送付のご案内", "株式会社サンプル", "山田太郎様", "株式会社テスト", "拝啓", "敬具", "記", "1．見積書1部", "以上"]) expect(text, s).toContain(s);
  });

  test("複数件：Excelの表を貼り付けると宛先が増え、1宛先＝1ページでまとめて作る（PDF・Word）", async ({ page }) => {
    await openTool(page);
    await page.getByTestId("cover-letter-recipient-paste").fill("合同会社テスト\t営業部\t佐藤 花子\n有限会社ABC\t\t");
    await page.getByTestId("cover-letter-recipient-paste-apply").click();
    await expect(page.getByTestId("cover-letter-paste-note")).toContainText("2件の宛先を追加しました（全部で3件）");
    await expect(page.getByTestId("cover-letter-recipient")).toHaveCount(3);
    await expect(page.getByTestId("cover-letter-preview-count")).toContainText("2 / 3件目");
    await expect(page.getByTestId("cover-letter-preview")).toContainText("佐藤 花子 様");
    await page.getByRole("button", { name: "次の宛先" }).click();
    await expect(page.getByTestId("cover-letter-preview")).toContainText("有限会社ABC 御中");
    // 差出人は、署名の貼り付けで入れる
    await page.getByTestId("cover-letter-sender-paste").fill("株式会社テスト\n佐藤 一郎\nTEL 078-123-4567");
    await page.getByTestId("cover-letter-sender-paste-apply").click();
    await expect(page.getByLabel("会社名・屋号")).toHaveValue("株式会社テスト");
    await expect(page.getByLabel("電話番号")).toHaveValue("078-123-4567");
    await page.getByLabel("書類1", { exact: true }).fill("請求書");
    await expect(page.getByTestId("cover-letter-generate")).toContainText("（3件）");

    const pdf = await extractPdfContent(await savePdf(page));
    expect(pdf.pageCount).toBe(3);
    const pageTexts = pdf.pages.map((p) => p.items.map((it) => it.str).join("").replace(/\s+/g, ""));
    expect(pageTexts[0]).toContain("株式会社サンプル御中");
    expect(pageTexts[1]).toContain("佐藤花子様");
    expect(pageTexts[2]).toContain("有限会社ABC御中");

    const docx = await saveWord(page);
    const xml = await readDocxPart(docx, "word/document.xml");
    // 宛先ごとに区切られる（Wordの「セクション」＝改ページ）
    expect((xml.match(/<w:sectPr/g) ?? []).length).toBe(3);
  });

  test("位置の調整：①の中のバーで件名を動かすと、プレビューとPDFの位置が変わる", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("会社名・屋号").fill("株式会社テスト");
    await page.getByLabel("書類1", { exact: true }).fill("見積書");
    const before = await extractPdfContent(await savePdf(page));
    const titleX = (pdf: typeof before) => pdf.pages[0].items.find((it) => it.str.includes("書類送付"))!.x;
    const titleY = (pdf: typeof before) => pdf.pages[0].items.find((it) => it.str.includes("書類送付"))!.y;

    // ①（種類・日付・件名）の中に、日付・件名の位置のバーがある
    const sec1 = page.getByTestId("cover-letter-section-1");
    await expect(sec1.getByTestId("cover-letter-position-1")).toBeVisible();
    await sec1.getByTestId("cover-letter-position-item-1").selectOption("title");
    const xBox = page.getByLabel("件名 横の位置の数値");
    await xBox.fill("20");
    await xBox.press("Enter");
    const yBox = page.getByLabel("件名 縦の位置の数値");
    await yBox.fill("10");
    await yBox.press("Enter");
    await expect(page.getByTestId("cover-letter-layout-status")).toContainText("変更あり");
    await expect(sec1.getByTestId("cover-letter-position-moved-1")).toContainText("件名（横20・縦10mm）");
    const after = await extractPdfContent(await savePdf(page));
    // 20mm ≒ 56.7pt 右へ、10mm ≒ 28.3pt 下へ
    expect(titleX(after) - titleX(before)).toBeGreaterThan(50);
    expect(titleX(after) - titleX(before)).toBeLessThan(62);
    expect(titleY(before) - titleY(after)).toBeGreaterThan(24);

    await page.getByTestId("cover-letter-layout-reset").click();
    await expect(page.getByTestId("cover-letter-layout-status")).toContainText("標準");
  });

  test("1行ずつの位置：プレビューの文字をクリックして選び、その行だけを動かせる（ほかの行は動かない）", async ({ page }) => {
    await openTool(page);
    await page.getByLabel("会社名・屋号").fill("株式会社テスト");
    await page.getByLabel("電話番号").fill("078-123-4567");
    await page.getByLabel("書類1", { exact: true }).fill("見積書");
    const before = await extractPdfContent(await savePdf(page));
    const find = (pdf: typeof before, s: string) => pdf.pages[0].items.find((it) => it.str.includes(s))!;

    // プレビューの差出人の会社名をクリックすると、③（差出人）の中の位置のバーで、その行が選ばれる
    await page.getByTestId("cover-letter-preview").locator('[data-layout-item="sender.company"]').click();
    await expect(page.getByTestId("cover-letter-section-3").getByTestId("cover-letter-position-item-3")).toHaveValue("sender.company");
    const box = page.getByLabel("差出人の会社名 横の位置の数値");
    await expect(box).toBeVisible();
    await box.fill("-30");
    await box.press("Enter");
    await expect(page.getByTestId("cover-letter-position-moved-3")).toContainText("差出人の会社名（横-30・縦0mm）");
    // プレビューでも、その行だけが動く
    const style = await page.getByTestId("cover-letter-preview").locator('[data-layout-item="sender.company"]').evaluate((el) => (el.parentElement as HTMLElement).style.left);
    expect(style).toContain("cqw");

    const after = await extractPdfContent(await savePdf(page));
    const moved = find(before, "株式会社テスト").x - find(after, "株式会社テスト").x;
    expect(moved).toBeGreaterThan(80); // 30mm ≒ 85pt 左へ
    expect(moved).toBeLessThan(90);
    // 電話番号の行は動かない
    expect(Math.abs(find(before, "078").x - find(after, "078").x)).toBeLessThan(0.5);
    expect(Math.abs(find(before, "078").y - find(after, "078").y)).toBeLessThan(0.5);
  });

  test("位置のバーは、それぞれの設定（①〜⑥）の中にある", async ({ page }) => {
    await openTool(page);
    const expectItems = async (sec: number, values: string[]) => {
      const box = page.getByTestId(`cover-letter-section-${sec}`).getByTestId(`cover-letter-position-${sec}`);
      if (values.length > 1) {
        const options = await box.getByTestId(`cover-letter-position-item-${sec}`).locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
        expect(options, String(sec)).toEqual(values);
      } else {
        await expect(box.getByRole("slider").first()).toHaveAttribute("aria-label", /横の位置/);
      }
    };
    await expectItems(1, ["date", "title"]);
    await expectItems(2, ["recipient", "recipient.company", "recipient.department", "recipient.name", "recipient.contact"]);
    await expectItems(3, ["sender", "sender.company", "sender.department", "sender.name", "sender.postal", "sender.address", "sender.tel", "sender.fax", "sender.email"]);
    await page.getByTestId("cover-letter-section-4").locator("summary").click();
    await expectItems(4, ["body"]);
    await expectItems(5, ["items"]);
    await page.getByTestId("cover-letter-section-6").locator("summary").click();
    await expectItems(6, ["notes"]);
    // 別の位置の設定（⑦）はもうない
    await expect(page.getByTestId("cover-letter-layout")).toHaveCount(0);
  });

  test("プライバシーポリシーに、差出人をこの端末に保存することが書いてある", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.locator("main")).toContainText("送付状作成でも、ユーザーが「差出人をこの端末に保存」を選んだ場合に限り");
  });
});
