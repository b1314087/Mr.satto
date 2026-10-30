import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { FORM_CONSENT_VERSION } from "@/lib/ai/form-extract";
import { fixtures } from "../fixtures/paths";

/**
 * PDF→Excel: 「AIで表を読み取る」パネルのE2Eテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAI・Stripe・Supabaseには接続しない。
 * 実際のAIの読み取り精度・消費トークンは、このテストでは確認できない。
 */

const SLUG = "/tools/pdf-to-excel";
const USAGE_OK = { available: true, usage: { limitAiTokens: 30_000_000, usedAiTokens: 1_000, remainingAiTokens: 29_999_000, periodEnd: "2026-11-30T00:00:00Z" } };

interface Recorded {
  usageCalls: number;
  bodies: Record<string, unknown>[];
}

async function mockAi(
  page: Page,
  opts: { usage?: unknown; extract?: (body: Record<string, unknown>) => { status: number; body: unknown } } = {},
): Promise<Recorded> {
  const rec: Recorded = { usageCalls: 0, bodies: [] };
  await page.route("**/api/ai/usage", async (route: Route) => {
    rec.usageCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(opts.usage ?? USAGE_OK) });
  });
  await page.route("**/api/ai/form-extract", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    rec.bodies.push(body);
    const r = opts.extract?.(body) ?? { status: 500, body: { error: "x", message: "テスト用のエラー" } };
    await route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
  });
  return rec;
}

