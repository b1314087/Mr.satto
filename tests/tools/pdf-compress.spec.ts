import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { test as plainTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, StandardFonts, drawObject, popGraphicsState, pushGraphicsState, concatTransformationMatrix } from "pdf-lib";
import { FLATE_PHOTO_MIN_PIXELS, unpredictPng } from "@/lib/processors/browser/pdf-image-recompress";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, closeResultPopup, waitForFileInputHydrated } from "../helpers/tool-runner";
import { extractPdfContent } from "../helpers/pdf-inspect";
import {
  DEFAULT_PRESET_ID,
  PDF_COMPRESS_PRESETS,
  TARGET_LADDER,
  fitWithinEdge,
  formatTargetMB,
  getPreset,
  matchPreset,
  parseIntegerSetting,
  parseTargetMB,
  sizeReduction,
  suggestTargetMB,
  comparableOriginalBytes,
  unreadablePdfMessage,
} from "@/lib/pdf/compress-settings";

/**
 * 工程18：PDF圧縮の数値設定（画像の品質・画像の長辺の上限）のテスト。
 *  - 設定・プリセット・入力の確認・計算（画面なし）
 *  - 実際のPDF（写真のようなJPEG画像＋文字）での圧縮：設定が処理へ渡り、出力の画像の大きさ・サイズに反映されること
 *  - 結果の表示（削減サイズ・削減率）、無効な数値、初期値に戻す、画像はそのまま、電子署名の注意、壊れたPDF
 */

// ---------------------------------------------------------------------------
// 1. 設定・計算（画面なし）
// ---------------------------------------------------------------------------
plainTest.describe("圧縮の設定（画面なし）", () => {
  plainTest("プリセットは実際の数値に対応し、標準が初期値。値からプリセットを判別できる", () => {
    expect(getPreset("quality").settings).toEqual({ recompressImages: true, imageQuality: 85, maxImageEdge: 3000 });
    expect(getPreset("standard").settings).toEqual({ recompressImages: true, imageQuality: 75, maxImageEdge: 2000 });
    expect(getPreset("small").settings).toEqual({ recompressImages: true, imageQuality: 50, maxImageEdge: 1200 });
    expect(getPreset("structure").settings.recompressImages).toBe(false);
    expect(DEFAULT_PRESET_ID).toBe("standard");
    for (const p of PDF_COMPRESS_PRESETS) expect(matchPreset(p.settings)).toBe(p.id);
    expect(matchPreset({ recompressImages: true, imageQuality: 60, maxImageEdge: 2000 })).toBeNull();
  });

  plainTest("入力の確認：空欄・数字以外・小数・範囲外は渡さず、次に何をすればよいかを伝える", () => {
    expect(parseIntegerSetting("70", 10, 95, "画像の品質")).toEqual({ ok: true, value: 70 });
    expect(parseIntegerSetting(" ７０ ", 10, 95, "画像の品質")).toEqual({ ok: true, value: 70 });
    const msg = (raw: string) => {
      const r = parseIntegerSetting(raw, 10, 95, "画像の品質");
      return r.ok ? "" : r.message;
    };
    expect(msg("")).toContain("入力してください");
    expect(msg("abc")).toContain("数字で入力");
    expect(msg("12.5")).toContain("整数で入力");
    expect(msg("5")).toContain("10〜95の範囲");
    expect(msg("96")).toContain("10〜95の範囲");
  });

  plainTest("長辺の上限：超える画像だけを、縦横比を保って縮小する", () => {
    expect(fitWithinEdge(3000, 2000, 2000)).toEqual({ width: 2000, height: 1333, resized: true });
    expect(fitWithinEdge(1000, 3000, 1200)).toEqual({ width: 400, height: 1200, resized: true });
    expect(fitWithinEdge(800, 600, 2000)).toEqual({ width: 800, height: 600, resized: false });
    expect(fitWithinEdge(5000, 4000, null)).toEqual({ width: 5000, height: 4000, resized: false });
  });

  plainTest("削減サイズ・削減率を正しく計算する（増えた場合はマイナス）", () => {
    expect(sizeReduction(1000, 600)).toEqual({ savedBytes: 400, percent: 40 });
    expect(sizeReduction(1000, 1000)).toEqual({ savedBytes: 0, percent: 0 });
    expect(sizeReduction(1000, 1100)).toEqual({ savedBytes: -100, percent: -10 });
    expect(sizeReduction(0, 10).percent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. 実際のPDFでの圧縮
// ---------------------------------------------------------------------------
let workDir = "";
plainTest.beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfcompress-"));
});
plainTest.afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});
const workPath = (name: string) => path.join(workDir, name);

/** ブラウザで、写真のような（なだらかな色の変化＋細かい模様の）大きいJPEGを作る */
async function makePhotoJpeg(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ width, height }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, "#3b82f6");
      g.addColorStop(0.5, "#f59e0b");
      g.addColorStop(1, "#10b981");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      let seed = 7;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (let i = 0; i < 4000; i++) {
        ctx.fillStyle = `rgba(${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},${Math.floor(rand() * 255)},0.35)`;
        ctx.beginPath();
        ctx.arc(rand() * width, rand() * height, 4 + rand() * 30, 0, Math.PI * 2);
        ctx.fill();
      }
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.95));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { width, height }
  );
  return Buffer.from(base64, "base64");
}

