import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest } from "@playwright/test";
import type { Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, closeResultPopup, waitForFileInputHydrated } from "../helpers/tool-runner";
import { extractPdfContent } from "../helpers/pdf-inspect";
import {
  DEFAULT_PRESET_ID,
  PDF_COMPRESS_PRESETS,
  fitWithinEdge,
  getPreset,
  matchPreset,
  parseIntegerSetting,
  sizeReduction,
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

async function openWithPdf(page: Page, file: string) {
  await page.goto("/tools/pdf-compress");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(file);
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
  test("設定に触れずに「圧縮する」だけで、標準の設定で圧縮できる。結果の表示（削減サイズ・割合）が正しく、PDFは正常に開け、文字はそのまま", async ({ page }) => {
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

  test("壊れたPDFは、これまでどおりの読み込みエラーを出す", async ({ page }) => {
    const broken = workPath("broken.pdf");
    fs.writeFileSync(broken, "this is not a pdf");
    await openWithPdf(page, broken);
    await page.getByRole("button", { name: "圧縮する" }).click();
    await expect(page.getByText(/broken\.pdf の読み込みに失敗しました/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("compress-result")).toHaveCount(0);
  });
});