/** 文字情報のあるPDF（表。標準フォントで書けるよう、英数字のみ） */
async function tablePdf(pages = 1): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    const rows = [
      ["Item", "Qty", "Price"],
      ["Pen", "10", "1200"],
      ["Notebook", "5", "2500"],
    ];
    rows.forEach((r, ri) => r.forEach((c, ci) => p.drawText(c, { x: 50 + ci * 150, y: 760 - ri * 30, size: 12, font })));
  }
  return { name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

async function blankPdf(pages = 1): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

const okExtract = (rows: unknown[]) => () => ({
  status: 200,
  body: { ok: true, model: "standard", rows, notes: [], rejected: 0, usage: USAGE_OK.usage },
});

const RESULT_ROWS = [
  { page: 1, kind: "header", cells: ["Item", "Qty", "Price"], unverified: [] },
  { page: 1, kind: "data", cells: ["Pen", "10", "1200"], unverified: [] },
  { page: 1, kind: "data", cells: ["Notebook", "5", "9999"], unverified: [2] },
];

async function openAndUpload(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto(SLUG);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await expect(page.getByTestId("form-ai-panel")).toBeVisible({ timeout: 60_000 });
}

test.describe("PDF→Excel: AIで表を読み取る（任意・プレミアム）", () => {
  // 開発サーバーの初回コンパイルに時間がかかることがあるため、余裕をもたせる
  test.setTimeout(150_000);

  test("見出しは「AIで表を読み取る」。パネルを開くまでは、利用状況の確認もAIへの送信もしない。通常の変換ボタンはそのまま使える", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await tablePdf());
    await expect(page.getByTestId("form-ai-panel")).toContainText("AIで表を読み取る（任意）");
    await expect(page.getByRole("button", { name: "Excelに変換する" })).toBeVisible();
    await page.waitForTimeout(500);
    expect(rec.usageCalls).toBe(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("同意が必要。送るのは文字だけで、目的は table。結果の原文に無い数字は目立ち、直してExcelを受け取れる", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await tablePdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-preview")).toContainText("Notebook", { timeout: 30_000 });
    await expect(page.getByTestId("form-ai-run")).toBeDisabled();
    await page.getByTestId("form-ai-consent").check();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-row")).toHaveCount(3);

    expect(rec.bodies).toHaveLength(1);
    const sent = rec.bodies[0] as { purpose: string; consent: unknown; pages: { text: string }[] };
    expect(sent.purpose).toBe("table");
    expect(sent.consent).toEqual({ accepted: true, version: FORM_CONSENT_VERSION });
    expect(sent.pages[0].text).toContain("Notebook");
    expect(Object.keys(sent).sort()).toEqual(["consent", "model", "pages", "purpose", "requestId"]);
    await expect(page.getByTestId("form-ai-consent")).not.toBeChecked();

    await expect(page.getByTestId("form-ai-unverified-note")).toBeVisible();
    await page.getByTestId("form-ai-row").nth(2).locator("input").nth(2).fill("2500");
    await expect(page.getByTestId("form-ai-unverified-note")).toHaveCount(0);
    await page.getByTestId("form-ai-make-excel").click();
    await expect(page.getByTestId("form-ai-excel-result")).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("form-ai-download").click()]);
    expect(download.suggestedFilename()).toBe("invoice_AI読み取り.xlsx");
    expect(fs.statSync((await download.path())!).size).toBeGreaterThan(1000);
  });

  test("プレミアムでない場合は理由を示し、実行の入口を出さない", async ({ page }) => {
    const rec = await mockAi(page, { usage: { available: false, reason: "not_premium" } });
    await openAndUpload(page, await tablePdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-panel")).toContainText("プレミアムプランの機能です");
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("スキャンPDF: 画像とOCRの文字（参考）を画面に出し、同意すると画像つきで送る。結果の原文に無い数字は目立つ", async ({ page }) => {
    const rec = await mockAi(page, {
      extract: okExtract([
        { page: 1, kind: "header", cells: ["Name", "Score"], unverified: [] },
        { page: 1, kind: "data", cells: ["Alice", "10"], unverified: [] },
        { page: 1, kind: "data", cells: ["Bob", "28"], unverified: [1] },
      ]),
    });
    await openAndUpload(page, { name: "scanned.pdf", mimeType: "application/pdf", buffer: fs.readFileSync(fixtures.pdfToExcelScannedTablePdf) });
    await page.getByTestId("form-ai-toggle").click();
    // OCRと画像化は端末の中で行う（時間がかかる）
    await expect(page.getByTestId("form-ai-image")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("form-ai-preview")).toContainText("スキャンした画像");
    await expect(page.getByTestId("form-ai-count")).toContainText("送る画像：1枚");
    await expect(page.getByTestId("form-ai-preview")).toContainText("OCRが読み取った参考");
    await expect(page.getByTestId("form-ai-consent")).toBeVisible();
    await expect(page.getByText("スキャンしたページの画像）を、AI（OpenAI）に送って読み取ることに同意します")).toBeVisible();
    expect(rec.bodies).toHaveLength(0);
    await expect(page.getByTestId("form-ai-run")).toBeDisabled();
    await page.getByTestId("form-ai-consent").check();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-row")).toHaveCount(3);

    expect(rec.bodies).toHaveLength(1);
    const sent = rec.bodies[0] as { purpose: string; consent: unknown; pages: { page: number; text: string; image?: { mediaType: string; base64: string } }[] };
    expect(sent.purpose).toBe("table");
    expect(sent.consent).toEqual({ accepted: true, version: FORM_CONSENT_VERSION });
    expect(Object.keys(sent).sort()).toEqual(["consent", "model", "pages", "purpose", "requestId"]);
    expect(sent.pages).toHaveLength(1);
    expect(Object.keys(sent.pages[0]).sort()).toEqual(["image", "page", "text"]);
    expect(sent.pages[0].image?.mediaType).toBe("image/jpeg");
    // JPEGのデータ（base64で /9j/ から始まる）。元のPDFそのものではない
    expect(sent.pages[0].image?.base64.startsWith("/9j/")).toBe(true);
    expect(Object.keys(sent.pages[0].image ?? {}).sort()).toEqual(["base64", "mediaType"]);
    expect((sent.pages[0].image?.base64.length ?? 0) * 0.75).toBeLessThan(750_000);
    expect(sent.pages[0].text).toMatch(/Alice/i);
    await expect(page.getByTestId("form-ai-unverified-note")).toContainText("OCR");
  });

  test("文字がまったく読めないスキャンページでも、画像だけで送れる（OCRの文字は空）", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await blankPdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-image")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("form-ai-preview")).toContainText("文字を読み取れませんでした（画像だけを送ります）");
    await page.getByTestId("form-ai-consent").check();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-row")).toHaveCount(3);
    const sent = rec.bodies[0] as { pages: { text: string; image?: unknown }[] };
    expect(sent.pages[0].text).toBe("");
    expect(sent.pages[0].image).toBeDefined();
  });

  test("スキャンしたページが5ページあると、画像は4ページまでと案内し、AIには何も送らない", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await blankPdf(5));
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-problem")).toContainText("4ページまで", { timeout: 120_000 });
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("6ページ以上のPDFは対象外と案内し（表示は1つだけ）、AIには何も送らない", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await tablePdf(6));
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-problem")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("form-ai-problem")).toContainText("5ページまで");
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });
});