/** 写真（JPEG）2枚と文字を含む、2ページのPDFを作る。sign を付けると電子署名の欄（/Type /Sig）を含める */
async function writePhotoPdf(page: Page, name: string, opts: { sign?: boolean } = {}): Promise<string> {
  const jpeg = await makePhotoJpeg(page, 3000, 2000);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const image = await doc.embedJpg(jpeg);
  for (const label of ["Searchable text page one", "Searchable text page two"]) {
    const p = doc.addPage([595, 842]);
    p.drawText(label, { x: 50, y: 790, size: 14, font });
    p.drawImage(image, { x: 50, y: 300, width: 495, height: 330 });
  }
  if (opts.sign) doc.context.register(doc.context.obj({ Type: "Sig", Filter: "Adobe.PPKLite" }));
  const file = workPath(name);
  fs.writeFileSync(file, await doc.save());
  return file;
}

/** PDFに含まれる画像の大きさ（幅・高さ） */
async function imageSizes(file: string): Promise<{ width: number; height: number }[]> {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const sizes: { width: number; height: number }[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) {
      const w = obj.dict.get(PDFName.of("Width")) as PDFNumber;
      const h = obj.dict.get(PDFName.of("Height")) as PDFNumber;
      sizes.push({ width: w.asNumber(), height: h.asNumber() });
    }
  }
  return sizes;
}

/** PDFを選ぶ。mode：quality＝「画質を指定する（詳しい設定）」に切り替える、target＝初期の「サイズを指定する」のまま */
async function openWithPdf(page: Page, file: string, mode: "quality" | "target" = "quality") {
  await page.goto("/tools/pdf-compress");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(file);
  if (mode === "quality") await page.getByTestId("compress-mode-quality").check();
  await expect(page.getByRole("button", { name: "圧縮する" })).toBeEnabled({ timeout: 20_000 });
}

async function compressAndSave(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name: "圧縮する" }).click();
  await expect(page.getByTestId("compress-result")).toBeVisible({ timeout: 60_000 });
  const download = await clickAndDownload(page, /^ダウンロード$/);
  const saved = workPath(name);
  await download.saveAs(saved);
  return saved;
}

test.use({ viewport: { width: 1280, height: 1400 } });

