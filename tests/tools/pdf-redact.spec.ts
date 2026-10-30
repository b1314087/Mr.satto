import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { unzlibSync } from "fflate";
import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees, rgb } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, assertDownloadedFile, waitForSuccess } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import {
  REDACT_MAX_PAGES,
  REDACT_MAX_REDACTED_PAGES,
  RedactError,
  groupRegionsByPage,
  normalizeRegion,
  regionToPixelRect,
  renderScaleFor,
  validateRedactPlan,
} from "@/lib/pdf/redact";

/**
 * PDF黒塗り・墨消し（pdf-redact）のテスト。
 * 1. 範囲の決まり（純粋な関数）の単体テスト
 * 2. 実際にPDFを選び、範囲を指定して黒塗りし、できあがったPDFから「元のデータが残っていない」ことを確認する画面テスト
 *    - 文字抽出で取れない / ファイルの中身（圧縮を展開したものを含む）に対象文字が残っていない
 *    - 範囲を指定しなかったページの文字は残る / リンクを通じて黒塗りしたページが持ち込まれていない
 *    - 黒塗りの位置が、指定した場所と一致する（拡大・スクロール・回転・複数範囲・複数ページ）
 * 3. 異常系と、ファイルの内容が外部へ送信されないことの確認
 */

const SECRET_A = "SECRET-ALPHA-1111";
const SECRET_B = "SECRET-BETA-2222";
const SECRET_ROT = "SECRET-ROT-3333";
const PAGE_W = 600;
const PAGE_H = 800;

