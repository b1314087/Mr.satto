import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";
import { checkBasicAccessibility, checkKeyboardFocusable } from "../helpers/a11y";

/**
 * PDF記入・注釈（Phase 15）のE2Eテスト。
 *
 * 開発指示書が求める最低限19シナリオ（ツールページ表示～モバイル表示まで）に加え、
 * 「ダウンロードイベントが発火しただけ」を成功にしない方針に沿って、生成された
 * PDFを実際にパースしてページ数・追加したテキスト（日本語含む）・座標の妥当性まで
 * 検証する。座標変換（画面ピクセル⇔PDF座標）はズーム率（50/100/150%）を変えても
 * 同じ位置に書き出されることを回帰確認する。
 */

const CANVAS = '[data-testid="pdf-annotate-canvas"]';
const OBJECT_LIST = '[data-testid="pdf-annotate-object-list"]';

// キャンバス（PDFページのプレビュー）は既定のビューポート高さ(720px)より縦に長くなることが
// あり、その状態でpage.mouse.*を使った手書きドラッグを行うと、スクロール位置によっては
// キャンバス上端がビューポート外（Y座標が負）になってクリック・ドラッグが失敗する
// （.click()と異なりpage.mouse.*は自動スクロールしないため）。モバイル表示テストの
// 意図的な小さいビューポートとは別に、通常のテストではスクロールを気にしなくて済むよう
// 十分に高いビューポートを使う。
test.use({ viewport: { width: 1280, height: 1400 } });

async function openToolWithPdf(page: Page, fixturePath: string) {
  await page.goto("/tools/pdf-fill-annotate");
  await uploadFixture(page, fixturePath);
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 15_000 });
}

async function clickCanvasAt(page: Page, x: number, y: number) {
  await page.locator(CANVAS).click({ position: { x, y } });
}

async function dragOnCanvas(page: Page, points: { x: number; y: number }[]) {
  const canvas = page.locator(CANVAS);
  // page.mouse.*はビューポート座標を使い、.click()と異なり自動スクロールしないため、
  // キャンバスが画面外（フォールド外）にある場合は先に明示的にスクロールしておく。
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("キャンバスが見つかりませんでした");
  await page.mouse.move(box.x + points[0].x, box.y + points[0].y);
  await page.mouse.down();
  for (const p of points.slice(1)) {
    await page.mouse.move(box.x + p.x, box.y + p.y, { steps: 4 });
  }
  await page.mouse.up();
}

async function exportAndDownload(page: Page) {
  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await waitForSuccess(page, "書き出しが完了しました");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
  expect(isValidPdfFile(path)).toBe(true);
  return path;
}

// (1) ツールページ表示
test("ツールページが表示される", async ({ page }) => {
  const response = await page.goto("/tools/pdf-fill-annotate");
  expect(response?.status()).toBe(200);
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.getByRole("heading", { name: "PDF記入・注釈" })).toBeVisible();
});

// (2)(3) PDFアップロード・単一ページ表示
test("PDFをアップロードするとページが表示される（単一ページ）", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await expect(page.getByText("1 / 1ページ")).toBeVisible();
  await expect(page.getByAltText(/1ページ目のプレビュー/)).toBeVisible();
});

// (4) 複数ページのPDF表示・ページ送り
test("複数ページのPDFではページ送りができる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.multiPagePdf);
  await expect(page.getByText("1 / 3ページ")).toBeVisible();

  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(page.getByText("2 / 3ページ")).toBeVisible();
  await expect(page.getByAltText(/2ページ目のプレビュー/)).toBeVisible();

  await page.getByRole("button", { name: "前のページ" }).click();
  await expect(page.getByText("1 / 3ページ")).toBeVisible();
});

// (5) テキスト追加
test("テキストを追加して内容を編集できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 60, 80);

  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  const textInput = page.locator(OBJECT_LIST).locator('textarea').first();
  await textInput.fill("テスト入力ABC123");
  await expect(textInput).toHaveValue("テスト入力ABC123");
});

// (6) テキスト移動
test("テキストを配置し直す（移動）ことができる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 40, 60);

  const objectDiv = page.locator(CANVAS).locator("div").first();
  const before = await objectDiv.boundingBox();

  await page.locator(OBJECT_LIST).getByRole("button", { name: "移動" }).click();
  await clickCanvasAt(page, 200, 220);

  const after = await objectDiv.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0))).toBeGreaterThan(50);
});