test.describe("PDF圧縮：数値の設定と結果", () => {
  test("「画質を指定する」では、設定に触れずに「圧縮する」だけで、標準の設定で圧縮できる。結果の表示（削減サイズ・割合）が正しく、PDFは正常に開け、文字はそのまま", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo.pdf");
    await openWithPdf(page, src);
    await expect(page.getByTestId("compress-preset-standard")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("compress-quality")).toHaveValue("75");
    await expect(page.getByTestId("compress-edge")).toHaveValue("2000");

    const out = await compressAndSave(page, "standard.pdf");
    const original = fs.statSync(src).size;
    const compressed = fs.statSync(out).size;
    expect(compressed).toBeLessThan(original);
    const { savedBytes, percent } = sizeReduction(original, compressed);
    expect(savedBytes).toBeGreaterThan(0);
    await expect(page.getByTestId("compress-reduction")).toContainText(`削減（${percent.toFixed(1)}%）`);
    await expect(page.getByTestId("compress-used-settings")).toContainText("標準（画像の品質 75・長辺の上限 2000px）");
    await expect(page.getByTestId("compress-image-stats")).toContainText("1個を作り直しました（うち縮小1個）");

    // 出力：ページ数・文字はそのまま、画像は長辺2000pxに縮小
    const content = await extractPdfContent(out);
    expect(content.pageCount).toBe(2);
    expect(content.text).toContain("Searchable text page one");
    expect(content.text).toContain("Searchable text page two");
    expect(await imageSizes(out)).toEqual([{ width: 2000, height: 1333 }]);
  });

  test("プリセットを選ぶと数値の欄に値が入り、自分で数値を変えると「自分で指定」になる。スライダーと数値の欄は同じ値になる", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    await waitForFileInputHydrated(page);
    await page.getByTestId("compress-mode-quality").check();
    await page.getByTestId("compress-preset-quality").click();
    await expect(page.getByTestId("compress-quality")).toHaveValue("85");
    await expect(page.getByTestId("compress-edge")).toHaveValue("3000");
    await expect(page.getByTestId("compress-quality-slider")).toHaveValue("85");
    await page.getByTestId("compress-preset-small").click();
    await expect(page.getByTestId("compress-quality")).toHaveValue("50");
    await expect(page.getByTestId("compress-edge-slider")).toHaveValue("1200");

    // 数値の欄 → スライダー
    await page.getByTestId("compress-quality").fill("62");
    await expect(page.getByTestId("compress-quality-slider")).toHaveValue("62");
    await expect(page.getByTestId("compress-preset-description")).toContainText("数値を自分で指定");
    for (const id of ["quality", "standard", "small", "structure"]) await expect(page.getByTestId(`compress-preset-${id}`)).toHaveAttribute("aria-pressed", "false");
    // スライダー → 数値の欄
    await page.getByTestId("compress-edge-slider").fill("900");
    await expect(page.getByTestId("compress-edge")).toHaveValue("900");
  });

  test("自分で指定した数値が処理に渡る：長辺800pxなら画像は800pxに、設定の違いで出力のサイズも変わる", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo.pdf");
    await openWithPdf(page, src);

    await page.getByTestId("compress-quality").fill("40");
    await page.getByTestId("compress-edge").fill("800");
    const custom = await compressAndSave(page, "custom.pdf");
    await expect(page.getByTestId("compress-used-settings")).toContainText("自分で指定（画像の品質 40・長辺の上限 800px）");
    expect(await imageSizes(custom)).toEqual([{ width: 800, height: 533 }]);

    await closeResultPopup(page);
    await page.getByTestId("compress-preset-quality").click();
    // 設定を変えると、前の設定の結果はダウンロードできなくなる
    await expect(page.getByTestId("compress-result")).toHaveCount(0);
    const quality = await compressAndSave(page, "quality.pdf");
    expect(await imageSizes(quality)).toEqual([{ width: 3000, height: 2000 }]);
    // この代表的なPDFでは、高品質優先のほうが大きく、自分で指定した低い品質・小さい上限のほうが小さい
    expect(fs.statSync(custom).size).toBeLessThan(fs.statSync(quality).size);

    // 縮小しない
    await closeResultPopup(page);
    await page.getByTestId("compress-preset-standard").click();
    await page.getByTestId("compress-no-resize").check();
    await expect(page.getByTestId("compress-edge")).toBeDisabled();
    const noResize = await compressAndSave(page, "noresize.pdf");
    await expect(page.getByTestId("compress-used-settings")).toContainText("長辺の上限 なし");
    expect(await imageSizes(noResize)).toEqual([{ width: 3000, height: 2000 }]);
  });

  test("「画像はそのまま」は画像を変えず、これまでどおり構造だけを整理する", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo.pdf");
    await openWithPdf(page, src);
    await page.getByTestId("compress-preset-structure").click();
    await expect(page.getByTestId("compress-quality")).toBeDisabled();
    const out = await compressAndSave(page, "structure.pdf");
    await expect(page.getByTestId("compress-used-settings")).toContainText("画像はそのまま");
    await expect(page.getByTestId("compress-image-stats")).toHaveCount(0);
    expect(await imageSizes(out)).toEqual([{ width: 3000, height: 2000 }]);
  });

  test("無効な数値は処理に渡さず、直し方を案内する。「初期値に戻す」で標準に戻る", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo.pdf");
    await openWithPdf(page, src);
    const run = page.getByRole("button", { name: "圧縮する" });

    await page.getByTestId("compress-quality").fill("");
    await expect(page.getByTestId("compress-quality-error")).toContainText("画像の品質を入力してください（10〜95）");
    await expect(run).toBeDisabled();
    await page.getByTestId("compress-quality").fill("5");
    await expect(page.getByTestId("compress-quality-error")).toContainText("10〜95の範囲");
    await page.getByTestId("compress-edge").fill("100000");
    await expect(page.getByTestId("compress-edge-error")).toContainText("300〜6000の範囲");
    await expect(run).toBeDisabled();

    await page.getByTestId("compress-reset").click();
    await expect(page.getByTestId("compress-quality")).toHaveValue("75");
    await expect(page.getByTestId("compress-edge")).toHaveValue("2000");
    await expect(page.getByTestId("compress-quality-error")).toHaveCount(0);
    await expect(page.getByTestId("compress-edge-error")).toHaveCount(0);
    await expect(page.getByTestId("compress-preset-standard")).toHaveAttribute("aria-pressed", "true");
    await expect(run).toBeEnabled();
  });

  test("電子署名を含むPDFは、圧縮すると署名が無効になることを伝える", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "signed.pdf", { sign: true });
    await openWithPdf(page, src);
    await compressAndSave(page, "signed-out.pdf");
    await expect(page.getByTestId("compress-signature-warning")).toContainText("署名は無効");
  });

});

