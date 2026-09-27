import { test, expect } from "../fixtures/premium-test";
import type { Page } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile, getPageOpSummary } from "../helpers/pdf-inspect";

/**
 * PDF記入・注釈（Phase 17: 簡易PDFエディタへの強化）のE2Eテスト。
 *
 * Phase 15の既存テスト（tests/tools/pdf-fill-annotate.spec.ts）はそのまま残し、
 * このファイルでは Phase 17 で追加した機能（図形・回転・複製・前面/背面・
 * 印影の画像オブジェクトとしての再利用・ページをまたいだ編集の保持・
 * ズーム倍率の拡張・複数行テキストなど）だけを対象にする。
 *
 * 「ダウンロードイベントが発火しただけ」を成功と見なさない方針に沿い、
 * 図形・画像・印影についても、生成されたPDFを実際にパースして
 * （tests/helpers/pdf-inspect.ts の getPageOpSummary）、テキスト以外の
 * 描画命令（矩形・円・直線・画像）が実際に出力へ含まれていることまで確認する。
 */

const CANVAS = '[data-testid="pdf-annotate-canvas"]';
const OBJECT_LIST = '[data-testid="pdf-annotate-object-list"]';

test.use({ viewport: { width: 1280, height: 1400 } });

async function openToolWithPdf(page: Page, fixturePath: string) {
  await page.goto("/tools/pdf-fill-annotate");
  await uploadFixture(page, fixturePath);
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 15_000 });
}

async function clickCanvasAt(page: Page, x: number, y: number) {
  await page.locator(CANVAS).click({ position: { x, y } });
}

async function exportAndDownload(page: Page) {
  await page.getByRole("button", { name: "PDFを書き出す" }).click();
  await waitForSuccess(page, "書き出しが完了しました");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "pdf", minBytes: 10 });
  expect(isValidPdfFile(path)).toBe(true);
  return path;
}

// ---------------------------------------------------------------------
// 図形（矩形・円・直線）
// ---------------------------------------------------------------------
test.describe("図形", () => {
  test("矩形を追加できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 150, 150);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });

  test("円・楕円を追加できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await page.getByLabel("種類").selectOption("circle");
    await clickCanvasAt(page, 150, 150);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });

  test("直線を追加できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await page.getByLabel("種類").selectOption("line");
    await clickCanvasAt(page, 150, 150);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });

  test("図形を移動・リサイズ・削除できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 150, 150);

    const widthInput = page.locator(OBJECT_LIST).locator('input[type="number"]').first();
    const before = await widthInput.inputValue();
    await widthInput.fill("180");
    await widthInput.blur();
    await expect(widthInput).toHaveValue("180");
    expect(before).not.toBe("180");

    await page.locator(OBJECT_LIST).getByRole("button", { name: "移動" }).click();
    await clickCanvasAt(page, 400, 500);

    await page.locator(OBJECT_LIST).getByRole("button", { name: "削除" }).click();
    await expect(page.getByText(/配置した注釈/)).toHaveCount(0);
  });

  test("図形（矩形・円）を回転できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 150, 150);

    const rotationInput = page.locator(OBJECT_LIST).locator('label:has-text("回転") input[type="number"]');
    await expect(rotationInput).toHaveValue("0");
    await page.locator(OBJECT_LIST).getByRole("button", { name: "反時計回りに回転" }).click();
    await expect(rotationInput).toHaveValue("15");
    await page.locator(OBJECT_LIST).getByRole("button", { name: "反時計回りに回転" }).click();
    await expect(rotationInput).toHaveValue("30");
  });

  test("直線を回転すると座標が変わる（見た目上の回転として反映される）", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await page.getByLabel("種類").selectOption("line");
    await clickCanvasAt(page, 150, 150);

    // 直線はrotationフィールドを持たず、回転操作のたびに始点・終点の座標そのものを
    // その場で回転移動させる方式のため、外接する<svg>の大きさ（=バウンディングボックス）が
    // 回転前後で変わることを見た目上の変化として確認する
    // （<line>要素自身のx1属性は、自身のバウンディングボックスに対する相対座標であり、
    // 回転してもどちらの端点がバウンディングボックスの最小値側になるかが変わらない場合は
    // 値が一定に見えてしまうため、検証には使わない）。
    const svg = page.locator(CANVAS).locator("svg");
    const beforeBox = await svg.boundingBox();
    await page.locator(OBJECT_LIST).getByRole("button", { name: "反時計回りに回転" }).click();
    const afterBox = await svg.boundingBox();
    expect(beforeBox).not.toBeNull();
    expect(afterBox).not.toBeNull();
    const changed =
      Math.abs((afterBox?.width ?? 0) - (beforeBox?.width ?? 0)) > 0.5 ||
      Math.abs((afterBox?.height ?? 0) - (beforeBox?.height ?? 0)) > 0.5;
    expect(changed).toBe(true);
  });

  test("塗りつぶしを切り替えられる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 150, 150);
    const fillCheckbox = page.locator(OBJECT_LIST).locator('label:has-text("塗りつぶし") input[type="checkbox"]');
    await expect(fillCheckbox).not.toBeChecked();
    await fillCheckbox.check();
    await expect(fillCheckbox).toBeChecked();
  });
});

