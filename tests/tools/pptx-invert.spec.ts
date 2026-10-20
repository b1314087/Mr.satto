import fs from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { strFromU8 } from "fflate";
import { test, expect } from "../fixtures/premium-test";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { NetworkRecorder, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { checkXmlWellFormed } from "../helpers/xlsx-strict";
import { bwDocument, buildPptx, colorPhoto, decodePng, encodePng, mixedDocument, picture, pixelAt, readParts, rect, srgb, transparentBw } from "../helpers/pptx-builder";

/**
 * PowerPoint白黒反転（/tools/pptx-invert）のE2Eテスト。
 * 実際のブラウザ（Canvasでの画像の読み書き）で、PNG・JPEGの画像を含むpptxを変換し、
 * ダウンロードしたファイルの中身を確かめる。変換の細かい規則は tests/pptx/pptx-invert.spec.ts（単体）で確認している。
 */

const SLUG = "/tools/pptx-invert";
const RUN_NAME = "白黒を反転する";


let RUN: Locator;
/**
 * 保存されるファイル名は、リンクの download 属性に付けた名前で確認する。
 * （Playwrightの suggestedFilename() は、このテスト環境のように日本語の文字コード設定がない Linux では、
 *  日本語を含む名前を「download」に置き換えてしまう。実際の利用者のブラウザでは起きない、テスト環境側の制約。）
 */
async function recordDownloadNames(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __downloadNames: string[] };
    w.__downloadNames = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download) w.__downloadNames.push(this.download);
      return original.call(this);
    };
  });
}
const lastDownloadName = (page: Page) => page.evaluate(() => (window as unknown as { __downloadNames: string[] }).__downloadNames.at(-1));

async function open(page: Page) {
  await recordDownloadNames(page);
  await page.goto(SLUG);
  RUN = page.getByRole("button", { name: RUN_NAME });
  await expect(page.getByRole("heading", { level: 1, name: "PowerPoint白黒反転" })).toBeVisible();
  await waitForFileInputHydrated(page);
}

/**
 * ファイルを選び、変換ボタンが出るまで待つ。開発サーバーは、このツールの部品を初めて読み込んだ直後に画面を作り直すことがあり、
 * その前に選んだファイルは消える（本番の動作とは関係しない）。ボタンが出て、しばらく残るまで、ページを読み込み直して選び直す。
 * 日本語のファイル名は、ファイルの場所を渡すと（この実行環境では）読み込めないため、名前と中身を渡す。
 */
type Upload = { name: string; mimeType: string; buffer: Buffer };
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** 日本語のファイル名も使えるよう、ファイルの場所ではなく、名前と中身を渡して選ぶ */
const upload = (name: string, bytes: Uint8Array | string): Upload => ({ name, mimeType: PPTX_MIME, buffer: Buffer.from(bytes) });

async function pickFile(page: Page, file: Upload) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.locator('input[type="file"]').first().setInputFiles(file);
    const shown = await RUN.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
    if (shown) {
      await page.waitForTimeout(1_000);
      if (await RUN.isVisible()) return;
    }
    // 画面の作り直しの途中で選んだ場合は、選び直しても反応しないことがあるため、ページを読み込み直す
    await page.reload();
    await waitForFileInputHydrated(page);
  }
  await expect(RUN, "ファイルを選んでも変換ボタンが表示されません").toBeVisible({ timeout: 1_000 });
}

/** ブラウザのCanvasでJPEGを作る（灰色の階調／カラー） */
async function makeJpegs(page: Page): Promise<{ gray: Uint8Array; color: Uint8Array }> {
  const r = await page.evaluate(() => {
    const make = (paint: (ctx: CanvasRenderingContext2D, x: number, y: number) => void) => {
      const c = document.createElement("canvas");
      c.width = 48;
      c.height = 32;
      const ctx = c.getContext("2d")!;
      for (let x = 0; x < 48; x++) for (let y = 0; y < 32; y++) paint(ctx, x, y);
      return c.toDataURL("image/jpeg", 0.95).split(",")[1];
    };
    return {
      gray: make((ctx, x, y) => { const v = Math.round((x / 47) * 255); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, y, 1, 1); }),
      color: make((ctx, x, y) => { ctx.fillStyle = `rgb(${Math.round((x / 47) * 255)},${Math.round((y / 31) * 255)},90)`; ctx.fillRect(x, y, 1, 1); }),
    };
  });
  return { gray: new Uint8Array(Buffer.from(r.gray, "base64")), color: new Uint8Array(Buffer.from(r.color, "base64")) };
}