// ---------------------------------------------------------------------------
// 1. 範囲の決まり
// ---------------------------------------------------------------------------
plainTest.describe("pdf-redact: 範囲の決まり", () => {
  plainTest("範囲は0〜1に収め、逆向きのドラッグは入れ替え、小さすぎる・数値でない範囲は無視する", () => {
    const swapped = normalizeRegion({ page: 0, x: 0.5, y: 0.5, width: -0.2, height: -0.1 })!;
    plainExpect(swapped.page).toBe(0);
    plainExpect(swapped.x).toBeCloseTo(0.3, 10);
    plainExpect(swapped.y).toBeCloseTo(0.4, 10);
    plainExpect(swapped.width).toBeCloseTo(0.2, 10);
    plainExpect(swapped.height).toBeCloseTo(0.1, 10);
    const clamped = normalizeRegion({ page: 1, x: -0.2, y: 0.9, width: 0.5, height: 0.5 })!;
    plainExpect(clamped.x).toBe(0);
    plainExpect(clamped.width).toBeCloseTo(0.3, 10);
    plainExpect(clamped.y).toBeCloseTo(0.9, 10);
    plainExpect(clamped.y + clamped.height).toBeCloseTo(1, 10);
    plainExpect(normalizeRegion({ page: 0, x: 0.1, y: 0.1, width: 0.001, height: 0.3 })).toBeNull();
    plainExpect(normalizeRegion({ page: 0, x: Number.NaN, y: 0.1, width: 0.3, height: 0.3 })).toBeNull();
    plainExpect(normalizeRegion({ page: -1, x: 0.1, y: 0.1, width: 0.3, height: 0.3 })).toBeNull();
    plainExpect(normalizeRegion({ page: 0.5, x: 0.1, y: 0.1, width: 0.3, height: 0.3 })).toBeNull();
  });

  plainTest("ピクセルの範囲は、外側へ切り上げ、画像の外へはみ出さない", () => {
    const r = regionToPixelRect({ page: 0, x: 0.1234, y: 0.2, width: 0.5, height: 0.3333 }, 1000, 1500);
    plainExpect(r.left).toBe(123); // 123.4 → 切り捨て
    plainExpect(r.left + r.width).toBe(Math.ceil((0.1234 + 0.5) * 1000)); // 右端は切り上げ
    plainExpect(r.top).toBe(300);
    plainExpect(r.top + r.height).toBe(Math.ceil((0.2 + 0.3333) * 1500));
    const edge = regionToPixelRect({ page: 0, x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 333, 777);
    plainExpect(edge.left + edge.width).toBeLessThanOrEqual(333);
    plainExpect(edge.top + edge.height).toBeLessThanOrEqual(777);
  });

  plainTest("画像にする倍率は、通常は2倍。大きすぎるページは、1辺のピクセル数が上限に収まるまで下げる", () => {
    plainExpect(renderScaleFor(595, 842)).toBe(2);
    const huge = renderScaleFor(3000, 4000);
    plainExpect(huge).toBeLessThan(2);
    plainExpect(4000 * huge).toBeLessThanOrEqual(4000 + 1e-9);
    plainExpect(renderScaleFor(0, 0)).toBe(2);
  });

  plainTest("ページごとにまとめ、入力のチェックで、範囲なし・存在しないページ・ページ数の上限を止める", () => {
    const a = { page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
    const grouped = groupRegionsByPage([a, { ...a, page: 2 }, { ...a, width: 0.0001 }, { ...a, x: 0.5 }]);
    plainExpect([...grouped.keys()]).toEqual([0, 2]);
    plainExpect(grouped.get(0)).toHaveLength(2);

    plainExpect(() => validateRedactPlan(3, [])).toThrow("範囲が指定されていません");
    plainExpect(() => validateRedactPlan(3, [{ ...a, page: 3 }])).toThrow("存在しないページ");
    plainExpect(() => validateRedactPlan(0, [a])).toThrow(RedactError);
    plainExpect(() => validateRedactPlan(REDACT_MAX_PAGES + 1, [a])).toThrow("ページ数が多すぎます");
    const many = Array.from({ length: REDACT_MAX_REDACTED_PAGES + 1 }, (_, i) => ({ ...a, page: i }));
    plainExpect(() => validateRedactPlan(REDACT_MAX_PAGES, many)).toThrow("黒塗りするページが多すぎます");
    plainExpect(validateRedactPlan(REDACT_MAX_PAGES, many.slice(0, REDACT_MAX_REDACTED_PAGES)).size).toBe(REDACT_MAX_REDACTED_PAGES);
  });
});

// ---------------------------------------------------------------------------
// テスト用のPDF・補助
// ---------------------------------------------------------------------------
let dir: string;
const files: Record<string, string> = {};

/** 4ページ。1・2ページに対象の文字、3ページには黒塗りするページ（2ページ目）へのリンク、4ページは対象外 */
async function buildTextPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([PAGE_W, PAGE_H]);
  p1.drawText("PUBLIC-ONE", { x: 50, y: 740, size: 24, font });
  p1.drawText(SECRET_A, { x: 50, y: 600, size: 24, font });
  const p2 = doc.addPage([PAGE_W, PAGE_H]);
  p2.drawText("PUBLIC-TWO", { x: 50, y: 740, size: 24, font });
  p2.drawText(SECRET_B, { x: 50, y: 400, size: 24, font });
  const p3 = doc.addPage([PAGE_W, PAGE_H]);
  p3.drawText("PUBLIC-THREE", { x: 50, y: 740, size: 24, font });
  // 3ページ目から、黒塗りするページ（2ページ目）へのリンク（リンク経由で元のページが持ち込まれないことの確認用）
  const link = doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [50, 700, 250, 730],
    Border: [0, 0, 0],
    Dest: [p2.ref, "XYZ", null, null, null],
  });
  p3.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  const p4 = doc.addPage([PAGE_W, PAGE_H]);
  p4.drawText("PUBLIC-FOUR", { x: 50, y: 740, size: 24, font });
  return doc.save();
}

/** 全面が赤い1ページ（スキャンPDFの代わり。文字情報は無く、画像だけ）。画像の中の青い四角が対象 */
async function buildImageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(encodePng(120, 160, (x, y) => (x >= 40 && x < 80 && y >= 60 && y < 100 ? [0, 0, 255] : [255, 0, 0])));
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawImage(image, { x: 0, y: 0, width: PAGE_W, height: PAGE_H });
  return doc.save();
}

