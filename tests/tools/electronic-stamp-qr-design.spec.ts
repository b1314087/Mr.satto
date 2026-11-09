import { test, expect } from "../fixtures/premium-test";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile, closeResultPopup } from "../helpers/tool-runner";
import { decodePng, countTransparentPixels, type DecodedPng } from "../helpers/png-inspect";
import { decodeQrFile, qrCorners, qrDecoders } from "../helpers/qr-decode";
import { scratchDir } from "../helpers/tmp";
import {
  STAMP_QR_PREVIEW_SERIAL,
  STAMP_SERIAL_PATTERN,
  canPlaceStampQr,
  stampQrMinSizePx,
  type StampQrDesign,
  type StampShape,
} from "@/lib/processors/browser/electronic-stamp";

/**
 * 電子印鑑：QRコードのデザイン(①文字の中に組み込む・②文字の一部をQRコードに置き換える・③印鑑全体に模様として配置する)のテスト。
 *
 * 確かめること:
 *  - 3種類(と従来の配置)を選べ、選んだデザインが編集中のプレビューに出る(プレビューのQRコードは、実在しない番号
 *    MS-0000-0000-0000 で、実際に読み取れる)
 *  - ダウンロードした画像にも同じデザインが出る(プレビューと同じ位置・大きさのQRコード)
 *  - 生成したあとにデザインを変えても、固有番号は変わらない(QRコードの中身も同じ番号)
 *  - 各デザインのQRコードを、独立した2つの読み取りライブラリ(OpenCV・ZXing)で読み取れ、読み取った結果が番号だけ
 *  - 丸印・角印、小さい印影・大きい印影、朱色・青・黒、透明な背景、ダウンロードしたPNG、画像の大きさを変えたもの
 *  - QRコードを入れない設定では、従来どおりの印影(番号なし)
 *  - 取り込んだ印影：①と従来の配置は使え、②③は理由を表示して選べない
 *  - デザインの切り替え・生成・ダウンロードのあいだに通信が起きない・ブラウザに保存しない
 * 読み取りのライブラリが入っていない環境では、読み取りを確かめるテストを飛ばす(理由を表示する)。
 */

const TOOL_URL = "/tools/electronic-stamp-generator";
test.use({ viewport: { width: 1280, height: 1200 } });

const DESIGNS: Exclude<StampQrDesign, "standard">[] = ["inText", "replaceChar", "pattern"];
const decoders = qrDecoders();
const NO_DECODER = "QRコードの読み取りライブラリ(python3 の opencv-python)が無い環境のため、読み取りの確認を飛ばします";

// ---------------------------------------------------------------------------
// 配置の計算(ブラウザを使わないテスト)
// ---------------------------------------------------------------------------

plainTest("配置：大きい印影には3種類とも入り、小さすぎる印影には入らない・必要な大きさを返す", () => {
  for (const shape of ["round", "square"] as StampShape[]) {
    for (const design of DESIGNS) {
      const base = { shape, borderWidthRatio: 0.05, text: "山田", layout: "vertical" as const, design };
      plainExpect(canPlaceStampQr({ ...base, sizePx: 600 }), `${shape} ${design} 600px`).toBe(true);
      plainExpect(canPlaceStampQr({ ...base, sizePx: 120 }), `${shape} ${design} 120px`).toBe(false);
      const min = stampQrMinSizePx({ ...base, sizePx: 300 });
      plainExpect(min).not.toBeNull();
      plainExpect(canPlaceStampQr({ ...base, sizePx: min! })).toBe(true);
      plainExpect(canPlaceStampQr({ ...base, sizePx: min! - 10 })).toBe(false);
    }
  }
  // ②は、文字が多いほど1マスが小さくなるので、大きな印影が必要になる
  const two = stampQrMinSizePx({ sizePx: 300, shape: "round", borderWidthRatio: 0.05, text: "山田", layout: "vertical", design: "replaceChar" })!;
  const eight = stampQrMinSizePx({ sizePx: 300, shape: "round", borderWidthRatio: 0.05, text: "山田太郎次郎三郎", layout: "vertical", design: "replaceChar" });
  plainExpect(eight === null || eight > two).toBe(true);
});

// ---------------------------------------------------------------------------
// 画面の操作
// ---------------------------------------------------------------------------

