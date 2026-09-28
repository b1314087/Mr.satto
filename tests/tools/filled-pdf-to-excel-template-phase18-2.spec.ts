import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { fieldDisplayId } from "@/lib/pdf-template/types";
import {
  TEMPLATE_FIELDS,
  TEMPLATE_PAGE,
  CHECKBOX_TEMPLATE_FIELDS,
  CHECKBOX_PERSON_NAME,
  ADJACENT_TEMPLATE_FIELDS,
  ADJACENT_PERSON,
  type TemplateFieldSpec,
} from "../fixtures/template-layout";

/**
 * Phase 18.2「文書変換品質・印刷再現性 集中改善」A節（filled-pdf-to-excel）の
 * 専用E2Eテスト（開発指示書K-1、A-25）。
 *
 * 既存のPhase 18テスト（tests/tools/filled-pdf-to-excel-template.spec.ts）が
 * カバーしていない、今回追加・修正した範囲だけを対象にする:
 * - ズーム(80/100/150/200%・往復)で入力枠がPDF実座標の位置からずれないこと(A-3〜A-8)
 * - checkbox枠のルールベース判定(A-19、checked/unchecked)
 * - 隙間なく隣接するtext枠でも、文字が正しい側だけに割り当てられること(A-11/A-12)
 *
 * ヘルパー関数は既存スペックと同じ実装を踏襲しているが、既存の動作中テストへの
 * 不要な変更を避けるため、あえてこのファイル内に独立して持たせている。
 */

const CANVAS = '[data-testid="template-canvas"]';
const SAFE_CLICK_POSITION = { x: 20, y: 20 } as const;

async function openTemplateTool(page: Page) {
  await page.goto("/tools/filled-pdf-to-excel");
  await expect(page.getByRole("button", { name: "テンプレート", exact: false })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "テンプレート", exact: false }).click();
  await expect(page.getByText("空のテンプレートPDFをドラッグ&ドロップ")).toBeVisible({ timeout: 30_000 });
}

async function uploadBlankTemplate(page: Page, filePath: string) {
  await page.locator('input[type="file"]').first().setInputFiles(filePath);
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 15_000 });
}

function personBlock(page: Page, personIndex: number) {
  return page.locator("div").filter({ hasText: `${personIndex}人目` }).last();
}

async function addPerson(page: Page) {
  await page.getByRole("button", { name: "+ 人物を追加" }).click();
}

async function setFieldType(page: Page, badge: string, type: "text" | "checkbox") {
  await page.getByLabel(`種類 (${badge})`).selectOption(type);
}

async function addField(page: Page, spec: TemplateFieldSpec, type: "text" | "checkbox" = "text") {
  await personBlock(page, spec.personIndex).getByRole("button", { name: "項目を追加" }).click();
  await page.locator(CANVAS).click({ position: SAFE_CLICK_POSITION });

  const badge = fieldDisplayId(spec.personIndex, spec.fieldIndex);
  await page.getByLabel(`X (${badge})`).fill(String(spec.x));
  await page.getByLabel(`Y (${badge})`).fill(String(spec.y));
  await page.getByLabel(`幅 (${badge})`).fill(String(spec.width));
  await page.getByLabel(`高さ (${badge})`).fill(String(spec.height));
  await page.getByLabel(`項目名 (${badge})`).fill(spec.label);
  if (type === "checkbox") {
    await setFieldType(page, badge, "checkbox");
  }
}

async function registerFields(page: Page, specs: TemplateFieldSpec[], types: Record<string, "text" | "checkbox"> = {}) {
  const personIndexes = Array.from(new Set(specs.map((s) => s.personIndex))).sort((a, b) => a - b);
  for (const personIndex of personIndexes) {
    if (personIndex === 1) continue;
    await addPerson(page);
  }
  const sorted = [...specs].sort((a, b) => a.personIndex - b.personIndex || a.fieldIndex - b.fieldIndex);
  for (const spec of sorted) {
    const badge = fieldDisplayId(spec.personIndex, spec.fieldIndex);
    await addField(page, spec, types[badge] ?? "text");
  }
}

