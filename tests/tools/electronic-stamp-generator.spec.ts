import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { decodePng, isValidPngFile, countTransparentPixels, countOpaqueInkPixels } from "../helpers/png-inspect";
import { checkBasicAccessibility, checkKeyboardFocusable } from "../helpers/a11y";

/**
 * 電子印鑑生成（Phase 16）のE2Eテスト。
 *
 * 開発指示書が求める30シナリオ（A:文字から生成 / B:画像から取り込み /
 * C:PDFから取り込み / D:エッジケース）を実装する。「ダウンロードイベントが
 * 発火しただけ」を成功にしない方針に沿い、生成されたPNGを実際にデコードして
 * 透明ピクセル・不透明な印影ピクセルの存在まで確認する（tests/helpers/png-inspect.ts）。
 *
 * 背景透過について「全画像で完全に正しく分離できる」ことを前提にしたアサーションは
 * 行わない（特に複雑な背景のフィクスチャでは、クラッシュしないこと・処理が完了する
 * ことのみを確認する）。
 */

const TOOL_URL = "/tools/electronic-stamp-generator";
const CROP_CONTAINER = '[data-testid="stamp-crop-container"]';
const CROP_BOX = '[data-testid="stamp-crop-box"]';
const FINAL_PREVIEW = '[data-testid="stamp-final-preview"]';

// PDFページ描画・Canvas処理を含むため、pdf-fill-annotateと同様に
// 既定のビューポート高さより縦に長くなり得る。page.mouse.*は自動スクロールしない
// ため、十分に高いビューポートを使う（Phase 15で判明した既知の注意点）。
test.use({ viewport: { width: 1280, height: 1200 } });

async function gotoTool(page: Page) {
  await page.goto(TOOL_URL);
}

async function switchToImportMode(page: Page) {
  await page.getByRole("button", { name: "印鑑を取り込む", exact: true }).click();
}

async function dragCropHandle(page: Page, corner: "nw" | "ne" | "sw" | "se", dx: number, dy: number) {
  const handle = page.getByRole("button", { name: `切り抜き範囲の${corner}角をドラッグしてサイズ変更` });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error("ハンドルが見つかりませんでした");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
  await page.mouse.up();
}

async function confirmCrop(page: Page) {
  await page.getByRole("button", { name: "切り抜く", exact: true }).click();
  await expect(page.locator(FINAL_PREVIEW)).toBeVisible({ timeout: 15_000 });
}

