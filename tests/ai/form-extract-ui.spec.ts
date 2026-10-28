import type { Page, Route } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { FORM_CONSENT_VERSION } from "@/lib/ai/form-extract";

/**
 * 記入済みPDF→Excel: 「AIで項目を読み取る」パネルのE2Eテスト。
 * AIのAPI（/api/ai/*）はテスト内で差し替える。実際のOpenAI・Stripe・Supabaseには接続しない。
 * 実際のAIの読み取り精度・消費トークンは、このテストでは確認できない。
 */

const SLUG = "/tools/filled-pdf-to-excel";
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

/** 文字情報のあるPDF（標準フォントで書けるよう、英数字のみ） */
async function textPdf(pages = 1): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText("Name", { x: 50, y: 760, size: 12, font });
    p.drawText("Taro Yamada", { x: 250, y: 760, size: 12, font });
    p.drawText("Address", { x: 50, y: 730, size: 12, font });
    p.drawText("Tokyo Chiyoda 1-1", { x: 250, y: 730, size: 12, font });
  }
  return { name: "application.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

/** 文字情報のない（空白だけの）PDF＝スキャンしたPDFの代わり */
async function blankPdf(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save()) };
}

const okExtract = (rows: unknown[], notes: string[] = []) => () => ({
  status: 200,
  body: { ok: true, model: "standard", rows, notes, rejected: 0, usage: USAGE_OK.usage },
});

const RESULT_ROWS = [
  { page: 1, kind: "header", cells: ["項目", "内容"], unverified: [0, 1] },
  { page: 1, kind: "data", cells: ["Name", "Taro Yamada"], unverified: [] },
  { page: 1, kind: "data", cells: ["Address", "Osaka Kita 9-9"], unverified: [1] },
];

async function openAndUpload(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto(SLUG);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await expect(page.getByTestId("form-ai-panel")).toBeVisible({ timeout: 60_000 });
}

test.describe("記入済みPDF→Excel: AIで項目を読み取る（任意・プレミアム）", () => {
  test("同意が必要: 送る内容を確認し、同意するまで実行できない。送るのは文字だけで、同意は実行のたびに外れる", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await textPdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-preview")).toContainText("Taro Yamada", { timeout: 30_000 });
    await expect(page.getByTestId("form-ai-count")).toContainText("送るページ：1ページ");
    await expect(page.getByTestId("form-ai-run")).toBeDisabled();
    expect(rec.bodies).toHaveLength(0);

    await page.getByTestId("form-ai-consent").check();
    await expect(page.getByTestId("form-ai-run")).toBeEnabled();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-result")).toBeVisible();

    expect(rec.bodies).toHaveLength(1);
    const sent = rec.bodies[0] as { model: string; pages: { page: number; text: string }[]; consent: unknown; file?: unknown; images?: unknown };
    expect(sent.consent).toEqual({ accepted: true, version: FORM_CONSENT_VERSION });
    expect(sent.model).toBe("standard");
    expect(sent.pages).toHaveLength(1);
    expect(sent.pages[0].text).toContain("Taro Yamada");
    expect(sent.file).toBeUndefined();
    expect(sent.images).toBeUndefined();
    expect(Object.keys(sent).sort()).toEqual(["consent", "model", "pages", "requestId"]);
    await expect(page.getByTestId("form-ai-consent")).not.toBeChecked();
  });

  test("結果: 原文に見つからないセルは目立たせて注意を出す。直すと確認済みになり、Excelは完了の画面で受け取れる", async ({ page }) => {
    await mockAi(page, { extract: okExtract(RESULT_ROWS, ["住所の一部が読み取りにくい部分がありました"]) });
    await openAndUpload(page, await textPdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-preview")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("form-ai-consent").check();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-row")).toHaveCount(3);
    await expect(page.getByTestId("form-ai-note")).toContainText("読み取りにくい部分");
    await expect(page.getByTestId("form-ai-unverified-note")).toBeVisible();
    const rows = page.getByTestId("form-ai-row");
    await expect(rows.nth(0)).toHaveAttribute("data-kind", "header");
    await expect(rows.nth(1)).toHaveAttribute("data-kind", "data");

    // 利用者が直すと、確認済みとして注意が消える
    await rows.nth(2).locator("input").nth(1).fill("Tokyo Chiyoda 1-1");
    await expect(page.getByTestId("form-ai-unverified-note")).toHaveCount(1); // ヘッダー行の注意が残る
    await rows.nth(0).locator("input").nth(0).fill("Item");
    await rows.nth(0).locator("input").nth(1).fill("Value");
    await expect(page.getByTestId("form-ai-unverified-note")).toHaveCount(0);

    await page.getByTestId("form-ai-make-excel").click();
    await expect(page.getByTestId("form-ai-excel-result")).toBeVisible();
    await expect(page.getByTestId("result-popup-overlay").first()).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("form-ai-download").click()]);
    expect(download.suggestedFilename()).toBe("application_AI読み取り.xlsx");
    const saved = await download.path();
    expect(fs.statSync(saved).size).toBeGreaterThan(1000);
  });

  test("利用できない状態: プレミアムでない・ログインしていない場合は、理由を示し、実行の入口を出さない", async ({ page }) => {
    for (const [reason, text] of [
      ["not_premium", "プレミアムプランの機能です"],
      ["login_required", "ログインが必要です"],
    ] as const) {
      const rec = await mockAi(page, { usage: { available: false, reason } });
      await openAndUpload(page, await textPdf());
      await page.getByTestId("form-ai-toggle").click();
      await expect(page.getByTestId("form-ai-panel")).toContainText(text);
      await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
      expect(rec.bodies).toHaveLength(0);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("文字のないPDF（スキャン）は対象外と案内し、AIには何も送らない", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await blankPdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-problem")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("form-ai-problem")).toContainText("OCR");
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("6ページ以上のPDFは対象外と案内する", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await textPdf(6));
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-problem")).toContainText("5ページまで", { timeout: 30_000 });
    await expect(page.getByTestId("form-ai-run")).toHaveCount(0);
    expect(rec.bodies).toHaveLength(0);
  });

  test("AIが失敗しても、エラーを示し、ほかの変換は使える。同意は外れる", async ({ page }) => {
    await mockAi(page, { extract: () => ({ status: 502, body: { ok: false, error: "model_failed", message: "AIの処理に失敗しました。もう一度お試しください。" } }) });
    await openAndUpload(page, await textPdf());
    await page.getByTestId("form-ai-toggle").click();
    await expect(page.getByTestId("form-ai-preview")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("form-ai-consent").check();
    await page.getByTestId("form-ai-run").click();
    await expect(page.getByTestId("form-ai-error")).toContainText("AIの処理に失敗しました");
    await expect(page.getByTestId("form-ai-consent")).not.toBeChecked();
    await expect(page.getByTestId("form-ai-result")).toHaveCount(0);
  });

  test("パネルを開くまでは、AIの利用状況の確認も、AIへの送信もしない", async ({ page }) => {
    const rec = await mockAi(page, { extract: okExtract(RESULT_ROWS) });
    await openAndUpload(page, await textPdf());
    await page.waitForTimeout(500);
    expect(rec.usageCalls).toBe(0);
    expect(rec.bodies).toHaveLength(0);
  });
});