async function proceedToConfirm(page: Page) {
  await page.getByRole("button", { name: "テンプレート確認へ" }).click();
  await expect(page.getByRole("button", { name: "テンプレートを確定して記入済みPDFへ進む" })).toBeVisible();
}

async function confirmTemplate(page: Page) {
  await page.getByRole("button", { name: "テンプレートを確定して記入済みPDFへ進む" }).click();
  await expect(page.getByText("記入済みのPDFをドラッグ&ドロップ")).toBeVisible({ timeout: 30_000 });
}

async function uploadFilledAndRun(page: Page, filePathOrPaths: string | string[]) {
  await page.locator('input[type="file"]').first().setInputFiles(filePathOrPaths);
  const runButton = page.getByRole("button", { name: "抽出する" });
  await expect(runButton).toBeEnabled({ timeout: 20_000 });
  await runButton.click();
  await expect(page.getByText(/出力人数: \d+/)).toBeVisible({ timeout: 45_000 });
}

async function registerAndConfirm(
  page: Page,
  blankPdfPath: string,
  specs: TemplateFieldSpec[],
  types: Record<string, "text" | "checkbox"> = {}
) {
  await openTemplateTool(page);
  await uploadBlankTemplate(page, blankPdfPath);
  await registerFields(page, specs, types);
  await proceedToConfirm(page);
  await confirmTemplate(page);
}

// ---------------------------------------------------------------------
// 座標（A-3〜A-8）
// ---------------------------------------------------------------------
test.describe("座標: ズームによる入力枠の位置ずれ修正", () => {
  test("80%/100%/150%/200%を行き来しても、入力枠の画面上の位置がPDF実座標どおりに再計算される", async ({ page }) => {
    await openTemplateTool(page);
    await uploadBlankTemplate(page, fixtures.templateBlankPdf);
    const spec = TEMPLATE_FIELDS[0]; // x=40, y=615, width=240, height=20
    await addField(page, spec);

    const badge = fieldDisplayId(1, 1);
    const fieldLocator = page.locator(`[data-testid="template-field-${badge}"]`);
    const xInput = page.getByLabel(`X (${badge})`);
    const yInput = page.getByLabel(`Y (${badge})`);

    // 100%表示の時点での位置を基準値として取得する
    await page.getByTestId("zoom-100").click();
    await expect.poll(async () => Math.round(await fieldLocator.evaluate((el) => parseFloat((el as HTMLElement).style.left))))
      .toBeGreaterThanOrEqual(0);

    const pageHeight = TEMPLATE_PAGE.height;

    // 100% → 150% → 80% → 200% → 100% と往復させる(開発指示書A-5)
    for (const zoom of [150, 80, 200, 100] as const) {
      await page.getByTestId(`zoom-${zoom}`).click();
      const scale = zoom / 100;
      const expectedLeft = spec.x * scale;
      const expectedTop = (pageHeight - spec.y - spec.height) * scale;

      await expect
        .poll(async () => Math.round(await fieldLocator.evaluate((el) => parseFloat((el as HTMLElement).style.left))), {
          timeout: 10_000,
        })
        .toBe(Math.round(expectedLeft));
      await expect
        .poll(async () => Math.round(await fieldLocator.evaluate((el) => parseFloat((el as HTMLElement).style.top))), {
          timeout: 10_000,
        })
        .toBe(Math.round(expectedTop));

      // 枠が保持するPDF実座標そのもの(X/Y/幅/高さの数値入力)は、ズームでは一切変化しない
      expect(Number(await xInput.inputValue())).toBe(spec.x);
      expect(Number(await yInput.inputValue())).toBe(spec.y);
    }
  });

  test("150%表示で作成した枠を100%表示に戻しても、記入済みPDFからの抽出結果は正しい(見た目のズレが実データへ影響しないことの確認)", async ({
    page,
  }) => {
    await openTemplateTool(page);
    await uploadBlankTemplate(page, fixtures.templateBlankPdf);

    // 150%表示のまま枠を作成する(クリック位置からPDF実座標への変換がズーム後も正しいことの確認)
    await page.getByTestId("zoom-150").click();
    await addField(page, TEMPLATE_FIELDS[0]);
    // 作成後にさらにズームを変えても数値は変化しない
    await page.getByTestId("zoom-80").click();
    await page.getByTestId("zoom-100").click();

    await registerFields(page, [TEMPLATE_FIELDS[1], TEMPLATE_FIELDS[2]]);
    await proceedToConfirm(page);
    await confirmTemplate(page);
    await uploadFilledAndRun(page, fixtures.templateFilledPdf);

    await expect(page.getByLabel("1人目 氏名")).toHaveValue("山田太郎");
    await expect(page.getByLabel("1人目 生年月日")).toHaveValue("1990/01/01");
  });
});