const isWhite = (png: DecodedPng, i: number) => png.data[i + 3] === 255 && png.data[i] >= 250 && png.data[i + 1] >= 250 && png.data[i + 2] >= 250;
function countWhitePixels(png: DecodedPng): number {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) if (isWhite(png, i)) n++;
  return n;
}

async function savePreview(page: Page, file: string): Promise<string> {
  const url = await page.locator('canvas[aria-label="印影のプレビュー"]').evaluate((c: HTMLCanvasElement) => c.toDataURL("image/png"));
  fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  return file;
}

async function generate(page: Page) {
  await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
  await waitForSuccess(page, "印影画像が完成しました");
  return (await page.getByTestId("stamp-serial").textContent())?.trim() ?? "";
}

/** 完成のポップアップで、デザインを切り替える(番号はそのまま)。画像が描き直されるまで待つ */
async function switchResultDesign(page: Page, design: StampQrDesign) {
  const img = page.locator('[data-testid="result-popup"] img').first();
  const before = await img.getAttribute("src");
  const button = page.getByTestId(`result-qr-design-${design}`);
  if ((await button.getAttribute("aria-pressed")) === "true") return;
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => img.getAttribute("src")).not.toBe(before);
}

async function download(page: Page): Promise<{ file: string; name: string }> {
  const d = await clickAndDownload(page, "PNGをダウンロード");
  const { path: file } = await assertDownloadedFile(d, { format: "png", minBytes: 100 });
  return { file, name: d.suggestedFilename() };
}

function expectDecodes(file: string, expected: string, label: string) {
  const [r] = decodeQrFile(file);
  expect(r.opencv, `${label}：OpenCVで読み取れない`).toBe(expected);
  if (r.zxing !== null) expect(r.zxing, `${label}：ZXingで読み取れない`).toBe(expected);
}

