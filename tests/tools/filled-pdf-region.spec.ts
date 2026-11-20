import type { Page, Route } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { waitHydrated } from "../helpers/hydrated";
import { fieldDisplayId } from "@/lib/pdf-template/types";
import { PERSON_A, PERSON_B, PERSON_C, PERSON_D, TEMPLATE_FIELDS, type TemplateFieldSpec } from "../fixtures/template-layout";

/**
 * 記入済みPDF→Excel：記入済みのPDFの上で、そのまま取り出す場所を囲む（2026-11-20）。
 * モードの切り替えなし。空のひな形は使わない。囲まなければ、おまかせで整理する。
 */

const CANVAS = '[data-testid="template-canvas"]';

async function open(page: Page, file: string) {
  await page.goto("/tools/filled-pdf-to-excel");
  const input = page.locator('input[type="file"]').first();
  await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible({ timeout: 30_000 });
  await waitHydrated(page.getByTestId("filled-pdf-blank-template-toggle"));
  await input.setInputFiles(file);
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 30_000 });
}

/** 1枚目の上をクリックして四角を置き、数値で位置・大きさ・名前を合わせる（1人目の項目） */
async function placeField(page: Page, spec: TemplateFieldSpec, order: number) {
  await page.locator(CANVAS).evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    window.scrollBy(0, -160);
  });
  // 置いた四角と重ならない所をクリックする
  await page.locator(CANVAS).click({ position: { x: 20, y: 20 + order * 30 } });
  const badge = fieldDisplayId(1, order);
  await page.getByLabel(`X (${badge})`).fill(String(spec.x));
  await page.getByLabel(`Y (${badge})`).fill(String(spec.y));
  await page.getByLabel(`幅 (${badge})`).fill(String(spec.width));
  await page.getByLabel(`高さ (${badge})`).fill(String(spec.height));
  await page.getByLabel(`項目名 (${badge})`).fill(spec.label);
}