// ---------------------------------------------------------------------
// 抽出: 隣接Field分離（A-11/A-12）
// ---------------------------------------------------------------------
test.describe("抽出: 隣接するFieldの分離", () => {
  test("隙間なく隣接する2つの枠でも、文字が正しい側だけに割り当てられる", async ({ page }) => {
    const [field1, field2] = ADJACENT_TEMPLATE_FIELDS;
    await registerAndConfirm(page, fixtures.templateBlankAdjacentPdf, ADJACENT_TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledAdjacentPdf);

    await expect(page.getByLabel(`1人目 ${field1.label}`)).toHaveValue(ADJACENT_PERSON.氏名);
    await expect(page.getByLabel(`1人目 ${field2.label}`)).toHaveValue(ADJACENT_PERSON.住所);
  });
});

// ---------------------------------------------------------------------
// checkbox（A-19）
// ---------------------------------------------------------------------
test.describe("checkbox枠のルールベース判定", () => {
  test("チェックあり(黒く塗りつぶされた枠)を正しくTRUEと判定する", async ({ page }) => {
    const [nameField, checkboxField] = CHECKBOX_TEMPLATE_FIELDS;
    await registerAndConfirm(page, fixtures.templateBlankCheckboxPdf, CHECKBOX_TEMPLATE_FIELDS, {
      [fieldDisplayId(checkboxField.personIndex, checkboxField.fieldIndex)]: "checkbox",
    });
    await uploadFilledAndRun(page, fixtures.templateFilledCheckboxCheckedPdf);

    await expect(page.getByLabel(`1人目 ${nameField.label}`)).toHaveValue(CHECKBOX_PERSON_NAME);
    await expect(page.getByLabel(`1人目 ${checkboxField.label}`)).toHaveValue("TRUE");
  });

  test("チェックなし(枠のみ、塗りつぶしなし)を正しく未チェックと判定する", async ({ page }) => {
    const [nameField, checkboxField] = CHECKBOX_TEMPLATE_FIELDS;
    await registerAndConfirm(page, fixtures.templateBlankCheckboxPdf, CHECKBOX_TEMPLATE_FIELDS, {
      [fieldDisplayId(checkboxField.personIndex, checkboxField.fieldIndex)]: "checkbox",
    });
    await uploadFilledAndRun(page, fixtures.templateFilledCheckboxUncheckedPdf);

    await expect(page.getByLabel(`1人目 ${nameField.label}`)).toHaveValue(CHECKBOX_PERSON_NAME);
    await expect(page.getByLabel(`1人目 ${checkboxField.label}`)).toHaveValue("");
  });

  test("checkboxの判定結果は結果プレビュー画面で手動修正できる(A-18/A-24)", async ({ page }) => {
    const [, checkboxField] = CHECKBOX_TEMPLATE_FIELDS;
    await registerAndConfirm(page, fixtures.templateBlankCheckboxPdf, CHECKBOX_TEMPLATE_FIELDS, {
      [fieldDisplayId(checkboxField.personIndex, checkboxField.fieldIndex)]: "checkbox",
    });
    await uploadFilledAndRun(page, fixtures.templateFilledCheckboxUncheckedPdf);

    const checkboxInput = page.getByLabel(`1人目 ${checkboxField.label}`);
    await expect(checkboxInput).toHaveValue("");
    await checkboxInput.fill("TRUE");
    await expect(checkboxInput).toHaveValue("TRUE");
  });
});