test.describe("QRコードのデザイン：選択・プレビュー・ダウンロード", () => {
  test("3種類を選べ、選んだデザインがプレビューに出る(プレビューのQRコードも読み取れる・実在しない番号)", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("山田");
    await expect(page.getByText("QRコードのデザイン", { exact: true })).toBeVisible();
    const dir = scratchDir("stamp-design-preview");
    const hashes = new Set<string>();
    for (const design of [...DESIGNS, "standard" as const]) {
      const button = page.getByTestId(`qr-design-${design}`);
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      const file = await savePreview(page, path.join(dir, `${design}.png`));
      hashes.add(fs.readFileSync(file).toString("base64"));
      if (design !== "standard") {
        // 見本(選択肢の中の小さな画像)も描かれている
        await expect(button.locator("canvas")).toHaveCount(1);
        if (decoders.opencv) expectDecodes(file, STAMP_QR_PREVIEW_SERIAL, `プレビュー ${design}`);
        // 白い四角を使わない
        expect(countWhitePixels(decodePng(file)), `プレビュー ${design} に白い四角がある`).toBe(0);
      }
    }
    expect(hashes.size, "デザインを変えてもプレビューが変わらない").toBe(4);
    // 生成する前は番号を発行しない
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0);
  });

  test("各デザインのダウンロード画像：プレビューと同じデザイン・番号だけを読み取れる・透明な背景・白い四角なし", async ({ page }) => {
    test.skip(!decoders.opencv, NO_DECODER);
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("佐藤");
    const dir = scratchDir("stamp-design-download");
    for (const design of DESIGNS) {
      await page.getByTestId(`qr-design-${design}`).click();
      const preview = await savePreview(page, path.join(dir, `preview-${design}.png`));
      const serial = await generate(page);
      expect(serial).toMatch(STAMP_SERIAL_PATTERN);
      const { file, name } = await download(page);
      expect(name).toBe(`electronic-stamp-${serial}.png`);
      const png = decodePng(file);
      expect([png.width, png.height]).toEqual([300, 300]);
      expect(countTransparentPixels(png), `${design}：背景が透明でない`).toBeGreaterThan(png.width * png.height * 0.3);
      expect(countWhitePixels(png), `${design}：白い四角がある`).toBe(0);
      expectDecodes(file, serial, `ダウンロード ${design}`);
      // プレビューとダウンロード画像で、QRコードの位置・大きさが同じ(同じデザインで描いている)
      const a = qrCorners(preview);
      const b = qrCorners(file);
      expect(a && b, `${design}：QRコードの角が見つからない`).toBeTruthy();
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(a![i][0] - b![i][0]), `${design}：プレビューとQRコードの位置が違う`).toBeLessThanOrEqual(2);
        expect(Math.abs(a![i][1] - b![i][1]), `${design}：プレビューとQRコードの位置が違う`).toBeLessThanOrEqual(2);
      }
      await closeResultPopup(page);
    }
  });

  test("生成したあとにデザインを変えても、固有番号とQRコードの中身は変わらない(再ダウンロードも同じ)", async ({ page }) => {
    test.skip(!decoders.opencv, NO_DECODER);
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("山田");
    await page.getByTestId("qr-design-inText").click();
    const serial = await generate(page);
    const seen = new Set<string>();
    for (const design of ["inText", "replaceChar", "pattern", "standard", "inText"] as StampQrDesign[]) {
      await switchResultDesign(page, design);
      await expect(page.getByTestId("stamp-serial")).toHaveText(serial);
      const first = await download(page);
      const again = await download(page);
      expect(first.name).toBe(`electronic-stamp-${serial}.png`);
      expect(fs.readFileSync(again.file).equals(fs.readFileSync(first.file)), `${design}：再ダウンロードで画像が変わった`).toBe(true);
      expectDecodes(first.file, serial, `切り替え後 ${design}`);
      seen.add(fs.readFileSync(first.file).toString("base64"));
    }
    // ①→②→③→従来→① で、①は同じ画像に戻る(4種類の画像)
    expect(seen.size).toBe(4);
    // 編集画面の選択も、切り替えたデザインになっている
    await closeResultPopup(page);
    await expect(page.getByTestId("qr-design-inText")).toHaveAttribute("aria-pressed", "true");
  });

  test("QRコードを入れない設定では、デザインの選択を出さず、従来どおりの印影(番号なし)になる", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.getByTestId("qr-design-pattern").click();
    await page.getByLabel("固有番号とQRコードを入れる").uncheck();
    await expect(page.getByTestId("qr-design-picker")).toHaveCount(0);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0);
    await expect(page.getByTestId("result-qr-design")).toHaveCount(0);
    const { file, name } = await download(page);
    expect(name).toBe("electronic-stamp.png");
    if (decoders.opencv) {
      const [r] = decodeQrFile(file);
      expect(r.opencv).toBe("");
      if (r.zxing !== null) expect(r.zxing).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// 読み取り：形・大きさ・色・画像の大きさの変更
// ---------------------------------------------------------------------------

/** 3種類とも入る、いちばん小さい印影の大きさ */
function smallestForAll(shape: StampShape): number {
  return Math.max(
    ...DESIGNS.map((design) => stampQrMinSizePx({ sizePx: 300, shape, borderWidthRatio: 0.05, text: "山田", layout: "vertical", design }) ?? 600)
  );
}

for (const shape of ["round", "square"] as StampShape[]) {
  test(`読み取り(${shape === "round" ? "丸印" : "角印"})：小さい・大きい印影、朱色・青・黒、ダウンロードしたPNGと大きさを変えた画像`, async ({ page }, testInfo) => {
    test.skip(!decoders.opencv, NO_DECODER);
    test.setTimeout(240_000);
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("山田");
    if (shape === "square") await page.getByRole("button", { name: "角印", exact: true }).click();
    const small = smallestForAll(shape);
    const cases: { size: number; color: string }[] = [
      { size: small, color: "朱色" },
      { size: small, color: "青" },
      { size: 600, color: "朱色" },
      { size: 600, color: "黒" },
    ];
    const rows: string[] = [];
    const failures: string[] = [];
    for (const c of cases) {
      await page.getByLabel(/印影サイズ/).fill(String(c.size));
      await page.getByRole("button", { name: new RegExp(c.color) }).click();
      await page.getByTestId("qr-design-inText").click();
      const serial = await generate(page);
      for (const design of DESIGNS) {
        await switchResultDesign(page, design);
        const { file } = await download(page);
        const png = decodePng(file);
        expect([png.width, png.height]).toEqual([c.size, c.size]);
        const results = decodeQrFile(file, [1, 2, 0.75, 0.5]);
        const mark = (v: string | null) => (v === null ? "-" : v === serial ? "○" : "×");
        rows.push(
          `${shape} ${c.size}px ${c.color} ${design}: ` + results.map((r) => `×${r.scale} OpenCV${mark(r.opencv)} ZXing${mark(r.zxing)}`).join(" / ")
        );
        const orig = results.find((r) => r.scale === 1)!;
        if (orig.opencv !== serial) failures.push(`${c.size}px ${c.color} ${design}：OpenCVで読めない(${orig.opencv})`);
        if (orig.zxing !== null && orig.zxing !== serial) failures.push(`${c.size}px ${c.color} ${design}：ZXingで読めない(${orig.zxing})`);
        // 2倍に拡大した画像は、少なくとも一方で読める
        const x2 = results.find((r) => r.scale === 2)!;
        if (x2.opencv !== serial && x2.zxing !== serial) failures.push(`${c.size}px ${c.color} ${design}：2倍に拡大すると読めない`);
        // どの結果も、読めたときは番号だけ
        for (const r of results) for (const v of [r.opencv, r.zxing]) if (v) expect(v).toBe(serial);
      }
      await closeResultPopup(page);
    }
    await testInfo.attach(`読み取り結果(${shape})`, { body: rows.join("\n"), contentType: "text/plain" });
    expect(failures, failures.join("\n") + "\n\n" + rows.join("\n")).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// 取り込んだ印影
// ---------------------------------------------------------------------------

test("取り込んだ印影：①と従来の配置を使え、②③は理由を表示して選べない。①でも番号だけを読み取れ、切り替えても番号は同じ", async ({ page }) => {
  await page.goto(TOOL_URL);
  await page.getByRole("button", { name: "印鑑を取り込む", exact: true }).click();
  await uploadFixture(page, fixtures.stampPng);
  await page.getByRole("button", { name: "切り抜く", exact: true }).click();
  await expect(page.locator('[data-testid="stamp-final-preview"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("qr-design-replaceChar")).toBeDisabled();
  await expect(page.getByTestId("qr-design-pattern")).toBeDisabled();
  await expect(page.getByTestId("qr-design-reason-replaceChar")).toContainText("文字1つ1つの位置");
  await expect(page.getByTestId("qr-design-reason-pattern")).toContainText("文字の場所が分からない");
  // 既定は従来の配置(印影の下に並べる)
  await expect(page.getByTestId("qr-design-standard")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("qr-design-inText")).toBeEnabled();
  await page.getByTestId("qr-design-inText").click();
  const serial = await generate(page);
  expect(serial).toMatch(STAMP_SERIAL_PATTERN);
  const inText = await download(page);
  expect(countTransparentPixels(decodePng(inText.file))).toBeGreaterThan(0);
  expect(countWhitePixels(decodePng(inText.file)), "①に白い四角がある").toBe(0);
  if (decoders.opencv) expectDecodes(inText.file, serial, "取り込んだ印影 ①");
  // 従来の配置に切り替えても、同じ番号
  await switchResultDesign(page, "standard");
  await expect(page.getByTestId("stamp-serial")).toHaveText(serial);
  await expect(page.getByTestId("result-qr-design-replaceChar")).toHaveCount(0);
  const below = await download(page);
  expect(below.name).toBe(inText.name);
  if (decoders.opencv) expectDecodes(below.file, serial, "取り込んだ印影 従来の配置");
});

// ---------------------------------------------------------------------------
// プライバシー
// ---------------------------------------------------------------------------

test("QRコードのデザイン：選択・プレビュー・生成・切り替え・ダウンロードのあいだに通信が起きず、ブラウザに保存しない", async ({ page }) => {
  await page.goto(TOOL_URL);
  await page.locator("#stamp-text-input").fill("鈴木");
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  // blob: / data: は、ブラウザのメモリの中の画像を指す(画面の表示用)で、通信ではないので除く
  page.on("request", (r) => {
    if (!/^(blob|data):/.test(r.url())) requests.push(`${r.method()} ${r.url()}`);
  });
  for (const design of DESIGNS) await page.getByTestId(`qr-design-${design}`).click();
  await page.getByTestId("qr-design-inText").click();
  const serial = await generate(page);
  for (const design of ["pattern", "replaceChar", "standard"] as StampQrDesign[]) await switchResultDesign(page, design);
  await download(page);
  await page.waitForTimeout(500);
  const offending = requests.filter((r) => !r.startsWith("GET ") || !new URL(r.slice(4)).hostname.match(/^(localhost|127\.0\.0\.1)$/) || r.includes(serial));
  expect(offending, offending.join("\n")).toEqual([]);
  const stored = await page.evaluate(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return { local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), dbs: dbs.length };
  });
  expect(stored.local).not.toContain(serial);
  expect(stored.session).not.toContain(serial);
});