/** ブラウザで画像を読み、(x,y)の画素を返す */
async function samplePixel(page: Page, bytes: Uint8Array, mime: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ({ b64, mime, x, y }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr], { type: mime }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return Array.from(ctx.getImageData(x, y, 1, 1).data);
    },
    { b64: Buffer.from(bytes).toString("base64"), mime, x, y },
  );
}

test.describe("PowerPoint白黒反転: 画面", () => {
  test("pptxを選んで変換し、画像ごとの判定を見て、ダウンロードできる。元のファイルは変わらず、何も送信されない", async ({ page, baseURL }) => {
    const recorder = new NetworkRecorder(page);
    await open(page);
    const jpegs = await makeJpegs(page);

    const deck = buildPptx({
      slides: [
        {
          shapes: rect(2, { text: "白背景・黒文字", textColor: srgb("000000") }) + rect(3, { fill: srgb("FF0000"), text: "赤" }),
          bg: `<p:bg><p:bgPr><a:solidFill>${srgb("FFFFFF")}</a:solidFill><a:effectLst/></p:bgPr></p:bg>`,
          images: [
            { name: "bwdoc.png", bytes: encodePng(bwDocument()) },
            { name: "color.png", bytes: encodePng(colorPhoto()) },
            { name: "trans.png", bytes: encodePng(transparentBw()) },
            { name: "mixed.png", bytes: encodePng(mixedDocument()) },
          ],
        },
        {
          shapes: picture(2, "rId2") + picture(3, "rId3"),
          images: [
            { name: "gray.jpeg", bytes: jpegs.gray },
            { name: "colorphoto.jpeg", bytes: jpegs.color },
          ],
        },
      ],
    });
    // 画像を図形として配置するために、スライド1にも pic を追加する
    const parts = readParts(deck);
    parts["ppt/slides/slide1.xml"] = new TextEncoder().encode(strFromU8(parts["ppt/slides/slide1.xml"]).replace("</p:spTree>", `${picture(5, "rId2")}${picture(6, "rId3")}${picture(7, "rId4")}${picture(8, "rId5")}</p:spTree>`));
    const { zipSync } = await import("fflate");
    const input = zipSync(parts);

    await pickFile(page, upload("会議資料.pptx", input));
    await RUN.click();
    const preview = page.getByTestId("tool-preview");
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pptx-slide-count")).toHaveText("2");

    // 画像ごとの判定
    const outcomes: Record<string, string> = {};
    for (const row of await page.getByTestId("pptx-image-row").all()) {
      const name = (await row.locator("p").first().textContent()) ?? "";
      outcomes[name] = (await row.getAttribute("data-outcome")) ?? "";
    }
    expect(outcomes).toEqual({
      "bwdoc.png": "inverted",
      "color.png": "kept-color",
      "trans.png": "inverted",
      "mixed.png": "inverted-gray",
      "gray.jpeg": "inverted",
      "colorphoto.jpeg": "kept-color",
    });
    await expect(page.getByTestId("pptx-notes")).toContainText("テーマの色");

    // ダウンロード
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "PowerPointファイルをダウンロード" }).click();
    const download = await downloadPromise;
    expect(await lastDownloadName(page)).toBe("会議資料_白黒反転.pptx");
    const outBytes = new Uint8Array(fs.readFileSync((await download.path())!));
    const out = readParts(outBytes);

    // 構造: 同じファイル一覧、XMLはすべて正しい
    expect(Object.keys(out)).toEqual(Object.keys(parts));
    const problems: string[] = [];
    for (const [n, b] of Object.entries(out)) if (/\.(xml|rels)$/.test(n)) problems.push(...checkXmlWellFormed(strFromU8(b), n));
    expect(problems).toEqual([]);

    // 色: 背景・文字は反転、赤はそのまま
    const slide = strFromU8(out["ppt/slides/slide1.xml"]);
    expect(slide).toMatch(/<p:bgPr><a:solidFill><a:srgbClr val="000000"/);
    expect(slide).toMatch(/<a:rPr lang="ja-JP" sz="2400"><a:solidFill><a:srgbClr val="FFFFFF"/);
    expect(slide).toMatch(/<a:srgbClr val="FF0000"/);
    expect(strFromU8(out["ppt/slideMasters/slideMaster1.xml"])).toContain('bg1="dk1" tx1="lt1"');
    // 画像: PNG（ブラウザのCanvasで書き出し）
    const bw = decodeBrowserPng(await toPixels(page, out["ppt/media/bwdoc.png"], "image/png"));
    expect(bw.at(1, 10)).toEqual([0, 0, 0, 255]); // 白 → 黒
    const trans = await toPixels(page, out["ppt/media/trans.png"], "image/png");
    const transSrc = transparentBw();
    for (const [x, y] of [[0, 0], [12, 3], [12, 20]]) expect(trans.at(x, y)[3]).toBe(pixelAt(transSrc, x, y)[3]); // 透明度は変わらない
    const mixed = await toPixels(page, out["ppt/media/mixed.png"], "image/png");
    expect(mixed.at(2, 2)).toEqual([220, 30, 30, 255]); // 色のついた図は残る
    expect(mixed.at(21, 20)).toEqual([0, 0, 0, 255]);
    expect(Buffer.from(out["ppt/media/color.png"]).equals(Buffer.from(parts["ppt/media/color.png"]))).toBe(true); // カラーは変更なし
    // 画像: JPEG
    const grayLeft = await samplePixel(page, out["ppt/media/gray.jpeg"], "image/jpeg", 1, 5);
    const graySrc = await samplePixel(page, jpegs.gray, "image/jpeg", 1, 5);
    expect(Math.abs(grayLeft[0] - (255 - graySrc[0]))).toBeLessThanOrEqual(6);
    expect(Buffer.from(out["ppt/media/colorphoto.jpeg"]).equals(Buffer.from(jpegs.color))).toBe(true);
    // 画像の大きさ・向き
    const dims = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr], { type: "image/jpeg" }));
      return [bmp.width, bmp.height];
    }, Buffer.from(out["ppt/media/gray.jpeg"]).toString("base64"));
    expect(dims).toEqual([48, 32]);

    // 変換後のファイルは、元のファイルとは別の内容（元のファイルは書き換えない）
    expect(Buffer.from(outBytes).equals(Buffer.from(input))).toBe(false);

    // サーバーへ送信されない
    const origin = new URL(baseURL!).origin;
    expect(findSuspiciousApiUploads(recorder, origin)).toEqual([]);
    expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
  });

  test("画像の反転をオフにすると、画像は変わらない", async ({ page }) => {
    await open(page);
    const img = encodePng(bwDocument());
    const input = buildPptx({ slides: [{ shapes: picture(2, "rId2"), images: [{ name: "a.png", bytes: img }] }] });
    await pickFile(page, upload("a.pptx", input));
    await page.getByTestId("pptx-option-images").uncheck();
    await RUN.click();
    await expect(page.getByTestId("pptx-image-row")).toHaveAttribute("data-outcome", "skipped-option", { timeout: 30_000 });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "PowerPointファイルをダウンロード" }).click();
    const out = readParts(new Uint8Array(fs.readFileSync((await (await downloadPromise).path())!)));
    expect(Buffer.from(out["ppt/media/a.png"]).equals(Buffer.from(img))).toBe(true);
  });

  test("pptxではないファイルは、わかりやすいメッセージで断る", async ({ page }) => {
    await open(page);
    await pickFile(page, upload("壊れた.pptx", "これはPowerPointではありません"));
    await RUN.click();
    await expect(page.getByText("PowerPointファイル（.pptx）として読み込めませんでした", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("tool-preview")).toHaveCount(0);
  });

  test("古い形式（.ppt）は、保存し直す方法を案内する", async ({ page }) => {
    await open(page);
    await waitForFileInputHydrated(page);
    await page.locator('input[type="file"]').first().setInputFiles({ name: "古い.ppt", mimeType: "application/vnd.ms-powerpoint", buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]) });
    // .ppt は受け付けるファイルの種類に含まれないため、選択の時点で断られる（変換ボタンは出ない）
    await expect(page.getByRole("alert").filter({ hasText: "対応していません" })).toBeVisible({ timeout: 10_000 });
    await expect(RUN).toHaveCount(0);
  });
});

// ---- ブラウザで読んだ画像の画素 ----
interface Pixels {
  width: number;
  height: number;
  data: number[];
  at(x: number, y: number): number[];
}
async function toPixels(page: Page, bytes: Uint8Array, mime: string): Promise<Pixels> {
  const r = await page.evaluate(
    async ({ b64, mime }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr], { type: mime }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return { width: bmp.width, height: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) };
    },
    { b64: Buffer.from(bytes).toString("base64"), mime },
  );
  return { ...r, at: (x, y) => r.data.slice((y * r.width + x) * 4, (y * r.width + x) * 4 + 4) };
}
const decodeBrowserPng = (p: Pixels) => p;
// decodePng は単体テストと同じヘルパー（ここでは未使用の型確認用）
void decodePng;