// (7) テキスト削除
test("テキストを削除できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 50, 50);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

  await page.locator(OBJECT_LIST).getByRole("button", { name: "削除" }).click();
  await expect(page.getByText(/配置した注釈/)).toHaveCount(0);
});

// (8) チェックボックス追加
test("チェックボックスを追加してON/OFFを切り替えられる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "チェック", exact: true }).click();
  await clickCanvasAt(page, 80, 100);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

  const checkboxInput = page.locator(OBJECT_LIST).locator('input[type="checkbox"]').first();
  await expect(checkboxInput).not.toBeChecked();
  await checkboxInput.check();
  await expect(checkboxInput).toBeChecked();
});

// (9) チェックボックス削除
test("チェックボックスを削除できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "チェック", exact: true }).click();
  await clickCanvasAt(page, 70, 70);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

  await page.locator(OBJECT_LIST).getByRole("button", { name: "削除" }).click();
  await expect(page.getByText(/配置した注釈/)).toHaveCount(0);
});

// (10) 手書き入力
test("ドラッグで手書き入力できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "手書き", exact: true }).click();
  await dragOnCanvas(page, [
    { x: 30, y: 30 },
    { x: 60, y: 60 },
    { x: 90, y: 40 },
  ]);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
});

// (11) 手書き削除
test("手書きを削除できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "手書き", exact: true }).click();
  await dragOnCanvas(page, [
    { x: 30, y: 30 },
    { x: 70, y: 70 },
  ]);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

  await page.locator(OBJECT_LIST).getByRole("button", { name: "削除" }).click();
  await expect(page.getByText(/配置した注釈/)).toHaveCount(0);
});

test("消しゴムで手書きを削除できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "手書き", exact: true }).click();
  await dragOnCanvas(page, [
    { x: 30, y: 30 },
    { x: 70, y: 70 },
  ]);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

  await page.getByRole("button", { name: "消しゴム" }).click();
  await page.locator(CANVAS).click({ position: { x: 50, y: 50 } });
  await expect(page.getByText(/配置した注釈/)).toHaveCount(0);
});

// (12) 画像追加
test("画像を追加できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "画像", exact: true }).click();
  await page.locator('input[type="file"]').last().setInputFiles(fixtures.png);
  await expect(page.getByText(/PDF上をクリックして画像を配置してください/)).toBeVisible();

  await clickCanvasAt(page, 100, 120);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  await expect(page.getByAltText("配置した画像")).toBeVisible();
});

// (13) 画像の移動・リサイズ
test("画像を移動・リサイズできる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "画像", exact: true }).click();
  await page.locator('input[type="file"]').last().setInputFiles(fixtures.png);
  await clickCanvasAt(page, 60, 60);

  const imageBox = page.getByAltText("配置した画像");
  const beforeSize = await imageBox.boundingBox();

  const widthInput = page.locator(OBJECT_LIST).locator('input[type="number"]').first();
  await widthInput.fill("40");
  await widthInput.blur();

  const afterSize = await imageBox.boundingBox();
  expect(beforeSize).not.toBeNull();
  expect(afterSize).not.toBeNull();
  expect(Math.abs(afterSize!.width - beforeSize!.width)).toBeGreaterThan(2);

  // 移動（縮小した画像の範囲の外側の位置をクリックする。画像自身の上をクリックすると
  // 画像自身のonClickにイベントが吸収され、キャンバス側の再配置ロジックに届かないため）
  await page.locator(OBJECT_LIST).getByRole("button", { name: "移動" }).click();
  await clickCanvasAt(page, 550, 750);
  const afterMove = await imageBox.boundingBox();
  expect(Math.abs(afterMove!.x - afterSize!.x)).toBeGreaterThan(30);
});

// (14)(15) PDF書き出し・ダウンロード、(16) 生成PDFの妥当性
test("PDFを書き出してダウンロードでき、生成されたPDFが妥当である", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 50, 50);
  await page.locator(OBJECT_LIST).locator('textarea').first().fill("E2E-EXPORT-CHECK");
  await page.locator(OBJECT_LIST).locator('textarea').first().blur();

  const downloadPath = await exportAndDownload(page);
  const extracted = await extractPdfContent(downloadPath);
  expect(extracted.pageCount).toBe(1);
  expect(extracted.text).toContain("E2E-EXPORT-CHECK");
});