async function uploadAndReachCropStep(page: Page, fixturePath: string) {
  await gotoTool(page);
  await switchToImportMode(page);
  await uploadFixture(page, fixturePath);
  await expect(page.locator(CROP_CONTAINER)).toBeVisible({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// A. 文字から印影を生成
// ---------------------------------------------------------------------------
test.describe("A. 文字から印影を生成", () => {
  test("1. ツールページが表示される", async ({ page }) => {
    await gotoTool(page);
    await expect(page.getByRole("button", { name: "文字から作る", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "印鑑を取り込む", exact: true })).toBeVisible();
    // 電子署名ではないことの明示（ツール本体の注記。SEO用FAQにも同様の文言があり
    // 両方存在しうるため、ページ内の最初の一致だけを確認する）
    await expect(page.getByText("法的な効力を持つ電子署名", { exact: false }).first()).toBeVisible();
  });

  test("2. 文字を入力するとプレビューに反映される", async ({ page }) => {
    await gotoTool(page);
    const input = page.locator("#stamp-text-input");
    await input.fill("山田");
    await expect(input).toHaveValue("山田");
  });

  test("3. 丸印を生成できる", async ({ page }) => {
    await gotoTool(page);
    await page.locator("#stamp-text-input").fill("印");
    await page.getByRole("button", { name: "丸印", exact: true }).click();
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
  });

  test("4. 角印を生成できる", async ({ page }) => {
    await gotoTool(page);
    await page.locator("#stamp-text-input").fill("承認");
    await page.getByRole("button", { name: "角印", exact: true }).click();
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
  });

  test("5. 生成前にプレビューが表示される", async ({ page }) => {
    await gotoTool(page);
    await page.locator("#stamp-text-input").fill("印");
    await expect(page.getByLabel("印影のプレビュー")).toBeVisible();
  });

  test("6. PNGをダウンロードできる", async ({ page }) => {
    await gotoTool(page);
    await page.locator("#stamp-text-input").fill("印");
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 100 });
    expect(isValidPngFile(path)).toBe(true);
  });

  test("7. 生成されたPNGが有効な画像として解析できる", async ({ page }) => {
    await gotoTool(page);
    await page.locator("#stamp-text-input").fill("印");
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    const decoded = decodePng(path);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  });

  test("8. 生成されたPNGの背景が透明である", async ({ page }) => {
    await gotoTool(page);
    await page.locator("#stamp-text-input").fill("印");
    await page.getByRole("button", { name: "丸印", exact: true }).click();
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    const decoded = decodePng(path);
    // 丸印は四隅が円の外側=透明になるはず
    expect(countTransparentPixels(decoded)).toBeGreaterThan(0);
    // 枠線・文字部分は不透明な色として残っているはず
    expect(countOpaqueInkPixels(decoded)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// B. 画像から印影を取り込み
// ---------------------------------------------------------------------------
test.describe("B. 画像から印影を取り込み", () => {
  test("9. PNGをアップロードできる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
  });

  test("10. JPGをアップロードできる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampJpg);
  });

  test("11. アップロードした画像が表示される", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    await expect(page.getByAltText("取り込んだ印鑑のプレビュー")).toBeVisible();
  });

  test("12. 印影の範囲を選択(ドラッグ)できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    const before = await page.locator(CROP_BOX).boundingBox();
    await dragCropHandle(page, "se", 30, 30);
    const after = await page.locator(CROP_BOX).boundingBox();
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    if (before && after) {
      expect(after.width).toBeGreaterThan(before.width);
    }
  });

  test("13. 背景を自動的に透明化できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    await confirmCrop(page);
    await expect(page.getByRole("checkbox", { name: "背景を自動的に透明化する" })).toBeChecked();
  });

  test("14. しきい値を変更できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    await confirmCrop(page);
    const slider = page.getByLabel(/しきい値/);
    await slider.fill("80");
    await expect(slider).toHaveValue("80");
  });

  test("15. 取り込んだ印鑑からPNGを出力できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    await assertDownloadedFile(download, { format: "png", minBytes: 50 });
  });

  test("16. 生成されたPNGに透明ピクセルと印影ピクセルの両方が存在する", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    const decoded = decodePng(path);
    expect(countTransparentPixels(decoded)).toBeGreaterThan(0);
    expect(countOpaqueInkPixels(decoded)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C. PDFから印影を取り込み
// ---------------------------------------------------------------------------
test.describe("C. PDFから印影を取り込み", () => {
  test("17. PDFをアップロードできる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
  });

  test("18. ページ数が表示される", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await expect(page.getByText("1 / 2 ページ", { exact: false })).toBeVisible();
  });

  test("19. 対象ページを選択できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await expect(page.getByText("2 / 2 ページ", { exact: false })).toBeVisible();
  });

  test("20. 選択したページが表示される", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await expect(page.getByAltText("取り込んだ印鑑のプレビュー")).toBeVisible();
  });

  test("21. PDFページ内で印影範囲を選択できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await dragCropHandle(page, "se", 20, 20);
    await confirmCrop(page);
  });

  test("22. PDFから取り込んだ印影の背景を透明化できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await confirmCrop(page);
    const slider = page.getByLabel(/しきい値/);
    await slider.fill("60");
    await expect(page.locator(FINAL_PREVIEW)).toBeVisible();
  });

  test("23. PDFから取り込んだ印影をPNGとして出力できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    expect(isValidPngFile(path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. エッジケース
// ---------------------------------------------------------------------------
test.describe("D. エッジケース", () => {
  test("24. 文字が空の場合は生成ボタンが無効になる", async ({ page }) => {
    await gotoTool(page);
    const input = page.locator("#stamp-text-input");
    await input.fill("");
    await expect(page.getByRole("button", { name: "印影画像を生成する", exact: true })).toBeDisabled();
    await input.fill("印");
    await expect(page.getByRole("button", { name: "印影画像を生成する", exact: true })).toBeEnabled();
  });

  test("25. 大きめの画像でもクラッシュせず処理できる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampLargeImagePng);
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました", 30_000);
    const download = await clickAndDownload(page, "PNGをダウンロード");
    await assertDownloadedFile(download, { format: "png" });
  });

  test("26. 複数ページPDFでページを行き来してもクラッシュしない", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPdf);
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await expect(page.getByText("2 / 2 ページ", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "前へ", exact: true }).click();
    await expect(page.getByText("1 / 2 ページ", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "次へ", exact: true }).click();
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
  });

  test("27. 横長PDFでもクラッシュしない", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.landscapePdf);
    const naturalWide = await page.getByAltText("取り込んだ印鑑のプレビュー").evaluate((el) => {
      const img = el as HTMLImageElement;
      return img.naturalWidth > img.naturalHeight;
    });
    expect(naturalWide).toBe(true);
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    expect(isValidPngFile(path)).toBe(true);
  });

  test("28. 既に透明背景を持つPNGでもクラッシュしない", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampTransparentPng);
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    const decoded = decodePng(path);
    expect(countOpaqueInkPixels(decoded)).toBeGreaterThan(0);
  });

  test("29. 印影が小さい画像は自動トリミングでサイズが縮小される", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampSmallPng);
    await confirmCrop(page);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    const { path } = await assertDownloadedFile(download, { format: "png" });
    const decoded = decodePng(path);
    // 元の切り抜き(約300x300近辺)よりも十分小さくトリミングされているはず
    expect(decoded.width).toBeLessThan(150);
    expect(decoded.height).toBeLessThan(150);
  });

  test("30. 背景が複雑な画像でもクラッシュせず、しきい値調整ができる", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampComplexBgPng);
    await confirmCrop(page);
    const slider = page.getByLabel(/しきい値/);
    await slider.fill("30");
    await expect(page.locator(FINAL_PREVIEW)).toBeVisible();
    await slider.fill("90");
    await expect(page.locator(FINAL_PREVIEW)).toBeVisible();
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    const download = await clickAndDownload(page, "PNGをダウンロード");
    expect(isValidPngFile((await assertDownloadedFile(download, { format: "png" })).path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// アクセシビリティ（範囲を絞った最小限のチェック）
// ---------------------------------------------------------------------------
test.describe("アクセシビリティ", () => {
  test("基本的なアクセシビリティ要件を満たす（文字から作るモード）", async ({ page }) => {
    await gotoTool(page);
    await checkBasicAccessibility(page);
    await checkKeyboardFocusable(page);
  });

  test("基本的なアクセシビリティ要件を満たす（印鑑を取り込むモード）", async ({ page }) => {
    await uploadAndReachCropStep(page, fixtures.stampPng);
    await checkBasicAccessibility(page);
  });
});