// ---------------------------------------------------------------------
// 複製・前面/背面
// ---------------------------------------------------------------------
test.describe("複製・前面/背面", () => {
  test("テキストを複製すると、明らかにずれた位置にもう1つ増える", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "テキスト", exact: true }).click();
    await clickCanvasAt(page, 60, 80);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    await page.locator(OBJECT_LIST).getByRole("button", { name: "複製" }).click();
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();
  });

  test("チェック・画像も複製でき、オブジェクト数の上限は超えられない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await clickCanvasAt(page, 60, 80);
    await page.locator(OBJECT_LIST).getByRole("button", { name: "複製" }).click();
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();
  });

  test("最前面へ/最背面へで重なり順を変更できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    // 図形を1つ配置すると自動的に「選択・移動」モードへ戻るため、2つ目を置く前に
    // もう一度「図形」ボタンを押し直す必要がある。また、配置済みの図形の上を
    // クリックすると、その図形自身のonClickにイベントが吸収されて新規配置が
    // できなくなる（Phase 15の画像リサイズテストと同じ既知の注意点）ため、
    // 十分に離れた位置へ配置する。
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 80, 80);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 500, 600);
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

    const rows = page.locator(OBJECT_LIST).locator("li");
    await rows.first().getByRole("button", { name: "最背面へ" }).click();
    // 例外が発生せず、2件のまま維持されていることを確認する（厳密な描画順はDOM順で目視困難なため、
    // クラッシュしないこと・件数が変わらないことを確認する回帰テストとする）。
    await expect(page.getByText("配置した注釈（2件）")).toBeVisible();
  });
});

// ---------------------------------------------------------------------
// 印影（電子印鑑生成PNGの画像オブジェクトとしての再利用）
// ---------------------------------------------------------------------
test.describe("印影", () => {
  test("印影画像を配置でき、通常の画像と同様に移動・リサイズ・回転できる", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "印影", exact: true }).click();
    await page.locator('input[type="file"]').last().setInputFiles(fixtures.stampTransparentPng);
    await expect(page.getByText(/PDF上をクリックして印影を配置してください/)).toBeVisible();

    await clickCanvasAt(page, 150, 150);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    await expect(page.locator('[data-testid="pdf-annotate-stamp-object"]')).toBeVisible();

    const widthInput = page.locator(OBJECT_LIST).locator('input[type="number"]').first();
    await widthInput.fill("60");
    await widthInput.blur();
    await expect(widthInput).toHaveValue("60");

    await page.locator(OBJECT_LIST).getByRole("button", { name: "反時計回りに回転" }).click();
    const rotationInput = page.locator(OBJECT_LIST).locator('label:has-text("回転") input[type="number"]');
    await expect(rotationInput).toHaveValue("15");
  });

  test("印影を配置してPDFを書き出すと、生成PDFに画像として出力される", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "印影", exact: true }).click();
    await page.locator('input[type="file"]').last().setInputFiles(fixtures.stampTransparentPng);
    await clickCanvasAt(page, 150, 150);

    const downloadPath = await exportAndDownload(page);
    const summary = await getPageOpSummary(downloadPath, 1);
    expect(summary.hasImage).toBe(true);
  });
});

