import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { test, expect } from "../fixtures/premium-test";
import { FORM_CONSENT_VERSION } from "@/lib/ai/form-extract";
import { waitForFileInputHydrated } from "../helpers/tool-runner";

/**
 * Word→Excel: 「AIで表にする」パネル（プレミアム・任意）のE2Eテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAI・Stripe・Supabaseには接続しない。
 * 実際のAIの整理の精度・消費トークンは、このテストでは確認できない。
 */

const SLUG = "/tools/word-to-excel";
const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_000, remainingAiTokens: 29_999_000, periodEnd: "2026-11-30T00:00:00Z" } };

interface Recorded {
  usageCalls: number;
  bodies: Record<string, unknown>[];
}

async function mockAi(page: Page, opts: { usage?: unknown; rows?: unknown[] } = {}): Promise<Recorded> {
  const rec: Recorded = { usageCalls: 0, bodies: [] };
  await page.route("**/api/ai/usage", async (route: Route) => {
    rec.usageCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.usage ?? USAGE_OK) });
  });
  await page.route("**/api/ai/form-extract", async (route: Route) => {
    rec.bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, model: "standard", rows: opts.rows ?? RESULT_ROWS, notes: [], rejected: 0, usage: USAGE_OK.usage }),
    });
  });
  return rec;
}

const RESULT_ROWS = [
  { page: 1, kind: "header", cells: ["氏名", "学年", "連絡先"], unverified: [] },
  { page: 1, kind: "data", cells: ["山田 太郎", "3年", "090-0000-0001"], unverified: [] },
  { page: 1, kind: "data", cells: ["佐藤 花子", "2年", "090-0000-9999"], unverified: [2] },
];

/** 表と、表になっていない文章（項目と内容の並び）を持つWord文書（架空のデータ） */
async function wordFile(paragraphs: string[], withTable = true): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const children: (Paragraph | Table)[] = paragraphs.map((t) => new Paragraph({ children: [new TextRun(t)] }));
  if (withTable) {
    children.push(
      new Table({
        rows: [
          new TableRow({ children: ["品名", "数量"].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
          new TableRow({ children: ["ペン", "10"].map((t) => new TableCell({ children: [new Paragraph(t)] })) }),
        ],
      }),
    );
  }
  const doc = new Document({ sections: [{ children }] });
  return { name: "名簿.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(await Packer.toBuffer(doc)) };
}

const PARAGRAPHS = ["参加者の一覧", "氏名：山田 太郎　学年：3年　連絡先：090-0000-0001", "氏名：佐藤 花子　学年：2年　連絡先：090-0000-0002"];

async function openAndUpload(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto(SLUG);
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await expect(page.getByTestId("word-to-excel-tables")).toBeVisible({ timeout: 60_000 });
}

test.describe("Word→Excel: AIで表にする（任意・プレミアム）", () => {
  test.setTimeout(150_000);

  test("表以外の文章がある文書だけに出る。開くまでは、利用状況の確認もAIへの送信もしない。通常の変換はそのまま使える", async ({ page }) => {
    const rec = await mockAi(page);
    await openAndUpload(page, await wordFile(PARAGRAPHS));
    await expect(page.getByTestId("form-ai-panel")).toContainText("AIで表にする（任意）");
    await expect(page.getByRole("button", { name: "Excelに変換する" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(rec.usageCalls).toBe(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("表しかない文書には出さない", async ({ page }) => {
    await mockAi(page);
    await openAndUpload(page, await wordFile([], true));
    await page.waitForTimeout(500);
    await expect(page.getByTestId("form-ai-panel")).toHaveCount(0);
  });

  test("送るのは表以外の文章だけ（表の中の文字は送らない）。同意すると目的 word で送り、結果を直してExcelを受け取れる", async ({ page }) => {
    const rec = await mockAi(page);
    await openAndUpload(page, await wordFile(PARAGRAPHS));
    await page.getByTestId("form-ai-toggle").click();
    const preview = page.getByTestId("form-ai-preview");
    await expect(preview).toContainText("氏名：山田 太郎", { timeout: 30_000 });
    await expect(preview).toContainText("1つ目のまとまり");
    await expect(preview).not.toContainText("品名");
    await expect(preview).toContainText("Word文書のファイルそのもの・画像は送りません。");
    await expect(page.getByTestId("form-ai-run")).toBeDisabled();
    await expect(page.getByTestId("form-ai-run")).toContainText("AIで表にする");
    await page.getByTestId("form-ai-consent").check();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-row")).toHaveCount(3);

    expect(rec.bodies).toHaveLength(1);
    const sent = rec.bodies[0] as { purpose: string; consent: unknown; pages: { page: number; text: string }[] };
    expect(sent.purpose).toBe("word");
    expect(sent.consent).toEqual({ accepted: true, version: FORM_CONSENT_VERSION });
    const allText = sent.pages.map((p) => p.text).join("\n");
    expect(allText).toContain("氏名：佐藤 花子");
    expect(allText).not.toContain("品名");
    expect(Object.keys(sent).sort()).toEqual(["consent", "model", "pages", "purpose", "requestId"]);
    await expect(page.getByTestId("form-ai-consent")).not.toBeChecked();

    // 原文に無い値は目立ち、直すと消える
    await expect(page.getByTestId("form-ai-unverified-note")).toContainText("元のWord文書の文字の中に");
    await page.getByTestId("form-ai-row").nth(2).locator("input").nth(2).fill("090-0000-0002");
    await expect(page.getByTestId("form-ai-unverified-note")).toHaveCount(0);
    await page.getByTestId("form-ai-make-excel").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("form-ai-download").click()]);
    expect(download.suggestedFilename()).toBe("名簿_AIで表にした文章.xlsx");
    expect(fs.statSync((await download.path())!).size).toBeGreaterThan(1000);
  });

  test("プレミアムでない場合は理由を示し、実行の入口を出さない", async ({ page }) => {
    const rec = await mockAi(page, { usage: { available: false, reason: "not_premium" } });
    await openAndUpload(page, await wordFile(PARAGRAPHS));
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-panel")).toContainText("プレミアムプランの機能です");
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("文章が6,000文字を超える文書は、送れないことを案内し、AIには何も送らない", async ({ page }) => {
    const rec = await mockAi(page);
    const long = Array.from({ length: 70 }, (_, i) => `${i + 1}番目のお知らせ：${"あ".repeat(90)}`);
    await openAndUpload(page, await wordFile(long, false));
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-problem")).toContainText("文章が多すぎます", { timeout: 30_000 });
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });
});
