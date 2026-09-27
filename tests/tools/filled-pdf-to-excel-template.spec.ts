import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { fieldDisplayId } from "@/lib/pdf-template/types";
import {
  TEMPLATE_FIELDS,
  THREE_PERSON_TEMPLATE_FIELDS,
  SCANNED_TEMPLATE_FIELDS,
  SCANNED_TEMPLATE_FIELDS_PERSON2,
  type TemplateFieldSpec,
} from "../fixtures/template-layout";

/**
 * 記入されたPDF→Excel「テンプレートモード」（Phase 18）のE2Eテスト。
 *
 * 既存の自動抽出モードのテスト（tests/tools/work.spec.ts）はsmokeレベルに
 * 留めている（多段階ウィザードUI・広告ゲートの自動化の難しさが理由。同ファイル
 * 冒頭のコメント参照）が、テンプレートモードはウィザードの各ステップが
 * 数値入力（X/Y/幅/高さ）で構成されており、premium-testフィクスチャ経由で
 * 課金ゲートも越えられるため、実際に「テンプレート登録 → 記入済みPDFの
 * アップロード → 抽出 → プレビュー → Excelダウンロード」まで一気通貫で
 * 検証するフルE2Eとして書く（「ダウンロードイベントが発火しただけ」を
 * 成功と見なさない方針に沿い、tests/helpers/xlsx-inspect.ts で生成された
 * XLSXの実際のセル内容まで確認する）。
 *
 * テンプレートへ登録する枠の座標は、tests/fixtures/template-layout.ts の
 * 定義（フィクスチャPDF生成にも使われている、単一の情報源）をそのまま使い、
 * 「フィクスチャPDF内の実際の印字位置」と「テストが登録する入力枠の位置」が
 * 食い違わないようにしている。
 */

const CANVAS = '[data-testid="template-canvas"]';
// クリックしてもどの枠の最終位置とも重ならない、キャンバス左上の安全地帯。
// 各フィールドはクリック直後にX/Y/幅/高さの数値入力で正確な位置へ移動させるため、
// クリック位置そのものの座標精度は重要ではない。
const SAFE_CLICK_POSITION = { x: 20, y: 20 } as const;