// ---------------------------------------------------------------------------
// 2-2. 読み込めるかの確認と案内（ロードマップC 工程4：サイズの案内より先に、PDFとして読み込めるかを確かめる）
// ---------------------------------------------------------------------------
plainTest.describe("読み込めるかの確認（画面なし）", () => {
  plainTest("元のサイズは、読み込めると確認できたときだけ比較に使う（確認中・読み込めないときは比べない）", () => {
    expect(comparableOriginalBytes(30_000, { status: "ok" })).toBe(30_000);
    expect(comparableOriginalBytes(30_000, { status: "checking" })).toBeNull();
    expect(comparableOriginalBytes(30_000, { status: "error", message: "x" })).toBeNull();
    expect(comparableOriginalBytes(30_000, null)).toBeNull();
    expect(comparableOriginalBytes(null, { status: "ok" })).toBeNull();
    // 読み込めないPDFには「すでに十分小さい」を出さない
    expect(parseTargetMB("0.5", comparableOriginalBytes(30_000, { status: "error", message: "x" })).ok).toBe(true);
    expect(unreadablePdfMessage("a.pdf")).toContain("「a.pdf」はPDFとして読み込めませんでした");
  });
});

test.describe("PDF圧縮：読み込めないPDFと、圧縮中の失敗", () => {
  async function selectFile(page: Page, file: string) {
    await page.goto("/tools/pdf-compress");
    await waitForFileInputHydrated(page);
    await page.locator('input[type="file"]').first().setInputFiles(file);
  }

  test("拡張子だけPDFのファイル（中身は文字）は、読み込めないことを伝え、「すでに十分小さい」とは言わない。圧縮は押せない", async ({ page }) => {
    const fake = workPath("fake.pdf");
    fs.writeFileSync(fake, "this is not a pdf");
    await selectFile(page, fake);
    await expect(page.getByTestId("compress-unreadable")).toContainText("「fake.pdf」はPDFとして読み込めませんでした", { timeout: 20_000 });
    await expect(page.getByText("すでに十分小さい")).toHaveCount(0);
    await expect(page.getByTestId("compress-target-error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "圧縮する" })).toBeDisabled();
    // 「画質を指定する」に切り替えても、圧縮はできない
    await page.getByTestId("compress-mode-quality").check();
    await expect(page.getByRole("button", { name: "圧縮する" })).toBeDisabled();
    await expect(page.getByTestId("compress-result")).toHaveCount(0);
  });

  test("壊れたPDF（途中で切れている）は、読み込めないことを伝え、「すでに十分小さい」とは言わない", async ({ page }) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([200, 200]).drawText("broken", { x: 20, y: 100, size: 12, font });
    const bytes = await doc.save();
    const broken = workPath("broken.pdf");
    // 先頭のヘッダーだけを残し、ページの情報を切り落とす（小さいファイルなので、従来は「すでに十分小さい」が出ていた）
    fs.writeFileSync(broken, Buffer.from(bytes).subarray(0, 40));
    await selectFile(page, broken);
    await expect(page.getByTestId("compress-unreadable")).toContainText("「broken.pdf」はPDFとして読み込めませんでした", { timeout: 20_000 });
    await expect(page.getByText("すでに十分小さい")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "圧縮する" })).toBeDisabled();
  });

  test("読み込めないPDFのあとに正常なPDFを選び直すと、案内が消えて圧縮できる", async ({ page }) => {
    const fake = workPath("fake2.pdf");
    fs.writeFileSync(fake, "not a pdf at all");
    await selectFile(page, fake);
    await expect(page.getByTestId("compress-unreadable")).toBeVisible({ timeout: 20_000 });
    const src = await writePhotoPdf(page, "photo-after-fake.pdf");
    await page.locator('input[type="file"]').first().setInputFiles(src);
    await expect(page.getByTestId("compress-unreadable")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "圧縮する" })).toBeEnabled({ timeout: 20_000 });
  });

  test("圧縮処理の途中で失敗したときは、圧縮の失敗として伝え、結果（ダウンロード）を出さない", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo-fail.pdf");
    await openWithPdf(page, src);
    // 画像の作り直し（canvas の JPEG 書き出し）で失敗させる
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.toBlob = function () {
        throw new Error("simulated encode failure");
      };
    });
    await page.getByRole("button", { name: "圧縮する" }).click();
    await expect(page.getByText("PDFの画像の圧縮に失敗しました")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("compress-result")).toHaveCount(0);
    await expect(page.getByTestId("compress-unreadable")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3. 目標のサイズ（MB）を指定する圧縮
// ---------------------------------------------------------------------------
plainTest.describe("目標のサイズ（画面なし）", () => {
  plainTest("MBの入力を確かめる（小数・全角・単位つき）。元のPDFがすでに目標以下なら、そのことを伝える", () => {
    expect(parseTargetMB("2", 5_000_000)).toEqual({ ok: true, bytes: 2_000_000, mb: 2 });
    expect(parseTargetMB(" １．５ ", 5_000_000)).toEqual({ ok: true, bytes: 1_500_000, mb: 1.5 });
    expect(parseTargetMB("0.5MB", 5_000_000)).toEqual({ ok: true, bytes: 500_000, mb: 0.5 });
    const msg = (raw: string, original: number | null = 5_000_000) => {
      const r = parseTargetMB(raw, original);
      return r.ok ? "" : r.message;
    };
    expect(msg("")).toContain("MBの数字で入力してください");
    expect(msg("abc")).toContain("数字で入力してください");
    expect(msg("-1")).toContain("数字で入力してください");
    expect(msg("0.01")).toContain("0.05〜1000MBの範囲");
    expect(msg("5")).toContain("すでに5MB以下です");
    expect(msg("0.5", 30_000)).toContain("すでに十分小さい");
    // PDFを選ぶ前は、元のサイズとの比較はしない
    expect(parseTargetMB("1", null).ok).toBe(true);
  });

  plainTest("初期値は元のサイズの半分（切り捨て）。目標の表示は1MB＝1,000,000バイト", () => {
    expect(suggestTargetMB(1_184_332)).toBe("0.5");
    expect(suggestTargetMB(10_000_000)).toBe("5");
    expect(suggestTargetMB(150_000)).toBe("0.07");
    expect(suggestTargetMB(20_000)).toBe("0.05");
    expect(formatTargetMB(1_500_000)).toBe("1.50MB");
  });

  plainTest("試す段階は、上から下へ画質も画像の大きさも下がっていく（二分探索の前提）", () => {
    for (let i = 1; i < TARGET_LADDER.length; i++) {
      expect(TARGET_LADDER[i].imageQuality).toBeLessThan(TARGET_LADDER[i - 1].imageQuality);
      expect(TARGET_LADDER[i].maxImageEdge!).toBeLessThan(TARGET_LADDER[i - 1].maxImageEdge!);
      expect(TARGET_LADDER[i].recompressImages).toBe(true);
    }
  });
});

/** ブラウザで、写真のような画像をPNG（JPEG以外）で作る */
async function makePhotoPng(page: Page, width: number, height: number, opts: { transparentCorner?: boolean } = {}): Promise<Buffer> {
  const transparentCorner = opts.transparentCorner ?? false;
  const base64 = await page.evaluate(
    async ({ width, height, transparentCorner }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.createImageData(width, height);
      // 縮めにくい（ランダムな）画素にする
      for (let i = 0; i < img.data.length; i += 65536) crypto.getRandomValues(img.data.subarray(i, Math.min(i + 65536, img.data.length)));
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
      // 左上の4分の1を半透明にする（PDFでは、透明度が別の画像（SMask）になる）
      if (transparentCorner) {
        for (let y = 0; y < height / 2; y++) for (let x = 0; x < width / 2; x++) img.data[(y * width + x) * 4 + 3] = 128;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { width, height, transparentCorner }
  );
  return Buffer.from(base64, "base64");
}

test.describe("PDF圧縮：目標のサイズ（MB）を指定する", () => {
  test("初期は「サイズを指定する」で、PDFを選ぶと元のサイズの半分が入る。そのまま押すと目標以下になり、文字・ページはそのまま。目標を大きくすると画質を保った結果になる", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo.pdf");
    const original = fs.statSync(src).size;
    await openWithPdf(page, src, "target");
    await expect(page.getByTestId("compress-mode-target")).toBeChecked();
    await expect(page.getByTestId("compress-target-mb")).toHaveValue(suggestTargetMB(original));
    await expect(page.getByTestId("compress-original-size")).toContainText(formatTargetMB(original));
    // 元のサイズより小さい候補だけを出す（元は約1.2MB）
    await expect(page.getByTestId("compress-target-choice-1")).toBeVisible();
    await expect(page.getByTestId("compress-target-choice-2")).toHaveCount(0);

    const half = await compressAndSave(page, "half.pdf");
    const halfTarget = Number(suggestTargetMB(original)) * 1_000_000;
    expect(fs.statSync(half).size).toBeLessThanOrEqual(halfTarget);
    await expect(page.getByTestId("compress-target-result")).toContainText(`目標の${formatTargetMB(halfTarget)}以下になりました`);
    await expect(page.getByTestId("compress-used-settings")).toContainText("目標のサイズに合わせて自動で調整");
    const content = await extractPdfContent(half);
    expect(content.pageCount).toBe(2);
    expect(content.text).toContain("Searchable text page one");
    const halfImages = await imageSizes(half);

    // 目標を変えると、前の結果は消える。1MBを選ぶと、0.5MBのときより画像を大きく残せる
    await closeResultPopup(page);
    await page.getByTestId("compress-target-choice-1").click();
    await expect(page.getByTestId("compress-target-mb")).toHaveValue("1");
    await expect(page.getByTestId("compress-result")).toHaveCount(0);
    const one = await compressAndSave(page, "one.pdf");
    expect(fs.statSync(one).size).toBeLessThanOrEqual(1_000_000);
    expect(fs.statSync(one).size).toBeGreaterThan(fs.statSync(half).size);
    expect((await imageSizes(one))[0].width).toBeGreaterThanOrEqual(halfImages[0].width);
  });

  test("目標に届かないPDF（小さな画像がたくさん）は、そのことと理由・次の手を伝え、いちばん小さくできた結果をダウンロードできる", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    // JPEGにする対象より小さい画像（150×150）を、たくさん並べる（写真ではないため、作り直さない）
    const doc = await PDFDocument.create();
    const pdfPage = doc.addPage([595, 842]);
    for (let i = 0; i < 15; i++) {
      const image = await doc.embedPng(await makePhotoPng(page, 150, 150));
      pdfPage.drawImage(image, { x: 20 + (i % 5) * 110, y: 600 - Math.floor(i / 5) * 110, width: 100, height: 100 });
    }
    expect(150 * 150).toBeLessThan(FLATE_PHOTO_MIN_PIXELS);
    const src = workPath("png.pdf");
    fs.writeFileSync(src, await doc.save());
    expect(fs.statSync(src).size).toBeGreaterThan(200_000);

    await openWithPdf(page, src, "target");
    await page.getByTestId("compress-target-mb").fill("0.05");
    const out = await compressAndSave(page, "png-out.pdf");
    await expect(page.getByTestId("compress-target-result")).toContainText("届きませんでした");
    await expect(page.getByTestId("compress-target-result")).toContainText("PDF分割");
    expect(fs.statSync(out).size).toBeGreaterThan(50_000);
    expect((await extractPdfContent(out)).pageCount).toBe(1);
  });

  test("目標のサイズの入力を確かめ、直し方を案内する。直すと押せるようになる", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const src = await writePhotoPdf(page, "photo.pdf");
    await openWithPdf(page, src, "target");
    const input = page.getByTestId("compress-target-mb");
    const run = page.getByRole("button", { name: "圧縮する" });

    await input.fill("");
    await expect(page.getByTestId("compress-target-error")).toContainText("MBの数字で入力してください");
    await expect(run).toBeDisabled();
    await input.fill("abc");
    await expect(page.getByTestId("compress-target-error")).toContainText("数字で入力してください");
    await input.fill("５０");
    await expect(page.getByTestId("compress-target-error")).toContainText("すでに50MB以下です");
    await expect(run).toBeDisabled();
    await input.fill("０．８");
    await expect(page.getByTestId("compress-target-error")).toHaveCount(0);
    await expect(run).toBeEnabled();
  });

  test("とても小さいPDFは、サイズの指定では圧縮できないことと、「画質を指定する」を案内する", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const src = workPath("tiny.pdf");
    fs.writeFileSync(src, await doc.save());
    await waitForFileInputHydrated(page);
    await page.locator('input[type="file"]').first().setInputFiles(src);
    await expect(page.getByTestId("compress-target-error")).toContainText("すでに十分小さい", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "圧縮する" })).toBeDisabled();
    await page.getByTestId("compress-mode-quality").check();
    await expect(page.getByRole("button", { name: "圧縮する" })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// 4. JPEG以外（Flate）で入っている写真をJPEGにする
// ---------------------------------------------------------------------------

/** テスト用：PNGの予測（行ごとのフィルター）をかける（unpredictPng の逆） */
function predictPng(pixels: Uint8Array, width: number, height: number, components: number, filterOf: (y: number) => number): Uint8Array {
  const rowBytes = width * components;
  const out = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const f = filterOf(y);
    out[y * (rowBytes + 1)] = f;
    for (let x = 0; x < rowBytes; x++) {
      const cur = pixels[y * rowBytes + x];
      const left = x >= components ? pixels[y * rowBytes + x - components] : 0;
      const up = y > 0 ? pixels[(y - 1) * rowBytes + x] : 0;
      const upLeft = y > 0 && x >= components ? pixels[(y - 1) * rowBytes + x - components] : 0;
      let pred = 0;
      if (f === 1) pred = left;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * (rowBytes + 1) + 1 + x] = (cur - pred) & 0xff;
    }
  }
  return out;
}