/** 回転（時計回りに90度）したページ。ページ全体が赤で、対象の文字がある */
async function buildRotatedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: rgb(1, 0, 0) });
  page.drawText(SECRET_ROT, { x: 50, y: 400, size: 24, font, color: rgb(1, 1, 1) });
  page.setRotation(degrees(90));
  return doc.save();
}

/** 最小限のPNG（RGB 8bit）。画像の各ピクセルの色は color(x, y) で決める */
function encodePng(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

/** PDFのバイト列を、そのままの文字と、圧縮（Flate）を展開した文字の両方にして返す（文字が残っていないかの検査用） */
function readableContent(buf: Buffer): string {
  let text = buf.toString("latin1");
  let from = 0;
  for (;;) {
    const start = buf.indexOf("stream", from, "latin1");
    if (start < 0) break;
    let begin = start + "stream".length;
    if (buf[begin] === 0x0d) begin++;
    if (buf[begin] === 0x0a) begin++;
    const end = buf.indexOf("endstream", begin, "latin1");
    if (end < 0) break;
    try {
      text += "\n" + Buffer.from(unzlibSync(new Uint8Array(buf.subarray(begin, end)))).toString("latin1");
    } catch {
      // 圧縮されていない（画像など）データは、そのままの文字として上で含めてある
    }
    from = end + "endstream".length;
  }
  // pdf-libなどは、文字を16進数の文字列（<5345...> Tj）として書く。読める文字にも直して、検索対象に加える
  const decoded: string[] = [];
  for (const m of text.matchAll(/<([0-9A-Fa-f]{4,})>/g)) {
    const hex = m[1].length % 2 === 0 ? m[1] : m[1] + "0";
    decoded.push(Buffer.from(hex, "hex").toString("latin1"));
  }
  return text + "\n" + decoded.join("\n");
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-redact-"));
  files.text = path.join(dir, "text.pdf");
  fs.writeFileSync(files.text, await buildTextPdf());
  files.image = path.join(dir, "scan.pdf");
  fs.writeFileSync(files.image, await buildImageOnlyPdf());
  files.rotated = path.join(dir, "rotated.pdf");
  fs.writeFileSync(files.rotated, await buildRotatedPdf());
  files.txt = path.join(dir, "memo.txt");
  fs.writeFileSync(files.txt, "メモ");
  files.fake = path.join(dir, "fake.pdf");
  fs.writeFileSync(files.fake, "これはPDFではありません。SECRET-FAKE-9999");
  const many = await PDFDocument.create();
  for (let i = 0; i < REDACT_MAX_PAGES + 1; i++) many.addPage([200, 200]);
  files.many = path.join(dir, "many.pdf");
  fs.writeFileSync(files.many, await many.save());
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 検査用の注意: 元のPDFには対象の文字が、圧縮を展開すれば見つかること（検査の方法自体が正しく働くことの確認） */
test("pdf-redact: 検査の前提 — 元のPDFには対象の文字が含まれ、文字抽出でも取れる", async () => {
  const source = fs.readFileSync(files.text);
  const readable = readableContent(source);
  expect(readable).toContain(SECRET_A);
  expect(readable).toContain(SECRET_B);
  const extracted = await extractPdfContent(files.text);
  expect(extracted.text).toContain(SECRET_A);
});

async function openTool(page: Page, file: string) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/tools/pdf-redact");
  await uploadWhenReady(page, [file], page.getByTestId("pdf-redact-canvas"), { readyTimeoutMs: 40_000 });
  await expect(page.getByTestId("pdf-redact-page-label")).toContainText("1 /");
  // ページの描画が終わるまで待つ
  await expect(page.getByText("ページを表示中…")).toBeHidden({ timeout: 30_000 });
}

/** 表示中のページの、割合の位置（fx, fy）が見える位置まで、表示領域をスクロールして、画面上の座標を返す */
async function aim(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const overlay = page.getByTestId("pdf-redact-overlay");
  await overlay.evaluate(
    (o, p) => {
      let c: HTMLElement | null = o.parentElement;
      while (c && !/overflow-auto/.test(c.className)) c = c.parentElement;
      if (!c) return;
      const oRect = o.getBoundingClientRect();
      const cRect = c.getBoundingClientRect();
      const px = oRect.left - cRect.left + c.scrollLeft + p.fx * oRect.width;
      const py = oRect.top - cRect.top + c.scrollTop + p.fy * oRect.height;
      c.scrollLeft = px - c.clientWidth / 2;
      c.scrollTop = py - c.clientHeight / 2;
    },
    { fx, fy }
  );
  const box = await overlay.boundingBox();
  if (!box) throw new Error("ページの表示領域が見つかりません");
  return { x: box.x + fx * box.width, y: box.y + fy * box.height };
}

/** ページ上を、割合の位置でドラッグして範囲を指定する（範囲が見える領域に収まるよう、中心を表示してから操作する） */
async function drawRegion(page: Page, fx1: number, fy1: number, fx2: number, fy2: number) {
  await page.getByTestId("pdf-redact-canvas").scrollIntoViewIfNeeded();
  await aim(page, (fx1 + fx2) / 2, (fy1 + fy2) / 2);
  const box = (await page.getByTestId("pdf-redact-overlay").boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + fx * box.width, y: box.y + fy * box.height });
  const a = at(fx1, fy1);
  const b = at(fx2, fy2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

/** 結果のサムネイル画像の、割合の位置のピクセル（RGB）を調べる */
async function thumbPixels(page: Page, thumbIndex: number, points: { fx: number; fy: number }[]): Promise<number[][]> {
  return page.getByTestId("pdf-thumb").nth(thumbIndex).evaluate(async (img, pts) => {
    const el = img as HTMLImageElement;
    await el.decode();
    const canvas = document.createElement("canvas");
    canvas.width = el.naturalWidth;
    canvas.height = el.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(el, 0, 0);
    return pts.map((p) => {
      const d = ctx.getImageData(Math.min(canvas.width - 1, Math.floor(p.fx * canvas.width)), Math.min(canvas.height - 1, Math.floor(p.fy * canvas.height)), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }, points);
}

const isBlack = (rgbv: number[]) => rgbv.every((v) => v < 40);
const isWhite = (rgbv: number[]) => rgbv.every((v) => v > 215);

async function runAndDownload(page: Page): Promise<string> {
  await page.getByRole("button", { name: "黒塗りを確定して新しいPDFを作る" }).click();
  await waitForSuccess(page, "黒塗りが完了しました");
  const download = await clickAndDownload(page, "黒塗りしたPDFをダウンロード");
  const { path: out } = await assertDownloadedFile(download, { format: "pdf", minBytes: 200 });
  return out;
}

// ---------------------------------------------------------------------------
// 2. 黒塗りの本体
// ---------------------------------------------------------------------------
test("pdf-redact: 複数の範囲・複数のページを黒塗りすると、対象の文字がPDFのどこにも残らず、対象外のページは保たれる。通信も発生しない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await openTool(page, files.text);

  // 1ページ目: 対象の行（1つ目）＋ 何も無い場所（2つ目）。2ページ目: 対象の行
  await drawRegion(page, 0.06, 0.2, 0.6, 0.285);
  await drawRegion(page, 0.7, 0.9, 0.95, 0.95);
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(2);
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(page.getByTestId("pdf-redact-page-label")).toContainText("2 /");
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(0);
  await expect(page.getByText("ページを表示中…")).toBeHidden({ timeout: 30_000 });
  await drawRegion(page, 0.06, 0.47, 0.5, 0.555);
  await expect(page.getByTestId("pdf-redact-summary")).toContainText("3個（2ページ）");

  const out = await runAndDownload(page);

  // 開ける・ページ数と大きさが元と同じ
  expect(isValidPdfFile(out)).toBe(true);
  const extracted = await extractPdfContent(out);
  expect(extracted.pageCount).toBe(4);
  for (const p of extracted.pages) {
    expect(p.width).toBeCloseTo(PAGE_W, 0);
    expect(p.height).toBeCloseTo(PAGE_H, 0);
  }
  // 文字抽出: 黒塗りしたページ（1・2）には文字が1つもない。対象外のページ（3・4）の文字は残る
  expect(extracted.pages[0].text.trim()).toBe("");
  expect(extracted.pages[1].text.trim()).toBe("");
  expect(extracted.pages[2].text).toContain("PUBLIC-THREE");
  expect(extracted.pages[3].text).toContain("PUBLIC-FOUR");
  // 検索・コピー（文字抽出と同じ文字データ）で、対象の文字が取れない
  expect(extracted.text).not.toContain("SECRET");
  expect(extracted.text).not.toContain(SECRET_A);
  expect(extracted.text).not.toContain(SECRET_B);

  // ファイルの中身（圧縮の展開を含む）に、対象の文字も、黒塗りしたページの他の文字も、残っていない
  const readable = readableContent(fs.readFileSync(out));
  for (const word of [SECRET_A, SECRET_B, "SECRET", "PUBLIC-ONE", "PUBLIC-TWO"]) {
    expect(readable, `出力に「${word}」が残っています`).not.toContain(word);
  }
  expect(readable).toContain("PUBLIC-THREE");

  // リンク・注釈は引き継がれず、黒塗りしたページがリンク経由で持ち込まれていない
  const outDoc = await PDFDocument.load(fs.readFileSync(out));
  expect(outDoc.getPageCount()).toBe(4);
  for (const p of outDoc.getPages()) {
    const annots = p.node.get(PDFName.of("Annots"));
    expect(annots === undefined || (annots instanceof PDFArray && annots.size() === 0)).toBe(true);
  }
  // 出力に含まれるページ（Pageオブジェクト）は4つだけ
  let pageObjects = 0;
  for (const [, obj] of outDoc.context.enumerateIndirectObjects()) {
    const dict = (obj as { dict?: { get(k: PDFName): unknown } }).dict ?? (obj as { get?(k: PDFName): unknown });
    const type = dict && typeof (dict as { get?: unknown }).get === "function" ? (dict as { get(k: PDFName): unknown }).get(PDFName.of("Type")) : undefined;
    if (type instanceof PDFName && type.decodeText() === "Page") pageObjects++;
  }
  expect(pageObjects).toBe(4);

  // 黒塗りの位置: 結果の画像で、指定した場所が黒、それ以外は元のまま（白）
  const [p1Target, p1Second, p1Elsewhere, p1TitleArea] = await thumbPixels(page, 0, [
    { fx: 0.33, fy: 0.24 },
    { fx: 0.82, fy: 0.925 },
    { fx: 0.5, fy: 0.6 },
    { fx: 0.9, fy: 0.05 },
  ]);
  expect(isBlack(p1Target)).toBe(true);
  expect(isBlack(p1Second)).toBe(true);
  expect(isWhite(p1Elsewhere)).toBe(true);
  expect(isWhite(p1TitleArea)).toBe(true);
  const [p2Target, p2Elsewhere] = await thumbPixels(page, 1, [
    { fx: 0.28, fy: 0.51 },
    { fx: 0.28, fy: 0.24 },
  ]);
  expect(isBlack(p2Target)).toBe(true);
  expect(isWhite(p2Elsewhere)).toBe(true);

  // 元のファイルは変更されない
  expect(readableContent(fs.readFileSync(files.text))).toContain(SECRET_A);

  // 通信: ファイルの内容（文字・名前）が自社API・外部へ送られていない
  const origin = new URL(baseURL!).origin;
  for (const needle of [SECRET_A, SECRET_B, "PUBLIC-THREE"]) expect(findLeakedRequests(recorder, needle)).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
});

test("pdf-redact: 拡大して、表示領域をスクロールしてから指定しても、同じ場所が黒塗りされる", async ({ page }) => {
  await openTool(page, files.text);
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(page.getByText("ページを表示中…")).toBeHidden({ timeout: 30_000 });
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "拡大" }).click();
  await expect(page.getByTestId("pdf-redact-zoom")).toHaveText("200%");
  await expect(page.getByText("ページを表示中…")).toBeHidden({ timeout: 30_000 });

  // 200%では、ページの下の方（文字の位置）は、スクロールしないと見えない
  await drawRegion(page, 0.05, 0.47, 0.42, 0.555);
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(1);

  // 縮小してから、もう1つ（別の場所）を指定する。縮小しても、最初の範囲は同じ場所を指す
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "縮小" }).click();
  await expect(page.getByTestId("pdf-redact-zoom")).toHaveText("50%");
  await expect(page.getByText("ページを表示中…")).toBeHidden({ timeout: 30_000 });
  const first = await page.getByTestId("pdf-redact-region").first().evaluate((el) => {
    const parent = el.parentElement!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: (r.left - parent.left) / parent.width, y: (r.top - parent.top) / parent.height };
  });
  expect(first.x).toBeCloseTo(0.05, 1);
  expect(first.y).toBeCloseTo(0.47, 1);
  await drawRegion(page, 0.6, 0.1, 0.9, 0.2);
  await expect(page.getByTestId("pdf-redact-summary")).toContainText("2個（1ページ）");

  const out = await runAndDownload(page);
  const extracted = await extractPdfContent(out);
  expect(extracted.pages[1].text.trim()).toBe("");
  expect(readableContent(fs.readFileSync(out))).not.toContain(SECRET_B);
  const [target, second, elsewhere] = await thumbPixels(page, 0, [
    { fx: 0.24, fy: 0.51 },
    { fx: 0.75, fy: 0.15 },
    { fx: 0.5, fy: 0.8 },
  ]);
  expect(isBlack(target)).toBe(true);
  expect(isBlack(second)).toBe(true);
  expect(isWhite(elsewhere)).toBe(true);
});