async function openTemplateTool(page: Page) {
  await page.goto("/tools/filled-pdf-to-excel");
  // 既存の自動抽出モードのsmokeテスト(tests/tools/work.spec.ts)で明記されている
  // 既知の環境要因: このツールが静的importしているwrite-excel-file起因のチャンクを
  // `next dev`(Turbopack)が初回リクエスト時にオンデマンドコンパイルするため、
  // このページへの最初のアクセス時だけ数秒〜まれに30秒超まで初期化が遅延することがある
  // （本番ビルドでは再現しない、テスト環境固有の揺らぎ）。既存smokeテストと同じく
  // 既定の10秒より長いタイムアウトを与える。
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

/** 1つの入力枠を作成し、正確な位置・大きさ・ラベル名を数値入力で設定する */
async function addField(page: Page, spec: TemplateFieldSpec) {
  await personBlock(page, spec.personIndex).getByRole("button", { name: "項目を追加" }).click();
  await page.locator(CANVAS).click({ position: SAFE_CLICK_POSITION });

  const badge = fieldDisplayId(spec.personIndex, spec.fieldIndex);
  await page.getByLabel(`X (${badge})`).fill(String(spec.x));
  await page.getByLabel(`Y (${badge})`).fill(String(spec.y));
  await page.getByLabel(`幅 (${badge})`).fill(String(spec.width));
  await page.getByLabel(`高さ (${badge})`).fill(String(spec.height));
  await page.getByLabel(`項目名 (${badge})`).fill(spec.label);
}

/** 複数人・複数項目の入力枠をまとめて登録する（人物は必要な数だけ自動で追加する） */
async function registerFields(page: Page, specs: TemplateFieldSpec[]) {
  const personIndexes = Array.from(new Set(specs.map((s) => s.personIndex))).sort((a, b) => a - b);
  // handleTemplateSelect実行直後は1人目が既定で存在するため、2人目以降だけ追加する
  // （呼び出し側は常に1,2,3...と連番のpersonIndexを渡す前提）。
  for (const personIndex of personIndexes) {
    if (personIndex === 1) continue;
    await addPerson(page);
  }
  const sorted = [...specs].sort((a, b) => a.personIndex - b.personIndex || a.fieldIndex - b.fieldIndex);
  for (const spec of sorted) {
    await addField(page, spec);
  }
}

async function proceedToConfirm(page: Page) {
  await page.getByRole("button", { name: "テンプレート確認へ" }).click();
  await expect(page.getByRole("button", { name: "テンプレートを確定して記入済みPDFへ進む" })).toBeVisible();
}

async function confirmTemplate(page: Page) {
  await page.getByRole("button", { name: "テンプレートを確定して記入済みPDFへ進む" }).click();
  // captureFixedTextForTemplate はテンプレートPDF自身の各枠を読み直す非同期処理
  // （OCRフォールバックを含みうる）のため、既存テストの余裕を踏まえ長めに待つ。
  await expect(page.getByText("記入済みのPDFをドラッグ&ドロップ")).toBeVisible({ timeout: 30_000 });
}

async function uploadFilledAndRun(page: Page, filePathOrPaths: string | string[]) {
  await page.locator('input[type="file"]').first().setInputFiles(filePathOrPaths);
  const runButton = page.getByRole("button", { name: "抽出する" });
  await expect(runButton).toBeEnabled({ timeout: 20_000 });
  await runButton.click();
  await expect(page.getByText(/出力人数: \d+/)).toBeVisible({ timeout: 45_000 });
}

async function registerAndConfirm(page: Page, blankPdfPath: string, specs: TemplateFieldSpec[]) {
  await openTemplateTool(page);
  await uploadBlankTemplate(page, blankPdfPath);
  await registerFields(page, specs);
  await proceedToConfirm(page);
  await confirmTemplate(page);
}

// ---------------------------------------------------------------------
// テンプレート作成
// ---------------------------------------------------------------------
test.describe("テンプレート作成", () => {
  test("空のテンプレートPDFを登録し、人物・項目を追加してラベル名を設定できる", async ({ page }) => {
    await openTemplateTool(page);
    await uploadBlankTemplate(page, fixtures.templateBlankPdf);

    // 1人目は既定で存在する。項目を1つ追加する。
    await addField(page, TEMPLATE_FIELDS[0]);
    await expect(page.locator(`[data-testid="template-field-${fieldDisplayId(1, 1)}"]`)).toBeVisible();
    await expect(page.getByLabel(`項目名 (${fieldDisplayId(1, 1)})`)).toHaveValue("氏名");

    // 人物を追加できる
    await addPerson(page);
    await expect(personBlock(page, 2)).toBeVisible();

    await expect(page.getByRole("button", { name: "テンプレート確認へ" })).toBeEnabled();
  });

  test("モード切替(自動抽出⇔テンプレート)でUIが正しく切り替わる", async ({ page }) => {
    await page.goto("/tools/filled-pdf-to-excel");
    // 既知の環境要因(このページの初回コンパイル遅延。openTemplateTool()のコメント参照)
    // を踏まえ、初回表示だけ長めのタイムアウトを与える。
    await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "テンプレート", exact: false }).click();
    await expect(page.getByText("空のテンプレートPDFをドラッグ&ドロップ")).toBeVisible();

    await page.getByRole("button", { name: "自動抽出", exact: false }).click();
    await expect(page.getByText("PDFをドラッグ&ドロップ", { exact: true })).toBeVisible();
  });

  test("入力枠をドラッグで移動できる", async ({ page }) => {
    await openTemplateTool(page);
    await uploadBlankTemplate(page, fixtures.templateBlankPdf);
    await addField(page, TEMPLATE_FIELDS[0]);

    const badge = fieldDisplayId(1, 1);
    const xInput = page.getByLabel(`X (${badge})`);
    const yInput = page.getByLabel(`Y (${badge})`);
    const beforeX = Number(await xInput.inputValue());
    const beforeY = Number(await yInput.inputValue());

    const box = await page.locator(`[data-testid="template-field-${badge}"]`).boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 5 });
      await page.mouse.up();
    }

    const afterX = Number(await xInput.inputValue());
    const afterY = Number(await yInput.inputValue());
    // 画面上を右・下へドラッグ: PDF座標系(原点左下)ではXは増加、Yは減少する。
    expect(afterX).toBeGreaterThan(beforeX);
    expect(afterY).toBeLessThan(beforeY);
  });

  test("入力枠をリサイズできる", async ({ page }) => {
    await openTemplateTool(page);
    await uploadBlankTemplate(page, fixtures.templateBlankPdf);
    await addField(page, TEMPLATE_FIELDS[0]);

    const badge = fieldDisplayId(1, 1);
    const widthInput = page.getByLabel(`幅 (${badge})`);
    const heightInput = page.getByLabel(`高さ (${badge})`);
    const beforeWidth = Number(await widthInput.inputValue());
    const beforeHeight = Number(await heightInput.inputValue());

    const handle = page.locator(`[data-testid="template-field-${badge}"]`).locator(".cursor-nwse-resize");
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (handleBox) {
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 60, handleBox.y + 20, { steps: 5 });
      await page.mouse.up();
    }

    const afterWidth = Number(await widthInput.inputValue());
    const afterHeight = Number(await heightInput.inputValue());
    expect(afterWidth).toBeGreaterThan(beforeWidth);
    expect(afterHeight).not.toBe(beforeHeight);
  });
});