plainTest.describe("PNGの予測を戻す（画面なし）", () => {
  plainTest("5種類のフィルター（なし・左・上・平均・Paeth）を、行ごとに混ぜても元の画素に戻る。長さが足りない・知らない種類は扱わない", () => {
    const width = 7;
    const height = 10;
    for (const components of [1, 3]) {
      const pixels = new Uint8Array(width * height * components);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + 11) % 256;
      const encoded = predictPng(pixels, width, height, components, (y) => y % 5);
      expect(Array.from(unpredictPng(encoded, width, height, components)!)).toEqual(Array.from(pixels));
    }
    expect(unpredictPng(new Uint8Array(5), width, height, 3)).toBeNull();
    const bad = predictPng(new Uint8Array(width * height * 3), width, height, 3, () => 0);
    bad[0] = 9;
    expect(unpredictPng(bad, width, height, 3)).toBeNull();
  });
});

/** PDFの画像を調べる（フィルター・色空間・透明度の画像） */
async function imageInfos(file: string) {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const infos: { width: number; filter: string; colorSpace: string; smask: { filter: string; colorSpace: string } | null; bytes: Uint8Array }[] = [];
  const smaskRefs = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("SMask")) instanceof PDFRef) smaskRefs.add(String(obj.dict.get(PDFName.of("SMask"))));
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image") || smaskRefs.has(String(ref))) continue;
    const smaskRef = obj.dict.get(PDFName.of("SMask"));
    const smask = smaskRef instanceof PDFRef ? (doc.context.lookup(smaskRef) as PDFRawStream) : null;
    infos.push({
      width: (obj.dict.get(PDFName.of("Width")) as PDFNumber).asNumber(),
      filter: String(obj.dict.get(PDFName.of("Filter"))),
      colorSpace: String(obj.dict.get(PDFName.of("ColorSpace"))),
      smask: smask ? { filter: String(smask.dict.get(PDFName.of("Filter"))), colorSpace: String(smask.dict.get(PDFName.of("ColorSpace"))) } : null,
      bytes: obj.contents,
    });
  }
  return infos;
}

