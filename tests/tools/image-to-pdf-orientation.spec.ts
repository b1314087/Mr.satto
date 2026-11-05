import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { execFileSync } from "node:child_process";
import { clickAndDownload, closeResultPopup } from "../helpers/tool-runner";
import { orientationMatrix, readJpegOrientation, type ExifOrientation } from "@/lib/image/exif-orientation";

/**
 * 画像→PDF：スマートフォンの写真のように、JPEGの「向き」の印（EXIF Orientation）で回して表示する画像を、
 * 画面のプレビューと同じ向きでPDFにする（以前は、プレビューは縦なのに、PDFでは横に倒れていた）。
 * 画像は、テストの中でブラウザに作らせた架空の画像（横長）に、向きの印だけを付けたもの。
 */

// ---------------------------------------------------------------------------
// 1. 規則
// ---------------------------------------------------------------------------

/** "Exif" の APP1 セグメント（Orientation だけを持つ、ビッグエンディアンのTIFF） */
function exifSegment(orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = body.length + 2;
  return new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}

/** JPEG（FFD8 の直後）に EXIF を差し込む */
function withExif(jpeg: Uint8Array, orientation: number): Uint8Array {
  const seg = exifSegment(orientation);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

plainTest("EXIFの向き：JPEGから Orientation を読み、無い・壊れているときは 1", () => {
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  plainExpect(readJpegOrientation(fakeJpeg)).toBe(1);
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) plainExpect(readJpegOrientation(withExif(fakeJpeg, o))).toBe(o);
  plainExpect(readJpegOrientation(withExif(fakeJpeg, 9))).toBe(1);
  plainExpect(readJpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
});

plainTest("EXIFの向き：元の画像の隅が、表示したときの枠の正しい隅へ行く", () => {
  const apply = (m: number[], u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  // 枠：左下(10,20)・幅100・高さ200。元画像の左上は (0,1)、右上は (1,1)
  const box = { x: 10, y: 20, w: 100, h: 200 };
  const TL = [10, 220];
  const TR = [110, 220];
  const BL = [10, 20];
  const BR = [110, 20];
  const expectCorner = (o: ExifOrientation, rawTL: number[], rawTR: number[]) => {
    const m = orientationMatrix(o, box.x, box.y, box.w, box.h);
    plainExpect(apply(m, 0, 1)).toEqual(rawTL);
    plainExpect(apply(m, 1, 1)).toEqual(rawTR);
  };
  expectCorner(1, TL, TR);
  expectCorner(3, BR, BL);
  // 時計回りに90度：元の左上は右上へ、元の右上は右下へ
  expectCorner(6, TR, BR);
  // 反時計回りに90度：元の左上は左下へ、元の右上は左上へ
  expectCorner(8, BL, TL);
  expectCorner(2, TR, TL);
});

// ---------------------------------------------------------------------------
// 2. 画面からPDFまで
// ---------------------------------------------------------------------------

/** ブラウザで横長（160×80）の JPEG を作る（左半分が赤、右半分が青） */
async function makeLandscapeJpeg(page: Page): Promise<Uint8Array> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 80;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 80, 80);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(80, 0, 80, 80);
    return c.toDataURL("image/jpeg", 0.95).split(",")[1];
  });
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function pageSizes(file: string): Promise<{ w: number; h: number }[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  const out: { w: number; h: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    out.push({ w: vp.width, h: vp.height });
  }
  return out;
}

test("画像→PDF：EXIFで90度回して表示する写真（プレビューで縦）は、PDFでも縦のまま（画像サイズのまま・A4に収める）", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tools/image-to-pdf");
  const jpeg = withExif(await makeLandscapeJpeg(page), 6);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img2pdf-"));
  const file = path.join(dir, "縦の写真.jpg");
  fs.writeFileSync(file, jpeg);

  await page.locator('input[type="file"]').first().setInputFiles(file);
  const run = page.getByRole("button", { name: /件の画像をPDF化する/ });
  await expect(run).toBeVisible({ timeout: 30_000 });

  // 画像サイズのまま：ページは表示の向き（縦長 80×160）
  await run.click();
  await expect(page.getByText("PDFの作成が完了しました")).toBeVisible({ timeout: 60_000 });
  const dl = await clickAndDownload(page, "ダウンロード");
  const out = path.join(dir, "fit.pdf");
  await dl.saveAs(out);
  const [fit] = await pageSizes(out);
  plainExpect(fit.h).toBeGreaterThan(fit.w);

  // 色の位置：縦にした写真は、上が赤・下が青（時計回りに90度回すと、元の左（赤）が上になる）
  const top = pixelAt(out, 0.5, 0.2);
  const bottom = pixelAt(out, 0.5, 0.8);
  plainExpect(top[0]).toBeGreaterThan(180);
  plainExpect(top[2]).toBeLessThan(90);
  plainExpect(bottom[2]).toBeGreaterThan(180);
  plainExpect(bottom[0]).toBeLessThan(90);

  // A4に収める：縦長の写真なので、A4の縦のページに、縦長のまま入る
  await closeResultPopup(page);
  await page.getByRole("button", { name: "A4に収める" }).click();
  await run.click();
  await expect(page.getByText("PDFの作成が完了しました")).toBeVisible({ timeout: 60_000 });
  const dl2 = await clickAndDownload(page, "ダウンロード");
  const out2 = path.join(dir, "a4.pdf");
  await dl2.saveAs(out2);
  const [a4] = await pageSizes(out2);
  plainExpect(Math.round(a4.w)).toBe(595);
  plainExpect(Math.round(a4.h)).toBe(842);
  plainExpect(pixelAt(out2, 0.5, 0.3)[0]).toBeGreaterThan(180);
  plainExpect(pixelAt(out2, 0.5, 0.7)[2]).toBeGreaterThan(180);
});

/** PDFの1ページ目の、(横の割合, 縦の割合) の位置の色 [R, G, B]（pdftoppm で画像にして読む） */
function pixelAt(pdf: string, fx: number, fy: number): [number, number, number] {
  const base = pdf.replace(/\.pdf$/, "-px");
  execFileSync("pdftoppm", ["-r", "36", "-f", "1", "-l", "1", "-singlefile", pdf, base]);
  const buf = fs.readFileSync(`${base}.ppm`);
  // P6 の見出し（"P6\n幅 高さ\n255\n"）を読む
  const header = buf.subarray(0, 40).toString("latin1").split(/\s+/);
  const w = Number(header[1]);
  const h = Number(header[2]);
  let offset = 0;
  let fields = 0;
  while (fields < 4) {
    while (/\s/.test(String.fromCharCode(buf[offset]))) offset++;
    while (!/\s/.test(String.fromCharCode(buf[offset]))) offset++;
    fields++;
  }
  offset++;
  const x = Math.min(w - 1, Math.floor(w * fx));
  const y = Math.min(h - 1, Math.floor(h * fy));
  const i = offset + (y * w + x) * 3;
  return [buf[i], buf[i + 1], buf[i + 2]];
}