// ---------------------------------------------------------------------
// 抽出
// ---------------------------------------------------------------------
test.describe("抽出", () => {
  test("1ページ2人分を正しく抽出できる（1人あたり複数項目・固定文字の除外を含む）", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledPdf);

    await expect(page.getByText("出力人数: 2")).toBeVisible();
    await expect(page.getByText("空欄のため除外", { exact: false })).toHaveCount(0);
    await expect(page.getByText("OCRを使用しました")).toHaveCount(0);

    // person1の「氏名」欄はPDF上でラベル「氏名：」を枠内に含む位置にしている
    // （tests/fixtures/template-layout.tsの設計）。固定文字が正しく除外され、
    // 記入値だけが残っていることを確認する（開発指示書16章）。
    await expect(page.getByLabel("1人目 氏名")).toHaveValue("山田太郎");
    await expect(page.getByLabel("1人目 生年月日")).toHaveValue("1990/01/01");
    await expect(page.getByLabel("1人目 住所")).toHaveValue("大阪府大阪市北区1-2-3");
    await expect(page.getByLabel("2人目 氏名")).toHaveValue("佐藤花子");
    await expect(page.getByLabel("2人目 生年月日")).toHaveValue("1992/05/20");
    await expect(page.getByLabel("2人目 住所")).toHaveValue("京都府京都市中京区4-5-6");
  });

  test("1ページ3人分を正しく抽出できる", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, THREE_PERSON_TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledThreePersonPdf);

    await expect(page.getByText("出力人数: 3")).toBeVisible();
    await expect(page.getByLabel("3人目 氏名")).toHaveValue("鈴木一郎");
    await expect(page.getByLabel("3人目 生年月日")).toHaveValue("1985/03/15");
    await expect(page.getByLabel("3人目 住所")).toHaveValue("愛知県名古屋市中区7-8-9");
  });

  test("複数ページのPDFに同じテンプレートを周期的に適用できる（合計4人）", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledMultiPagePdf);

    await expect(page.getByText("合計ページ数: 2")).toBeVisible();
    await expect(page.getByText("出力人数: 4")).toBeVisible();
    // 2ページ目(鈴木一郎・田中恵子)にも同じテンプレートが適用されていること
    await expect(page.getByLabel("3人目 氏名")).toHaveValue("鈴木一郎");
    await expect(page.getByLabel("4人目 氏名")).toHaveValue("田中恵子");
  });

  test("ほとんどの項目が空欄の人物は自動的に出力から除外される", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledEmptySecondPdf);

    await expect(page.getByText("出力人数: 1")).toBeVisible();
    await expect(page.getByText("空欄のため除外: 1人")).toBeVisible();
    await expect(page.getByLabel("1人目 氏名")).toHaveValue("山田太郎");
  });

  test("テキストレイヤーが無いスキャンPDFはOCRにフォールバックする", async ({ page }) => {
    test.setTimeout(120_000);
    const scannedFields = [...SCANNED_TEMPLATE_FIELDS, ...SCANNED_TEMPLATE_FIELDS_PERSON2];
    await registerAndConfirm(page, fixtures.templateBlankScannedPdf, scannedFields);
    await uploadFilledAndRun(page, fixtures.templateFilledScannedPdf);

    await expect(page.getByText("OCRを使用しました")).toBeVisible();
    await expect(page.getByText("出力人数: 2")).toBeVisible();

    const name1 = ((await page.getByLabel("1人目 NAME").inputValue()) ?? "").toUpperCase();
    const addr1 = ((await page.getByLabel("1人目 ADDR").inputValue()) ?? "").toUpperCase();
    expect(name1).toContain("YAMADA");
    expect(addr1.replace(/\s+/g, "")).toContain("OSAKA");
  });
});