test.describe("記入済みPDF→Excel：記入済みのPDFの上で場所を囲む", () => {
  test.setTimeout(120_000);

  test("モードを選ばずに、1枚目の上をクリックして囲み、全部のページの同じ場所を一覧にできる（2ページ・1ページに2人分）", async ({ page }) => {
    await open(page, fixtures.templateFilledMultiPagePdf);
    // モードの切り替えはない。囲むまでは「おまかせ」のボタン
    await expect(page.getByRole("button", { name: "自動抽出" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "おまかせでExcelに変換する" })).toBeVisible();
    await expect(page.getByTestId("filled-region-record-pages")).toHaveValue("1");

    // 1人目の「生年月日」「住所」（見出しの文字が枠の外にある項目）を囲む
    const [, birth, address] = TEMPLATE_FIELDS;
    await placeField(page, birth, 1);
    await placeField(page, address, 2);
    // 囲むと「おまかせ」のボタンは消え、案内が出る
    await expect(page.getByRole("button", { name: "おまかせでExcelに変換する" })).toHaveCount(0);
    await expect(page.getByTestId("filled-pdf-region-note")).toBeVisible();

    // 2人目を追加して、同じ項目を囲む
    await page.getByRole("button", { name: "+ 人物を追加" }).click();
    const p2 = TEMPLATE_FIELDS.filter((f) => f.personIndex === 2 && f.label !== "氏名");
    for (const [i, spec] of p2.entries()) {
      await page.locator("div").filter({ hasText: "2人目" }).last().getByRole("button", { name: "項目を追加" }).click();
      await page.locator(CANVAS).click({ position: { x: 300, y: 20 + i * 30 } });
      const badge = fieldDisplayId(2, i + 1);
      await page.getByLabel(`X (${badge})`).fill(String(spec.x));
      await page.getByLabel(`Y (${badge})`).fill(String(spec.y));
      await page.getByLabel(`幅 (${badge})`).fill(String(spec.width));
      await page.getByLabel(`高さ (${badge})`).fill(String(spec.height));
      await page.getByLabel(`項目名 (${badge})`).fill(spec.label);
    }

    await page.getByTestId("filled-region-run").click();
    await expect(page.getByText("合計ページ数: 2")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("出力人数: 4")).toBeVisible();
    await expect(page.getByLabel("1人目 生年月日")).toHaveValue(PERSON_A.生年月日);
    await expect(page.getByLabel("1人目 住所")).toHaveValue(PERSON_A.住所);
    await expect(page.getByLabel("2人目 生年月日")).toHaveValue(PERSON_B.生年月日);
    // 2ページ目にも同じ場所を当てはめる
    await expect(page.getByLabel("3人目 住所")).toHaveValue(PERSON_C.住所);
    await expect(page.getByLabel("4人目 生年月日")).toHaveValue(PERSON_D.生年月日);

    const wait = page.waitForEvent("download");
    await page.getByRole("button", { name: "Excelをダウンロード" }).click();
    expect((await wait).suggestedFilename()).toMatch(/\.xlsx$/);
    // 場所を指定し直せる
    await page.getByRole("button", { name: "場所を指定し直す" }).click();
    await expect(page.locator(CANVAS)).toBeVisible();
  });

  test("四角を消すと、おまかせで整理するボタンに戻る。置いた四角の上のクリックでは、新しい四角を作らない", async ({ page }) => {
    await open(page, fixtures.templateFilledPdf);
    await placeField(page, TEMPLATE_FIELDS[1], 1);
    await expect(page.locator('[data-testid^="template-field-"]')).toHaveCount(1);
    await page.locator(`[data-testid="template-field-${fieldDisplayId(1, 1)}"]`).click();
    await expect(page.locator('[data-testid^="template-field-"]')).toHaveCount(1);
    await page.getByRole("button", { name: "削除", exact: true }).last().click();
    await expect(page.locator('[data-testid^="template-field-"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "おまかせでExcelに変換する" })).toBeVisible();
  });

  test("指定した場所をAIで読み取る：囲んだ枠の画像だけをAIに送り、結果を一覧に入れる（スキャンしたPDF・AIは偽の応答）", async ({ page }) => {
    const usage = { limitAiTokens: 30_000_000, usedAiTokens: 0, remainingAiTokens: 30_000_000, periodEnd: "2026-11-30T00:00:00Z" };
    await page.route("**/api/ai/usage", (route: Route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ available: true, usage }) }),
    );
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/ai/form-extract", async (route: Route) => {
      const body = route.request().postDataJSON() as { pages: { page: number }[] };
      bodies.push(body as unknown as Record<string, unknown>);
      const rows = body.pages.map((p) => ({ page: p.page, kind: "data", cells: [`2010年4月${p.page}日`, `神戸市中央区${p.page}-1`], unverified: [] }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, model: "standard", rows, notes: [], rejected: 0, usage }) });
    });

    await open(page, fixtures.templateFilledScannedPdf);
    const [, birth, address] = TEMPLATE_FIELDS;
    await placeField(page, birth, 1);
    await placeField(page, address, 2);
    // 場所を囲んだときは、ページ全体をAIに送るパネルは出さない
    await expect(page.getByTestId("form-ai-panel")).toHaveCount(0);

    await page.getByTestId("filled-region-run-ai").click();
    // 端末内のOCRはとばし、AIのパネルが開いた状態で一覧が出る
    await expect(page.getByTestId("region-ai-panel")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("region-ai-image")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("region-ai-count")).toContainText("送る件数：1件");
    await page.getByTestId("region-ai-consent").check();
    await page.getByTestId("region-ai-run").click();
    await expect(page.getByTestId("region-ai-done")).toContainText("1件をAIで読み取り");
    await expect(page.getByLabel("1人目 生年月日")).toHaveValue("2010年4月1日");
    await expect(page.getByLabel("1人目 住所")).toHaveValue("神戸市中央区1-1");

    expect(bodies).toHaveLength(1);
    const sent = bodies[0] as { purpose: string; fields: string[]; pages: { image?: { mediaType: string } }[] };
    expect(sent.purpose).toBe("region");
    expect(sent.fields).toEqual([birth.label, address.label]);
    expect(sent.pages).toHaveLength(1);
    expect(sent.pages[0].image?.mediaType).toBe("image/jpeg");
  });
});
