import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { extractPdfContent } from "../helpers/pdf-inspect";
import { NetworkRecorder, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { assertDownloadedFile } from "../helpers/tool-runner";
import { clickWhenReady, uploadWhenReady } from "../helpers/tool-ready";
import {
  SIZE_TOLERANCE_PT,
  cleanupWorkDir,
  extractTextDrawCalls,
  getHelveticaMeasure,
  getJapaneseMeasure,
  inspectOutputPdf,
  makeWorkDir,
  pageLabel,
  writeSyntheticPdf,
  type OutputPdfInfo,
  type SyntheticPageSpec,
  type TextDrawCall,
  type TextMeasure,
} from "../helpers/pdf-page-quality";

/**
 * PDFページ番号・透かしの出力品質テスト（工程8）。
 *
 * 画面操作で作った出力PDFを実際に解析し、次を検証する。
 *   ページ数・ページサイズ・回転情報が変わらないこと／元の本文が元の位置のまま残ること／
 *   追加された文字（ページ番号・透かし）の内容・位置・向き・不透明度・サイズ・色。
 * 文字の位置・向き・不透明度は、ページの描画命令（tests/helpers/pdf-page-quality.ts の
 * extractTextDrawCalls）から読む。テキスト抽出（getTextContent）は、ページの外にはみ出した文字を
 * 結果に含めず、不透明度も見えないため、位置・向き・不透明度の検証には使わない。
 *
 * 期待する配置位置は、実装（src/lib/pdf/overlay-layout.ts）の関数を呼ぶのではなく、その仕様
 * （余白・基準位置）をこのファイルに書き直して計算する。実装の計算を壊した場合に、
 * 同じ計算で期待値を出してしまい見逃すことを避けるため。文字の幅・高さだけは、アプリと同じ
 * pdf-lib のフォント測定を使う（日本語フォントはリポジトリ内の public/fonts を直接読み、通信しない）。
 */

// ---------------------------------------------------------------------------
// 仕様（overlay-layout.ts の配置仕様を、テスト側で独立して書き直したもの）
// ---------------------------------------------------------------------------

/** ページ番号: 下端の余白24pt。ベースラインは 24×0.6 = 14.4pt の高さ。文字色(0.3,0.3,0.32) */
const PN_MARGIN = 24;
const PN_BASELINE_Y = PN_MARGIN * 0.6;
const PN_COLOR_255 = { r: 0.3 * 255, g: 0.3 * 255, b: 0.32 * 255 };

/** 透かし: 余白32pt。文字色(0.5,0.5,0.5)。回転の中心は文字列の左端・ベースライン */
const WM_MARGIN = 32;
const WM_COLOR_255 = { r: 0.5 * 255, g: 0.5 * 255, b: 0.5 * 255 };

/** 位置の許容誤差(pt)。PDFの数値表現の丸めだけを許容する */
const POS_TOL = 0.5;
/** 色の許容誤差(0〜255)。pdfjsが色を整数に丸めるため */
const COLOR_TOL = 1.5;

// ---------------------------------------------------------------------------
// 共通操作
// ---------------------------------------------------------------------------

/** 入力・出力PDFの置き場（短い英数字の一時フォルダ。理由は pdf-page-quality.ts の makeWorkDir を参照） */
let workDir = "";
// 透かしは約5MBのフォントの取得・埋め込みを伴い、並列実行下では1件に20〜30秒かかることがある。既定の60秒だと余裕が小さい
test.describe.configure({ timeout: 120_000 });
test.beforeEach(() => {
  workDir = makeWorkDir();
});
test.afterEach(async ({}, testInfo) => {
  await cleanupWorkDir(workDir, testInfo);
});
const workPath = (name: string) => path.join(workDir, name);

async function openToolWithPdf(page: Page, slug: string, pdfPath: string, ready: Locator) {
  await page.goto(`/tools/${slug}`);
  await uploadWhenReady(page, pdfPath, ready, { readyTimeoutMs: 25_000 });
}

/**
 * ダウンロードの待ち時間は、既定（操作15秒）より長くしている。透かしは約5MBの日本語フォントを
 * 出力PDFへ埋め込むため重く、並列実行で動作が遅くなると、ボタンが「安定した」と判定されるまでの
 * 待ち（Playwrightの操作前確認）が15秒を超えることがあった（5回繰り返しで2/115件。出力内容の
 * 不一致ではなく、CPU負荷（負荷平均14前後・2CPU）による待機切れ）。クリックは1回だけ行う。
 */
const DOWNLOAD_WAIT_MS = 60_000;

async function downloadOutputPdf(page: Page, fileName: string): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_WAIT_MS });
  await page.getByRole("button", { name: /^ダウンロード$/ }).click({ timeout: DOWNLOAD_WAIT_MS });
  const download = await downloadPromise;
  const savedPath = workPath(fileName);
  await download.saveAs(savedPath);
  await assertDownloadedFile(download, { format: "pdf", minBytes: 100 });
  return savedPath;
}