// (17) ページ数が保持される
test("元のPDFのページ数が書き出し後も保持される", async ({ page }) => {
  await openToolWithPdf(page, fixtures.multiPagePdf);
  await page.getByRole("button", { name: "チェック", exact: true }).click();
  await clickCanvasAt(page, 50, 50);

  const downloadPath = await exportAndDownload(page);
  const extracted = await extractPdfContent(downloadPath);
  expect(extracted.pageCount).toBe(3);
  // 元のPDFの本文（1ページ目のフィクスチャ文言）が消えていないことも確認する
  expect(extracted.text).toContain("Mr.Satto test fixture - page 1");
});

// (18) 日本語出力の確認
test("日本語のテキストが文字化けせずにPDFへ出力される", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 50, 100);
  const input = page.locator(OBJECT_LIST).locator('textarea').first();
  await input.fill("日本語テストABC123あいうえお");
  await input.blur();

  const downloadPath = await exportAndDownload(page);
  const extracted = await extractPdfContent(downloadPath);
  expect(extracted.text).toContain("日本語テストABC123あいうえお");
});

// 日付挿入（現在日付の自動入力をしないこと、明示的に選んだ日付だけが反映されることの確認）
test("日付は自動入力されず、選択した日付だけがテキストに反映される", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 50, 50);

  const row = page.locator(OBJECT_LIST).locator("li").first();
  const textInput = row.locator('textarea').first();
  await expect(textInput).toHaveValue(""); // 自動入力されていないこと

  await row.locator('input[type="date"]').fill("2026-09-27");
  await row.getByRole("button", { name: "日付を挿入" }).click();
  await expect(textInput).toHaveValue("2026/09/27");
});

// 座標変換の回帰確認（50%/100%/150%で、PDL上の「同じ相対位置」をクリックしたときの
// 書き出し位置がズレないこと）。
//
// 注意: 表示倍率が変わると、キャンバスの描画サイズ自体が変わる（例:
// 100%表示の640pxが50%表示では320pxになる）ため、「画面上の同じピクセル座標」を
// クリックしても指しているPDF上の位置は倍率ごとに異なる（これは正しい仕様であり
// バグではない）。そのため、ここでは各倍率でのキャンバスの実際の描画サイズを
// 取得し、「ページに対する同じ相対位置（例: 幅の30%・高さの25%の位置）」を
// クリックすることで、倍率が変わってもPDF上の絶対位置が一致するかを検証する。
test("表示倍率(50%/100%/150%)を変えても、PDF上の同じ相対位置に書き出せる", async ({ page }) => {
  const positions: Record<number, { x: number; y: number }> = {};
  const FRACTION_X = 0.3;
  const FRACTION_Y = 0.25;

  for (const zoom of [100, 50, 150]) {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: `${zoom}%`, exact: true }).click();
    await page.getByRole("button", { name: "テキスト", exact: true }).click();

    const box = await page.locator(CANVAS).boundingBox();
    expect(box, `ズームレベル${zoom}%でキャンバスのサイズが取得できませんでした`).toBeTruthy();
    await page.locator(CANVAS).click({ position: { x: box!.width * FRACTION_X, y: box!.height * FRACTION_Y } });

    const input = page.locator(OBJECT_LIST).locator('textarea').first();
    await input.fill(`Z${zoom}`);
    await input.blur();

    const downloadPath = await exportAndDownload(page);
    const extracted = await extractPdfContent(downloadPath);
    // テキストは1文字ずつ描画されるため、先頭の"Z"の座標を配置位置の代表点として使う
    const zChar = extracted.pages[0].items.find((i) => i.str === "Z");
    expect(zChar, `ズームレベル${zoom}%でテキストの座標が取得できませんでした`).toBeTruthy();
    positions[zoom] = { x: zChar!.x, y: zChar!.y };
  }

  // ページに対する同じ相対位置をクリックした場合、表示倍率が変わってもPDF上の
  // 絶対座標はほぼ一致するはず（変換式がpageRenderScaleに対して一貫しているため）。
  const tolerance = 3; // pt単位の許容誤差（丸め・コンテナ幅の測定誤差を吸収）
  expect(Math.abs(positions[50].x - positions[100].x)).toBeLessThan(tolerance);
  expect(Math.abs(positions[50].y - positions[100].y)).toBeLessThan(tolerance);
  expect(Math.abs(positions[150].x - positions[100].x)).toBeLessThan(tolerance);
  expect(Math.abs(positions[150].y - positions[100].y)).toBeLessThan(tolerance);
});