test("pdf-redact: 画像だけのPDF（スキャンPDFの代わり）は、指定した範囲の画像が出力に残らない", async ({ page }) => {
  await openTool(page, files.image);
  // 画像の青い四角（画像の x40〜80, y60〜100 / 120x160 → ページの 0.33〜0.67, 0.375〜0.625）の、中央の部分だけを囲む
  await drawRegion(page, 0.38, 0.42, 0.62, 0.58);
  const out = await runAndDownload(page);
  expect(isValidPdfFile(out)).toBe(true);

  const bytes = fs.readFileSync(out);
  // 元の画像（PNGをFlateで入れたもの。予測フィルタ付き）は出力に入っていない。入っているのは、新しく作ったJPEG画像だけ
  const text = bytes.toString("latin1");
  expect(text).toContain("/DCTDecode");
  expect(text).not.toContain("/Predictor"); // 元のPNG画像（予測フィルタ付きのFlate）のデータは引き継がれていない
  const imageCount = (text.match(/\/Subtype\s*\/Image/g) ?? []).length;
  expect(imageCount).toBe(1);

  // 結果の画像で: 囲んだ範囲は黒。囲まなかった青い四角の縁と、赤い部分は、そのまま
  const [center, blueEdge, red] = await thumbPixels(page, 0, [
    { fx: 0.5, fy: 0.5 },
    { fx: 0.35, fy: 0.5 },
    { fx: 0.1, fy: 0.1 },
  ]);
  expect(isBlack(center)).toBe(true);
  expect(blueEdge[2]).toBeGreaterThan(150);
  expect(blueEdge[0]).toBeLessThan(80);
  expect(red[0]).toBeGreaterThan(200);
  expect(red[1]).toBeLessThan(60);
});