/** JPEGのバイト列を、ブラウザで読んで、指定した位置の色を返す */
async function jpegPixel(page: Page, bytes: Uint8Array, fx: number, fy: number): Promise<number[]> {
  return page.evaluate(
    async ({ b64, fx, fy }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr], { type: "image/jpeg" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(Math.floor(bmp.width * fx), Math.floor(bmp.height * fy), 1, 1).data).slice(0, 3);
    },
    { b64: Buffer.from(bytes).toString("base64"), fx, fy }
  );
}

test.describe("PDF圧縮：JPEG以外で入っている写真をJPEGにする", () => {
  test("PNGの写真（透明度つき）はJPEGになって目標以下になり、透明度の画像はそのまま残る。文字もそのまま", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    const png = await makePhotoPng(page, 1200, 900, { transparentCorner: true });
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const image = await doc.embedPng(png); // pdf-lib は、PNGを Flate の画像＋透明度（SMask）として入れる
    const p = doc.addPage([595, 842]);
    p.drawText("Flate photo page", { x: 50, y: 790, size: 14, font });
    p.drawImage(image, { x: 50, y: 300, width: 495, height: 371 });
    const src = workPath("flate-photo.pdf");
    fs.writeFileSync(src, await doc.save());
    const before = await imageInfos(src);
    expect(before).toHaveLength(1);
    expect(before[0].filter).toBe("/FlateDecode");
    expect(before[0].smask).not.toBeNull();

    await openWithPdf(page, src, "target");
    const original = fs.statSync(src).size;
    const target = Math.floor((original / 4) / 10_000) / 100; // 元の4分の1程度（MB）
    await page.getByTestId("compress-target-mb").fill(String(target));
    const out = await compressAndSave(page, "flate-out.pdf");
    expect(fs.statSync(out).size).toBeLessThanOrEqual(target * 1_000_000);
    await expect(page.getByTestId("compress-target-result")).toContainText("以下になりました");
    await expect(page.getByTestId("compress-image-stats")).toContainText("JPEG以外で入っていた写真1個は、JPEGにしました");

    const after = await imageInfos(out);
    expect(after).toHaveLength(1);
    expect(after[0].filter).toBe("/DCTDecode");
    expect(after[0].colorSpace).toBe("/DeviceRGB");
    // 透明度の画像は、JPEGにしない（グレーのFlateのまま）
    expect(after[0].smask).toEqual({ filter: "/FlateDecode", colorSpace: "/DeviceGray" });
    const content = await extractPdfContent(out);
    expect(content.text).toContain("Flate photo page");
  });

  test("PNGの予測（Predictor 15）つきで入っている写真も、正しい色のままJPEGになる。「画像はそのまま」では変えない", async ({ page }) => {
    await page.goto("/tools/pdf-compress");
    // 左上が赤、右下が青になる、なめらかなグラデーション（800×600、RGB）。行ごとに違うフィルターで保存する
    const width = 800;
    const height = 600;
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = (x / width + y / height) / 2;
        const o = (y * width + x) * 3;
        pixels[o] = Math.round(220 * (1 - t));
        pixels[o + 1] = Math.round(60 + 80 * Math.sin(x / 40) * Math.cos(y / 50) + 60);
        pixels[o + 2] = Math.round(220 * t);
      }
    }
    const data = zlib.deflateSync(Buffer.from(predictPng(pixels, width, height, 3, (y) => y % 5)), { level: 1 });
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Type: "XObject",
      Subtype: "Image",
      Width: width,
      Height: height,
      ColorSpace: "DeviceRGB",
      BitsPerComponent: 8,
      Filter: "FlateDecode",
      DecodeParms: doc.context.obj({ Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: width }),
    }) as PDFDict;
    const imageRef = doc.context.register(PDFRawStream.of(dict, new Uint8Array(data)));
    const pdfPage = doc.addPage([595, 842]);
    const name = pdfPage.node.newXObject("ImPred", imageRef);
    pdfPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(495, 0, 0, 371, 50, 300), drawObject(name), popGraphicsState());
    const src = workPath("predictor.pdf");
    fs.writeFileSync(src, await doc.save());
    expect(fs.statSync(src).size).toBeGreaterThan(30_000);

    // 「画像はそのまま」では、変えない
    await openWithPdf(page, src, "quality");
    await page.getByTestId("compress-preset-structure").click();
    const kept = await compressAndSave(page, "predictor-kept.pdf");
    expect((await imageInfos(kept))[0].filter).toBe("/FlateDecode");

    // 標準の設定では、JPEGになり、色は元とほぼ同じ（左上は赤、右下は青、中央はその間）
    await closeResultPopup(page);
    await page.getByTestId("compress-preset-standard").click();
    const out = await compressAndSave(page, "predictor-out.pdf");
    const info = (await imageInfos(out))[0];
    expect(info.filter).toBe("/DCTDecode");
    expect(info.width).toBe(width);
    for (const [fx, fy] of [
      [0.02, 0.02],
      [0.5, 0.5],
      [0.98, 0.98],
    ]) {
      const [r, g, b] = await jpegPixel(page, info.bytes, fx, fy);
      const ox = Math.floor(width * fx);
      const oy = Math.floor(height * fy);
      const o = (oy * width + ox) * 3;
      expect(Math.abs(r - pixels[o])).toBeLessThan(25);
      expect(Math.abs(g - pixels[o + 1])).toBeLessThan(25);
      expect(Math.abs(b - pixels[o + 2])).toBeLessThan(25);
    }
  });
});