// ---------------------------------------------------------------------
// Excel出力
// ---------------------------------------------------------------------
test.describe("Excel出力", () => {
  test("1行=1人でExcelが生成され、列名が項目名と一致する", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledPdf);

    const download = await clickAndDownload(page, "Excelをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });

    const { headers, rows } = await readXlsxSheet(path);
    expect(headers).toEqual(["氏名", "生年月日", "住所"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(["山田太郎", "1990/01/01", "大阪府大阪市北区1-2-3"]);
    expect(rows[1]).toEqual(["佐藤花子", "1992/05/20", "京都府京都市中京区4-5-6"]);
  });

  test("複数の記入済みPDFをまとめて1つのExcelに出力できる", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, [fixtures.templateFilledPdf, fixtures.templateFilledEmptySecondPdf]);

    // 1つ目のPDF(2人とも記入あり)+2つ目のPDF(1人目のみ記入あり、2人目は除外)=3人
    await expect(page.getByText("出力人数: 3")).toBeVisible();
    await expect(page.getByText("空欄のため除外: 1人")).toBeVisible();

    const download = await clickAndDownload(page, "Excelをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
    const { rows } = await readXlsxSheet(path);
    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r[0]);
    expect(names).toEqual(["山田太郎", "佐藤花子", "山田太郎"]);
  });
});

// ---------------------------------------------------------------------
// UX
// ---------------------------------------------------------------------
test.describe("UX", () => {
  test("抽出中は「抽出する」ボタンが再度押せない状態になる（二重実行防止）", async ({ page }) => {
    // 1件の抽出に一定の時間がかかる、6項目・2人分のテンプレートを使うことで、
    // 「クリック直後に本当にボタンが無効化されているか」を確認する余裕を持たせる。
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await page.locator('input[type="file"]').first().setInputFiles(fixtures.templateFilledPdf);

    const runButton = page.getByRole("button", { name: "抽出する" });
    await expect(runButton).toBeEnabled({ timeout: 20_000 });
    await runButton.click();

    // クリック直後、同期的にボタンが無効化される(consumeUsage()の応答待ち中も含む。
    // 開発指示書41章の二重実行防止)ため、すぐにもう一度クリックしようとしても
    // Playwrightのアクショナビリティ待機(要素が有効になるのを待つ)がタイムアウトする。
    await expect(runButton.click({ timeout: 3_000 })).rejects.toThrow();

    // 二重に処理が走っていれば人数が4人(2倍)になってしまうが、正しくは2人のまま。
    await expect(page.getByText("出力人数: 2")).toBeVisible({ timeout: 45_000 });
  });

  test("読み込めないPDFを選択するとエラーメッセージが表示され、処理は始まらない", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, [TEMPLATE_FIELDS[0]]);

    await page.locator('input[type="file"]').first().setInputFiles({
      name: "invalid.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("これはPDFファイルではありません"),
    });

    // 表示される具体的な文言はpdf.js側のエラーメッセージ次第で変わりうるため、
    // 汎用的なエラー表示領域(role="alert"、tests/components/common/error-message.tsx)
    // が出ること・処理が始められない状態のままであることを確認する。
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^合計ページ数: \d+ページ$/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "抽出する" })).toBeDisabled();
  });

  test("抽出結果をプレビュー画面で直接編集でき、Excelのダウンロード内容に反映される", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, TEMPLATE_FIELDS);
    await uploadFilledAndRun(page, fixtures.templateFilledPdf);

    const nameInput = page.getByLabel("1人目 氏名");
    await expect(nameInput).toHaveValue("山田太郎");
    await nameInput.fill("修正済み太郎");

    const download = await clickAndDownload(page, "Excelをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
    const { rows } = await readXlsxSheet(path);
    expect(rows[0][0]).toBe("修正済み太郎");
  });

  test("最初からやり直すボタンでテンプレート登録からやり直せる", async ({ page }) => {
    await registerAndConfirm(page, fixtures.templateBlankPdf, [TEMPLATE_FIELDS[0]]);
    await uploadFilledAndRun(page, fixtures.templateFilledPdf);

    await page.getByRole("button", { name: "最初からやり直す" }).click();
    await expect(page.getByText("空のテンプレートPDFをドラッグ&ドロップ")).toBeVisible();
  });
});