test("pdf-redact: 回転したページでも、見えている場所が黒塗りされ、文字は残らない", async ({ page }) => {
  await openTool(page, files.rotated);
  // 90度回転したページは、横長（800x600）で表示される
  const box = (await page.getByTestId("pdf-redact-overlay").boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(PAGE_H / PAGE_W, 1);
  await drawRegion(page, 0.3, 0.3, 0.6, 0.6);
  const out = await runAndDownload(page);
  const extracted = await extractPdfContent(out);
  expect(extracted.pages[0].text.trim()).toBe("");
  expect(extracted.pages[0].width).toBeCloseTo(PAGE_H, 0);
  expect(extracted.pages[0].height).toBeCloseTo(PAGE_W, 0);
  expect(readableContent(fs.readFileSync(out))).not.toContain(SECRET_ROT);
  const [target, red] = await thumbPixels(page, 0, [
    { fx: 0.45, fy: 0.45 },
    { fx: 0.1, fy: 0.9 },
  ]);
  expect(isBlack(target)).toBe(true);
  expect(red[0]).toBeGreaterThan(200);
  expect(red[1]).toBeLessThan(60);
});

test("pdf-redact: 範囲の取り消し（直前・ページ単位・個別）ができ、範囲が無いと実行できない", async ({ page }) => {
  await openTool(page, files.text);
  const run = page.getByRole("button", { name: "黒塗りを確定して新しいPDFを作る" });
  await expect(run).toBeDisabled();
  await drawRegion(page, 0.1, 0.1, 0.3, 0.15);
  await drawRegion(page, 0.1, 0.2, 0.3, 0.25);
  await drawRegion(page, 0.1, 0.3, 0.3, 0.35);
  await expect(page.getByTestId("pdf-redact-summary")).toContainText("3個（1ページ）");
  await expect(run).toBeEnabled();

  await page.getByRole("button", { name: "直前の範囲を取り消す" }).click();
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(2);
  await page.getByRole("button", { name: "このページの範囲1を取り消す" }).click();
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(1);
  await page.getByRole("button", { name: "このページの範囲をすべて取り消す" }).click();
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(0);
  await expect(page.getByTestId("pdf-redact-summary")).toContainText("0個（0ページ）");
  await expect(run).toBeDisabled();

  // クリックしただけ（大きさのない範囲）は、範囲として扱わない
  const pt = await aim(page, 0.5, 0.5);
  await page.mouse.click(pt.x, pt.y);
  await expect(page.getByTestId("pdf-redact-region")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 3. 異常系・既存ツールへの影響
// ---------------------------------------------------------------------------
test("pdf-redact: PDFではないファイルは、内容を処理せず、読み込めない理由を示す", async ({ page }) => {
  await page.goto("/tools/pdf-redact");
  await uploadWhenReady(page, [files.fake], page.getByRole("alert").first(), { readyTimeoutMs: 40_000 });
  await expect(page.getByRole("alert").first()).toContainText("読み込みに失敗しました");
  await expect(page.getByRole("alert").first()).not.toContainText("SECRET-FAKE");
  await expect(page.getByRole("button", { name: "黒塗りを確定して新しいPDFを作る" })).toHaveCount(0);
  await expect(page.getByTestId("pdf-redact-canvas")).toHaveCount(0);
});

test("pdf-redact: ページ数が上限を超えるPDFは、処理せず、上限を示す", async ({ page }) => {
  await page.goto("/tools/pdf-redact");
  await uploadWhenReady(page, [files.many], page.getByRole("alert").first(), { readyTimeoutMs: 60_000 });
  await expect(page.getByRole("alert").first()).toContainText("ページ数が多すぎます");
  await expect(page.getByRole("alert").first()).toContainText(`${REDACT_MAX_PAGES}ページまで`);
  await expect(page.getByTestId("pdf-redact-canvas")).toHaveCount(0);
});

test("pdf-redact: PDF以外のファイル（.txt）は受け付けず、対応していない旨を示す", async ({ page }) => {
  await page.goto("/tools/pdf-redact");
  await uploadWhenReady(page, [files.txt], page.getByText("対応していません"), { readyTimeoutMs: 40_000 });
  await expect(page.getByTestId("pdf-redact-canvas")).toHaveCount(0);
});

test("pdf-redact: PDF修正の白消しの注意書きから、このツールへ案内される（PDF修正は引き続き開ける）", async ({ page }) => {
  await page.goto("/tools/pdf-fix");
  const notice = page.getByTestId("pdf-fix-whiteout-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("元の文字情報がファイル内に残る場合があり");
  const link = notice.getByRole("link", { name: "PDF黒塗り・墨消し" });
  await expect(link).toHaveAttribute("href", "/tools/pdf-redact");
});