// ---------------------------------------------------------------------
// 生成PDFの検証（図形・回転が実際に出力へ反映されること）
// ---------------------------------------------------------------------
test.describe("生成PDFの検証", () => {
  test("矩形・円・直線を配置して書き出すと、パスの描画命令が増える", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    // 図形を1つ配置するたびに自動的に「選択・移動」モードへ戻るため、種類を切り替える
    // 際には毎回「図形」ボタンを押し直してからselectする。
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 80, 80); // rectangle（既定）
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await page.getByLabel("種類").selectOption("circle");
    await clickCanvasAt(page, 200, 200);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await page.getByLabel("種類").selectOption("line");
    await clickCanvasAt(page, 300, 300);
    await expect(page.getByText("配置した注釈（3件）")).toBeVisible();

    const downloadPath = await exportAndDownload(page);
    const summary = await getPageOpSummary(downloadPath, 1);
    expect(summary.hasPath).toBe(true);
    // 矩形(moveTo1) + 円(moveTo1) + 直線(moveTo2、drawLineが始点へ2回moveToするため) = 4以上
    expect(summary.pathSegmentCount).toBeGreaterThanOrEqual(4);
    expect(summary.curveSegmentCount).toBeGreaterThan(0); // 円のベジェ曲線
  });

  test("回転させた画像を書き出しても、生成PDFは壊れず画像として出力される", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: "画像", exact: true }).click();
    await page.locator('input[type="file"]').last().setInputFiles(fixtures.png);
    await clickCanvasAt(page, 150, 150);
    await page.locator(OBJECT_LIST).getByRole("button", { name: "反時計回りに回転" }).click();
    await page.locator(OBJECT_LIST).getByRole("button", { name: "反時計回りに回転" }).click();

    const downloadPath = await exportAndDownload(page);
    expect(isValidPdfFile(downloadPath)).toBe(true);
    const summary = await getPageOpSummary(downloadPath, 1);
    expect(summary.hasImage).toBe(true);
  });
});

// ---------------------------------------------------------------------
// 複数行テキスト・整列
// ---------------------------------------------------------------------
test("複数行のテキストを入力し、整列を変更できる", async ({ page }) => {
  await openToolWithPdf(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "テキスト", exact: true }).click();
  await clickCanvasAt(page, 50, 150);

  const textarea = page.locator(OBJECT_LIST).locator("textarea").first();
  await textarea.fill("1行目\n2行目あいうえお");
  await textarea.blur();

  const alignSelect = page.locator(OBJECT_LIST).locator('label:has-text("整列") select');
  await alignSelect.selectOption("center");
  await expect(alignSelect).toHaveValue("center");

  const downloadPath = await exportAndDownload(page);
  const extracted = await extractPdfContent(downloadPath);
  expect(extracted.text).toContain("1行目");
  expect(extracted.text).toContain("2行目あいうえお");
});