// (19) モバイル表示
test.describe("モバイル表示", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("モバイル幅でもPDFの表示・記入・書き出しができる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await clickCanvasAt(page, 40, 40);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    const downloadPath = await exportAndDownload(page);
    expect(isValidPdfFile(downloadPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// エッジケース（開発指示書：画面がクラッシュしないことを確認する）
// ---------------------------------------------------------------------
test.describe("エッジケース", () => {
  test("空欄のテキストのまま書き出しても壊れない（空欄は出力から除外される）", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await clickCanvasAt(page, 50, 50);
    // テキストを入力しないまま書き出す
    const downloadPath = await exportAndDownload(page);
    expect(isValidPdfFile(downloadPath)).toBe(true);
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("非常に長いテキストを入力してもクラッシュしない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await clickCanvasAt(page, 50, 50);
    const longText = "あ".repeat(600); // 上限(500文字)を超える入力
    const input = page.locator(OBJECT_LIST).locator('textarea').first();
    await input.fill(longText);
    await expect(async () => {
      const value = await input.inputValue();
      expect(value.length).toBeLessThanOrEqual(500);
    }).toPass();
    await input.blur();
    const downloadPath = await exportAndDownload(page);
    expect(isValidPdfFile(downloadPath)).toBe(true);
  });

  test("すばやい追加・削除を繰り返してもクラッシュしない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: "チェック", exact: true }).click();
      await clickCanvasAt(page, 40 + i * 5, 40 + i * 5);
      await page.locator(OBJECT_LIST).getByRole("button", { name: "削除" }).first().click();
    }
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.getByText(/配置した注釈/)).toHaveCount(0);
  });

  test("ページ移動をまたいでも配置した注釈が消えない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.multiPagePdf);
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await clickCanvasAt(page, 50, 50);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    await page.getByRole("button", { name: "次のページ" }).click();
    await expect(page.getByText("2 / 3ページ")).toBeVisible();
    await page.getByRole("button", { name: "前のページ" }).click();
    await expect(page.getByText("1 / 3ページ")).toBeVisible();
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });

  test("横向き(landscape)のPDFでも配置・書き出しができる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.landscapePdf);
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await clickCanvasAt(page, 60, 40);
    const downloadPath = await exportAndDownload(page);
    const extracted = await extractPdfContent(downloadPath);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.pages[0].width).toBeGreaterThan(extracted.pages[0].height);
  });

  test("日本語の文字情報を持つPDFを読み込んでも壊れず、ページ数が保持される", async ({ page }) => {
    await openToolWithPdf(page, fixtures.japanesePdf);
    await expect(page.locator("body")).not.toContainText("Application error");
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await clickCanvasAt(page, 50, 50);
    const downloadPath = await exportAndDownload(page);
    const extracted = await extractPdfContent(downloadPath);
    expect(extracted.pageCount).toBe(1);
    expect(extracted.text).toContain("日本語のテストPDF");
  });

  test("Undo/Redoで直前の操作を取り消し・やり直しできる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await clickCanvasAt(page, 50, 50);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    // ボタンのaria-labelは矢印記号を含まない「元に戻す」/「やり直す」を使う
    await page.getByRole("button", { name: "元に戻す" }).click();
    await expect(page.getByText(/配置した注釈/)).toHaveCount(0);

    await page.getByRole("button", { name: "やり直す" }).click();
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });
});

// ---------------------------------------------------------------------
// アクセシビリティ（最低限）
// ---------------------------------------------------------------------
test("基本的なアクセシビリティ要件を満たす（ボタン・入力欄にラベルがある）", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 50, 50);
  await checkBasicAccessibility(page);
  await checkKeyboardFocusable(page);
});