/** 数値入力つきスライダーの値を、数値欄に入力して確定する（Enterで確定。反映までスライダーの値で確認する） */
async function setSlider(page: Page, label: string, value: number) {
  const numberInput = page.getByRole("spinbutton", { name: `${label}の数値` });
  await numberInput.fill(String(value));
  await numberInput.press("Enter");
  await expect(page.getByRole("slider", { name: label }), `${label}が${value}に変わりませんでした`).toHaveValue(String(value));
}

/** 位置ボタンを1回押す（Reactの準備完了を待ってから） */
async function choosePosition(page: Page, label: string) {
  await clickWhenReady(page.getByRole("button", { name: label, exact: true }));
}

/** 実行ボタンを押し、成功表示を待つ。エラー表示になった場合は、原因を区別して失敗させる */
async function runTool(page: Page, buttonName: string) {
  await clickWhenReady(page.getByRole("button", { name: buttonName, exact: true }));
  const success = page.getByText("追加が完了しました");
  const errorAlert = page.getByRole("alert").filter({ hasText: /\S/ });
  await expect(success.or(errorAlert), "処理の完了もエラー表示も現れませんでした").toBeVisible({ timeout: 45_000 });
  if (await errorAlert.first().isVisible()) {
    const message = (await errorAlert.first().innerText()).trim();
    // フォント取得の失敗(環境・通信が原因)と、処理自体のエラーを区別して報告する
    const kind = message.includes("日本語フォント") ? "フォント取得の失敗（環境・通信の問題）" : "処理のエラー（製品不具合の疑い）";
    throw new Error(`${kind}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 入力PDF（合成）と、出力PDFの共通検証
// ---------------------------------------------------------------------------

/** 元ページ番号ごとに異なるサイズ・指定した回転角を持つ、count ページの合成PDFの仕様 */
function makePages(
  count: number,
  sizeOf: (n: number) => { width: number; height: number },
  rotationOf: (n: number) => number = () => 0
): SyntheticPageSpec[] {
  return Array.from({ length: count }, (_, i) => ({ original: i + 1, size: sizeOf(i + 1), rotation: rotationOf(i + 1) }));
}

/** ページ番号テスト用: 小さめのページ（300x400台）。番号は小さいので十分に収まる */
const smallPage = (n: number) => ({ width: 300 + 20 * n, height: 400 + 20 * n });
/** 透かしテスト用: 大きめのページ（600x800台）。「CONFIDENTIAL」(48pt)が横幅に収まる大きさ */
const largePage = (n: number) => ({ width: 580 + 20 * n, height: 780 + 20 * n });

const approx = (actual: number, expected: number, tol: number, what: string) =>
  expect(Math.abs(actual - expected), `${what}: 実測 ${actual} / 期待 ${expected}（許容 ±${tol}）`).toBeLessThanOrEqual(tol);

/** 角度の差（度）。360度の周期を考慮する */
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** ページ数・ページサイズ・回転情報・元ページの並びが、入力から変わっていないこと */
function expectPagesUnchanged(info: OutputPdfInfo, specs: SyntheticPageSpec[]) {
  expect(info.pageCount, "出力のページ数").toBe(specs.length);
  expect(info.originalOrder, "出力の各ページの元ページ番号（本文から判定）").toEqual(specs.map((s) => s.original));
  info.pages.forEach((p, i) => {
    const spec = specs[i];
    approx(p.width, spec.size!.width, SIZE_TOLERANCE_PT, `${i + 1}ページ目の幅`);
    approx(p.height, spec.size!.height, SIZE_TOLERANCE_PT, `${i + 1}ページ目の高さ`);
    expect(p.rotation, `${i + 1}ページ目の回転情報`).toBe(spec.rotation ?? 0);
  });
}

/** ページ番号・透かし以外の文字描画（=元の本文）を取り出す */
const bodyCalls = (calls: TextDrawCall[]) => calls.filter((c) => c.text.startsWith("QA-ORIG-"));
const overlayCalls = (calls: TextDrawCall[]) => calls.filter((c) => !c.text.startsWith("QA-ORIG-"));

/** 元の本文が、元の文字・位置・大きさ・濃さのまま残っていること（ページ番号・透かしで書き換えられていない） */
function expectBodyUntouched(calls: TextDrawCall[][], specs: SyntheticPageSpec[]) {
  specs.forEach((spec, i) => {
    const body = bodyCalls(calls[i]);
    expect(body, `${i + 1}ページ目の本文の描画数`).toHaveLength(1);
    expect(body[0].text).toBe(pageLabel(spec.original));
    // writeSyntheticPdf が本文を置く位置: 左端20pt、上端から40pt下がったベースライン、14pt
    approx(body[0].x, 20, POS_TOL, `${i + 1}ページ目の本文のx`);
    approx(body[0].y, spec.size!.height - 40, POS_TOL, `${i + 1}ページ目の本文のy`);
    approx(body[0].fontSize, 14, 0.01, `${i + 1}ページ目の本文のサイズ`);
    expect(body[0].opacity, `${i + 1}ページ目の本文の不透明度`).toBe(1);
  });
}

/** 文字（原点・向き・測定した幅/高さ）の四隅が、ページ内（MediaBox）に収まっていること */
function expectInsidePage(call: TextDrawCall, measure: TextMeasure, page: { width: number; height: number }, what: string) {
  const w = measure.widthOfTextAtSize(call.text, call.fontSize);
  const h = measure.heightAtSize(call.fontSize);
  const rad = (call.angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad); // 文字の進行方向
  const vx = -Math.sin(rad), vy = Math.cos(rad); // 文字の上方向
  const corners = [
    [call.x, call.y],
    [call.x + ux * w, call.y + uy * w],
    [call.x + vx * h, call.y + vy * h],
    [call.x + ux * w + vx * h, call.y + uy * w + vy * h],
  ];
  for (const [cx, cy] of corners) {
    expect(cx, `${what}: 四隅のxがページ内（0〜${page.width}）`).toBeGreaterThanOrEqual(-POS_TOL);
    expect(cx, `${what}: 四隅のxがページ内（0〜${page.width}）`).toBeLessThanOrEqual(page.width + POS_TOL);
    expect(cy, `${what}: 四隅のyがページ内（0〜${page.height}）`).toBeGreaterThanOrEqual(-POS_TOL);
    expect(cy, `${what}: 四隅のyがページ内（0〜${page.height}）`).toBeLessThanOrEqual(page.height + POS_TOL);
  }
}

// ---------------------------------------------------------------------------
// ページ番号
// ---------------------------------------------------------------------------

type PnPosition = "左下" | "中央下" | "右下";

/** ページ番号の期待結果を検証する（ページごとに1つだけ・指定の文字・位置・大きさ・色） */
async function expectPageNumbers(
  outputPath: string,
  specs: SyntheticPageSpec[],
  expected: { labels: string[]; position: PnPosition; fontSize: number }
) {
  const calls = await extractTextDrawCalls(outputPath);
  expect(calls).toHaveLength(specs.length);
  expectBodyUntouched(calls, specs);
  const helvetica = await getHelveticaMeasure();

  specs.forEach((spec, i) => {
    const where = `${i + 1}ページ目（元${spec.original}ページ）`;
    const overlays = overlayCalls(calls[i]);
    expect(overlays, `${where}に追加された文字は、ページ番号1つだけ`).toHaveLength(1);
    const c = overlays[0];
    expect(c.text, `${where}のページ番号`).toBe(expected.labels[i]);

    const textWidth = helvetica.widthOfTextAtSize(expected.labels[i], expected.fontSize);
    const pageWidth = spec.size!.width;
    const expectedX =
      expected.position === "左下" ? PN_MARGIN : expected.position === "右下" ? pageWidth - PN_MARGIN - textWidth : (pageWidth - textWidth) / 2;
    approx(c.x, expectedX, POS_TOL, `${where}のページ番号のx（${expected.position}）`);
    approx(c.y, PN_BASELINE_Y, POS_TOL, `${where}のページ番号のy`);
    approx(c.fontSize, expected.fontSize, 0.01, `${where}のフォントサイズ`);
    expect(angleDiff(c.angleDeg, 0), `${where}のページ番号の向き`).toBeLessThanOrEqual(0.1);
    expect(c.opacity, `${where}のページ番号の不透明度`).toBe(1);
    approx(c.fill?.r ?? -999, PN_COLOR_255.r, COLOR_TOL, `${where}の文字色R`);
    approx(c.fill?.g ?? -999, PN_COLOR_255.g, COLOR_TOL, `${where}の文字色G`);
    approx(c.fill?.b ?? -999, PN_COLOR_255.b, COLOR_TOL, `${where}の文字色B`);
    // 番号がページの外にはみ出していないこと
    expectInsidePage(c, helvetica, spec.size!, `${where}のページ番号`);
  });
}

test.describe("pdf-add-page-numbers: 出力PDFの品質", () => {
  const SLUG = "pdf-add-page-numbers";
  const ready = (page: Page) => page.getByLabel("開始番号");
  const RUN = "ページ番号を追加する";

  /** 入力を作って開く */
  async function open(page: Page, specs: SyntheticPageSpec[]) {
    const input = workPath("input.pdf");
    await writeSyntheticPdf(input, specs);
    await openToolWithPdf(page, SLUG, input, ready(page));
  }

  test("既定の設定（開始1・中央下・10pt）で、全ページに1,2,3が順番に付き、本文・ページサイズ・回転は変わらない", async ({ page }) => {
    const specs = makePages(3, smallPage);
    await open(page, specs);
    await runTool(page, RUN);
    await expect(page.getByText(/^3ページ ・/)).toBeVisible();

    const out = await downloadOutputPdf(page, "numbered.pdf");
    expectPagesUnchanged(await inspectOutputPdf(out), specs);
    await expectPageNumbers(out, specs, { labels: ["1", "2", "3"], position: "中央下", fontSize: 10 });

    // テキスト抽出（利用者が見る内容）でも、本文とページ番号が両方読めること
    const text = await extractPdfContent(out);
    specs.forEach((spec, i) => {
      expect(text.pages[i].text, `${i + 1}ページ目の本文`).toContain(pageLabel(spec.original));
      expect(text.pages[i].text, `${i + 1}ページ目のページ番号`).toContain(String(i + 1));
    });
  });

  for (const position of ["左下", "右下"] as const) {
    test(`位置「${position}」: ページ幅の異なる全ページで、指定した位置に番号が付く`, async ({ page }) => {
      const specs = makePages(3, smallPage);
      await open(page, specs);
      await choosePosition(page, position);
      await runTool(page, RUN);

      const out = await downloadOutputPdf(page, "numbered.pdf");
      expectPagesUnchanged(await inspectOutputPdf(out), specs);
      await expectPageNumbers(out, specs, { labels: ["1", "2", "3"], position, fontSize: 10 });
    });
  }

  test("開始番号を5にすると、5,6,7の順に付く（ページの順序どおり）", async ({ page }) => {
    const specs = makePages(3, smallPage);
    await open(page, specs);
    await ready(page).fill("5");
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "numbered.pdf");
    expectPagesUnchanged(await inspectOutputPdf(out), specs);
    await expectPageNumbers(out, specs, { labels: ["5", "6", "7"], position: "中央下", fontSize: 10 });
  });

  test("開始番号を-1にすると、-1,0,1の順に付く（表紙を番号なし扱いにする使い方）", async ({ page }) => {
    const specs = makePages(3, smallPage);
    await open(page, specs);
    await ready(page).fill("-1");
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "numbered.pdf");
    await expectPageNumbers(out, specs, { labels: ["-1", "0", "1"], position: "中央下", fontSize: 10 });
  });

  test("フォントサイズ24pt・右下・大きな番号（99999から）でも、番号がページの外にはみ出さない", async ({ page }) => {
    const specs = makePages(3, smallPage);
    await open(page, specs);
    await ready(page).fill("99999");
    await choosePosition(page, "右下");
    await setSlider(page, "フォントサイズ", 24);
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "numbered.pdf");
    expectPagesUnchanged(await inspectOutputPdf(out), specs);
    // 99999, 100000, 100001（桁数が増えても右端の余白が保たれる）。はみ出し確認は expectPageNumbers の中で行う
    await expectPageNumbers(out, specs, { labels: ["99999", "100000", "100001"], position: "右下", fontSize: 24 });
  });

  test("回転済み・サイズの異なるページでも、回転情報とページサイズは変わらず、全ページに番号が付く", async ({ page }) => {
    const rotations: Record<number, number> = { 1: 0, 2: 90, 3: 180 };
    const specs = makePages(3, smallPage, (n) => rotations[n]);
    await open(page, specs);
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "numbered.pdf");
    expectPagesUnchanged(await inspectOutputPdf(out), specs);
    const calls = await extractTextDrawCalls(out);
    expectBodyUntouched(calls, specs);
    specs.forEach((_, i) => {
      const overlays = overlayCalls(calls[i]);
      expect(overlays, `${i + 1}ページ目に追加された文字`).toHaveLength(1);
      expect(overlays[0].text).toBe(String(i + 1));
    });
  });

  test("開始番号が整数でない（1.5）と、エラーが表示され、出力は作られない", async ({ page }) => {
    const specs = makePages(2, smallPage);
    await open(page, specs);
    await ready(page).fill("1.5");
    await clickWhenReady(page.getByRole("button", { name: RUN, exact: true }), {
      expectAfter: page.getByRole("alert").filter({ hasText: "開始番号は整数で指定してください" }),
    });
    await expect(page.getByText("追加が完了しました")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^ダウンロード$/ })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 透かし
// ---------------------------------------------------------------------------

type WmPosition = "中央" | "左上" | "右上" | "左下" | "右下";

/** 透かしの期待結果を検証する（ページごとに1つだけ・指定の文字・位置・向き・濃さ・大きさ・色） */
async function expectWatermark(
  outputPath: string,
  specs: SyntheticPageSpec[],
  expected: {
    text: string;
    position: WmPosition;
    fontSize: number;
    /** 反時計回りの度数（PDFの座標系。画面の「回転角度」と同じ値） */
    rotation: number;
    /** 0〜1 */
    opacity: number;
    /** ページ内に収まっていることまで確認するか（回転済みページなどでは確認しない） */
    insidePage?: boolean;
  }
) {
  const calls = await extractTextDrawCalls(outputPath);
  expect(calls).toHaveLength(specs.length);
  expectBodyUntouched(calls, specs);
  const jp = await getJapaneseMeasure();
  const textWidth = jp.widthOfTextAtSize(expected.text, expected.fontSize);
  const textHeight = jp.heightAtSize(expected.fontSize);

  specs.forEach((spec, i) => {
    const where = `${i + 1}ページ目（元${spec.original}ページ）`;
    const { width: pw, height: ph } = spec.size!;
    const overlays = overlayCalls(calls[i]);
    expect(overlays, `${where}に追加された文字は、透かし1つだけ`).toHaveLength(1);
    const c = overlays[0];
    expect(c.text, `${where}の透かし文字`).toBe(expected.text);

    const [ex, ey] = {
      中央: [(pw - textWidth) / 2, (ph - textHeight) / 2],
      左上: [WM_MARGIN, ph - WM_MARGIN - textHeight],
      右上: [pw - WM_MARGIN - textWidth, ph - WM_MARGIN - textHeight],
      左下: [WM_MARGIN, WM_MARGIN],
      右下: [pw - WM_MARGIN - textWidth, WM_MARGIN],
    }[expected.position];
    approx(c.x, ex, POS_TOL, `${where}の透かしのx（${expected.position}）`);
    approx(c.y, ey, POS_TOL, `${where}の透かしのy（${expected.position}）`);
    approx(c.fontSize, expected.fontSize, 0.01, `${where}のフォントサイズ`);
    expect(angleDiff(c.angleDeg, expected.rotation), `${where}の透かしの向き: 実測 ${c.angleDeg}° / 期待 ${expected.rotation}°`).toBeLessThanOrEqual(0.1);
    approx(c.opacity, expected.opacity, 0.001, `${where}の透かしの不透明度`);
    approx(c.fill?.r ?? -999, WM_COLOR_255.r, COLOR_TOL, `${where}の文字色R`);
    approx(c.fill?.g ?? -999, WM_COLOR_255.g, COLOR_TOL, `${where}の文字色G`);
    approx(c.fill?.b ?? -999, WM_COLOR_255.b, COLOR_TOL, `${where}の文字色B`);
    if (expected.insidePage) expectInsidePage(c, jp, spec.size!, `${where}の透かし`);
  });
}

test.describe("pdf-watermark: 出力PDFの品質", () => {
  const SLUG = "pdf-watermark";
  const TEXT_FIELD = (page: Page) => page.getByLabel("透かしの文字");
  const RUN = "透かしを追加する";
  const FONT_URL_PART = "/fonts/NotoSansJP-Regular.ttf";

  async function open(page: Page, specs: SyntheticPageSpec[]) {
    const input = workPath("input.pdf");
    await writeSyntheticPdf(input, specs);
    await openToolWithPdf(page, SLUG, input, TEXT_FIELD(page));
  }

  test("既定の設定（CONFIDENTIAL・中央・30%・48pt・-45°）で、全ページに透かしが入り、本文・ページサイズ・回転は変わらない", async ({ page }, testInfo) => {
    const specs = makePages(3, largePage);
    const recorder = new NetworkRecorder(page);
    await open(page, specs);
    await runTool(page, RUN);
    await expect(page.getByText(/^3ページ ・/)).toBeVisible();

    const out = await downloadOutputPdf(page, "watermarked.pdf");
    expectPagesUnchanged(await inspectOutputPdf(out), specs);
    await expectWatermark(out, specs, { text: "CONFIDENTIAL", position: "中央", fontSize: 48, rotation: -45, opacity: 0.3, insidePage: true });

    // 利用者が見る内容（テキスト抽出）でも、本文と透かしの両方が読めること
    const text = await extractPdfContent(out);
    specs.forEach((spec, i) => {
      expect(text.pages[i].text, `${i + 1}ページ目の本文`).toContain(pageLabel(spec.original));
      expect(text.pages[i].text, `${i + 1}ページ目の透かし`).toContain("CONFIDENTIAL");
    });

    // 通信: 日本語フォントはアプリ自身のサーバー（同一オリジン）から取得し、ページの読み込み1回につき1回だけ。
    // ファイルの内容を外部へ送っていないこと（既存の privacy テストと同じ監視ヘルパーで確認）。
    const origin = new URL(page.url()).origin;
    const fontRequests = recorder.requests.filter((r) => r.url.includes(FONT_URL_PART));
    expect(fontRequests.length, "日本語フォントの取得回数").toBe(1);
    expect(fontRequests[0].url.startsWith(origin), `フォントの取得先は同一オリジン（実際: ${fontRequests[0].url}）`).toBe(true);
    expect(findSuspiciousExternalUploads(recorder, origin), "外部へのデータ送信").toEqual([]);
    const external = recorder.requests.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith("data:") && !r.url.startsWith("blob:"));
    testInfo.annotations.push({ type: "external-requests", description: `${external.length}件: ${external.map((r) => r.url).join(", ") || "なし"}` });
  });

  for (const position of ["左上", "右上", "左下", "右下"] as const) {
    test(`位置「${position}」: ページ幅の異なる全ページで、指定した位置に透かしが入る（回転0°・DRAFT）`, async ({ page }) => {
      const specs = makePages(3, largePage);
      await open(page, specs);
      await TEXT_FIELD(page).fill("DRAFT");
      await choosePosition(page, position);
      await setSlider(page, "回転角度", 0);
      await runTool(page, RUN);

      const out = await downloadOutputPdf(page, "watermarked.pdf");
      expectPagesUnchanged(await inspectOutputPdf(out), specs);
      await expectWatermark(out, specs, { text: "DRAFT", position, fontSize: 48, rotation: 0, opacity: 0.3, insidePage: true });
    });
  }

  for (const opacityPercent of [60, 5]) {
    test(`不透明度${opacityPercent}%: 描画情報(ExtGStateのca)が ${opacityPercent / 100} になる`, async ({ page }) => {
      const specs = makePages(2, largePage);
      await open(page, specs);
      await setSlider(page, "不透明度", opacityPercent);
      await runTool(page, RUN);

      const out = await downloadOutputPdf(page, "watermarked.pdf");
      await expectWatermark(out, specs, { text: "CONFIDENTIAL", position: "中央", fontSize: 48, rotation: -45, opacity: opacityPercent / 100 });
    });
  }

  for (const rotation of [30, 90, -90]) {
    test(`回転角度${rotation}°: 文字の向きが ${rotation}°（反時計回り）になり、ページ内に収まる`, async ({ page }) => {
      const specs = makePages(2, largePage);
      await open(page, specs);
      await setSlider(page, "回転角度", rotation);
      await runTool(page, RUN);

      const out = await downloadOutputPdf(page, "watermarked.pdf");
      await expectWatermark(out, specs, { text: "CONFIDENTIAL", position: "中央", fontSize: 48, rotation, opacity: 0.3, insidePage: true });
    });
  }

  test("日本語の透かし「社外秘」: 文字がそのまま出力され、テキスト抽出でも読める", async ({ page }) => {
    const specs = makePages(2, largePage);
    await open(page, specs);
    await TEXT_FIELD(page).fill("社外秘");
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "watermarked.pdf");
    await expectWatermark(out, specs, { text: "社外秘", position: "中央", fontSize: 48, rotation: -45, opacity: 0.3, insidePage: true });
    const text = await extractPdfContent(out);
    text.pages.forEach((p, i) => expect(p.text, `${i + 1}ページ目の透かし`).toContain("社外秘"));
  });

  test("フォントサイズ24pt: 指定の大きさで入り、配置位置も大きさに合わせて計算される", async ({ page }) => {
    const specs = makePages(2, largePage);
    await open(page, specs);
    await setSlider(page, "フォントサイズ", 24);
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "watermarked.pdf");
    await expectWatermark(out, specs, { text: "CONFIDENTIAL", position: "中央", fontSize: 24, rotation: -45, opacity: 0.3, insidePage: true });
  });

  test("回転済み・サイズの異なるページでも、回転情報とページサイズは変わらず、全ページに透かしが入る", async ({ page }) => {
    const rotations: Record<number, number> = { 1: 0, 2: 90, 3: 180 };
    const specs = makePages(3, largePage, (n) => rotations[n]);
    await open(page, specs);
    await runTool(page, RUN);

    const out = await downloadOutputPdf(page, "watermarked.pdf");
    expectPagesUnchanged(await inspectOutputPdf(out), specs);
    const calls = await extractTextDrawCalls(out);
    expectBodyUntouched(calls, specs);
    specs.forEach((_, i) => {
      const overlays = overlayCalls(calls[i]);
      expect(overlays, `${i + 1}ページ目に追加された文字`).toHaveLength(1);
      expect(overlays[0].text).toBe("CONFIDENTIAL");
      approx(overlays[0].opacity, 0.3, 0.001, `${i + 1}ページ目の透かしの不透明度`);
    });
  });

  test("透かしの文字が空（または空白だけ）の間は、実行できない", async ({ page }) => {
    const specs = makePages(1, largePage);
    await open(page, specs);
    const run = page.getByRole("button", { name: RUN, exact: true });
    await expect(run).toBeEnabled();
    await TEXT_FIELD(page).fill("");
    await expect(run).toBeDisabled();
    await TEXT_FIELD(page).fill("   ");
    await expect(run).toBeDisabled();
    await expect(page.getByText("追加が完了しました")).toHaveCount(0);
  });

  test("日本語フォントを取得できないと、通信の確認を促すエラーが表示され、出力は作られない（失敗時の挙動）", async ({ page }) => {
    // 取得失敗を再現するため、アプリ自身のフォント配信を、このテストの中だけ失敗させる（外部通信は行わない）
    await page.route(`**${FONT_URL_PART}`, (route) => route.abort());
    const specs = makePages(1, largePage);
    await open(page, specs);

    await clickWhenReady(page.getByRole("button", { name: RUN, exact: true }), {
      expectAfter: page.getByRole("alert").filter({ hasText: "日本語フォントの読み込みに失敗しました" }),
      expectTimeoutMs: 45_000,
    });
    await expect(page.getByText("追加が完了しました")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^ダウンロード$/ })).toHaveCount(0);
  });
});