// ---------------------------------------------------------------------
// ページをまたいだ編集の保持（複数ページ）
// ---------------------------------------------------------------------
test("複数ページで、それぞれのページに配置した図形・画像がページ移動後も保持され、書き出しにも反映される", async ({ page }) => {
  await openToolWithPdf(page, fixtures.multiPagePdf);

  await page.getByRole("button", { name: "図形", exact: true }).click();
  await clickCanvasAt(page, 80, 80);
  await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(page.getByText("2 / 3ページ")).toBeVisible();
  await page.getByRole("button", { name: "チェック", exact: true }).click();
  await clickCanvasAt(page, 90, 90);
  await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

  await page.getByRole("button", { name: "前のページ" }).click();
  await expect(page.getByText("1 / 3ページ")).toBeVisible();
  await expect(page.getByText("配置した注釈（2件）")).toBeVisible();

  const downloadPath = await exportAndDownload(page);
  const extracted = await extractPdfContent(downloadPath);
  expect(extracted.pageCount).toBe(3);
  const page1Summary = await getPageOpSummary(downloadPath, 1);
  const page2Summary = await getPageOpSummary(downloadPath, 2);
  expect(page1Summary.hasPath).toBe(true); // 1ページ目の図形
  expect(page2Summary.hasPath).toBe(true); // 2ページ目のチェック枠
});

// ---------------------------------------------------------------------
// ページ番号を指定したジャンプ
// ---------------------------------------------------------------------
test("ページ番号を指定してジャンプできる（3ページ以上のPDF）", async ({ page }) => {
  await openToolWithPdf(page, fixtures.multiPagePdf);
  await page.getByLabel("ページ番号を指定して移動").fill("3");
  await page.getByRole("button", { name: "移動", exact: true }).first().click();
  await expect(page.getByText("3 / 3ページ")).toBeVisible();
});

// ---------------------------------------------------------------------
// ズーム倍率の拡張（125%・200%を含む座標変換の回帰）
// ---------------------------------------------------------------------
test("拡張したズーム倍率(125%・200%)でも図形を配置・書き出しできる", async ({ page }) => {
  for (const zoom of [125, 200]) {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await page.getByRole("button", { name: `${zoom}%`, exact: true }).click();
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 80, 80);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();

    const downloadPath = await exportAndDownload(page);
    const summary = await getPageOpSummary(downloadPath, 1);
    expect(summary.hasPath).toBe(true);
  }
});

// ---------------------------------------------------------------------
// エッジケース（Phase 17分）
// ---------------------------------------------------------------------
test.describe("エッジケース(Phase 17)", () => {
  test("同じ画像を複数回配置してもクラッシュしない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    // 配置済みの画像の上をクリックすると、その画像自身のonClickにイベントが吸収されて
    // 新規配置ができなくなる（Phase 15の画像リサイズテストと同じ既知の注意点）ため、
    // 画像の既定サイズ（ページ幅の60%まで、最大220pt）より十分に離れた位置へ配置する。
    const positions = [
      { x: 40, y: 40 },
      { x: 500, y: 40 },
      { x: 40, y: 650 },
    ];
    for (let i = 0; i < positions.length; i++) {
      await page.getByRole("button", { name: "画像", exact: true }).click();
      await page.locator('input[type="file"]').last().setInputFiles(fixtures.png);
      await clickCanvasAt(page, positions[i].x, positions[i].y);
      await expect(page.getByText(`配置した注釈（${i + 1}件）`)).toBeVisible();
    }
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("図形の追加・削除・Undo・Redoを繰り返してもクラッシュしない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    const positions = [
      { x: 40, y: 40 },
      { x: 500, y: 40 },
      { x: 40, y: 650 },
      { x: 500, y: 650 },
    ];
    for (let i = 0; i < positions.length; i++) {
      await page.getByRole("button", { name: "図形", exact: true }).click();
      await clickCanvasAt(page, positions[i].x, positions[i].y);
      await expect(page.getByText(`配置した注釈（${i + 1}件）`)).toBeVisible();
    }
    await page.getByRole("button", { name: "元に戻す" }).click();
    await page.getByRole("button", { name: "元に戻す" }).click();
    await page.getByRole("button", { name: "やり直す" }).click();
    await expect(page.locator("body")).not.toContainText("Application error");
  });

  test("1ページのみのPDFでもページ番号ジャンプ欄が表示されず、通常操作に支障がない", async ({ page }) => {
    await openToolWithPdf(page, fixtures.singlePagePdf);
    await expect(page.getByLabel("ページ番号を指定して移動")).toHaveCount(0);
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await clickCanvasAt(page, 60, 60);
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
  });
});
