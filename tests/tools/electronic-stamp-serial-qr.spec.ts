import { test, expect } from "../fixtures/premium-test";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { decodePng, countTransparentPixels, type DecodedPng } from "../helpers/png-inspect";
import { decodeQrFile, qrCorners, qrDecoders } from "../helpers/qr-decode";
import {
  STAMP_QR_CORNERS,
  STAMP_SERIAL_ALPHABET,
  STAMP_SERIAL_PATTERN,
  canPlaceStampQr,
  generateStampSerial,
  stampQrMinSizePx,
  stampQrModules,
  type StampQrCorner,
} from "@/lib/processors/browser/electronic-stamp";

/**
 * 電子印鑑：固有番号とQRコードのテスト。
 *
 * 確かめること:
 *  - 固有番号の形式(MS-XXXX-XXXX-XXXX、見間違えやすい 0・1・I・L・O を使わない)・重複しない・暗号学的に安全な乱数を使う
 *  - 新しく生成すると新しい番号、同じ印影を何度ダウンロードしても同じ番号(同じ画像)
 *  - 文字から作る印影：QRコードを、丸印は円の外側の四隅、角印は枠の内側の四隅の、選んだ隅に置く(白い四角は使わない)。
 *    ダウンロードした画像を、独立した2つの読み取りライブラリ(OpenCV・ZXing。入っている環境だけ)で読み取り、
 *    番号だけが取れること・QRコードが選んだ隅にあることを確かめる
 *  - 取り込んだ印影：下に番号とQRコード(白い四角)を並べ、その模様が番号だけを入れたQRコードと同じ
 *  - QRコードを入れない設定・小さすぎる印影・角印
 *  - 生成・ダウンロードのあいだに、通信が起きない・ブラウザに保存しない
 */

const TOOL_URL = "/tools/electronic-stamp-generator";
test.use({ viewport: { width: 1280, height: 1200 } });

// ---------------------------------------------------------------------------
// 固有番号(ブラウザを使わないテスト)
// ---------------------------------------------------------------------------

plainTest("固有番号：形式・使う文字(0・1・I・L・O を使わない)・1万個で重複なし", () => {
  plainExpect(STAMP_SERIAL_ALPHABET).not.toMatch(/[01ILO]/);
  plainExpect(STAMP_SERIAL_ALPHABET.length).toBe(31);
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const s = generateStampSerial();
    plainExpect(s).toMatch(STAMP_SERIAL_PATTERN);
    plainExpect(s).not.toMatch(/[01ILO]/);
    seen.add(s);
  }
  plainExpect(seen.size).toBe(10_000);
});

plainTest("固有番号：乱数の値 248〜255 は捨てて引き直す(31種類の文字に偏りが出ない)・渡した乱数の関数を使う", () => {
  let calls = 0;
  // 最初の32バイトはすべて捨てる値(248〜255)、次は 0,1,2,… → 先頭の12文字は ALPHABET[0..11]
  const fake = (a: Uint8Array) => {
    calls++;
    for (let i = 0; i < a.length; i++) a[i] = calls === 1 ? 248 + (i % 8) : i;
    return a;
  };
  const s = generateStampSerial(fake);
  plainExpect(calls).toBe(2);
  plainExpect(s).toBe(`MS-${STAMP_SERIAL_ALPHABET.slice(0, 4)}-${STAMP_SERIAL_ALPHABET.slice(4, 8)}-${STAMP_SERIAL_ALPHABET.slice(8, 12)}`);
});

plainTest("QRコード：番号だけを入れると 21×21 マス(バージョン1)で、番号ごとに模様が違う", () => {
  const a = stampQrModules("MS-7K9P-2XQ8-4D6A");
  const b = stampQrModules("MS-7K9P-2XQ8-4D6B");
  plainExpect(a.length).toBe(21);
  plainExpect(a.every((row) => row.length === 21)).toBe(true);
  plainExpect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
});

plainTest("QRコードの配置：大きな印影には入り、小さすぎる印影には入らない(必要な大きさを返す)", () => {
  for (const shape of ["round", "square"] as const) {
    plainExpect(canPlaceStampQr({ sizePx: 600, shape, borderWidthRatio: 0.05 })).toBe(true);
    plainExpect(canPlaceStampQr({ sizePx: 120, shape, borderWidthRatio: 0.05 })).toBe(false);
    const min = stampQrMinSizePx({ shape, borderWidthRatio: 0.05 })!;
    plainExpect(min).toBeLessThanOrEqual(300); // 既定の300pxでは入る
    plainExpect(canPlaceStampQr({ sizePx: min, shape, borderWidthRatio: 0.05 })).toBe(true);
    plainExpect(canPlaceStampQr({ sizePx: min - 10, shape, borderWidthRatio: 0.05 })).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// 画像の中のQRコードを調べる
// ---------------------------------------------------------------------------

const px = (png: DecodedPng, x: number, y: number) => {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] };
};
const isWhite = (p: { r: number; g: number; b: number; a: number }) => p.a === 255 && p.r >= 250 && p.g >= 250 && p.b >= 250;

/** 画像の中のQRコードの白い四角(余白を含む)を探す：いちばん下の白い画素の行から、四角の左右の端を求める */
function findQrBox(png: DecodedPng): { x: number; y: number; side: number } | null {
  for (let y = png.height - 1; y >= 0; y--) {
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < png.width; x++) {
      if (isWhite(px(png, x, y))) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    if (x0 >= 0) {
      const side = x1 - x0 + 1;
      return { x: x0, y: y - side + 1, side };
    }
  }
  return null;
}

/** QRコードの模様を、画像から読み取る(マスの中心の画素の明るさ) */
function readQrModules(png: DecodedPng): boolean[][] | null {
  const box = findQrBox(png);
  if (!box) return null;
  const total = 21 + 8; // 21マス + 余白4マス×2
  const m = box.side / total;
  if (Math.abs(m - Math.round(m)) > 0.01) return null; // マスの大きさは整数のpx
  const out: boolean[][] = [];
  for (let r = 0; r < 21; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < 21; c++) {
      const p = px(png, Math.floor(box.x + (c + 4.5) * m), Math.floor(box.y + (r + 4.5) * m));
      const lightness = (Math.max(p.r, p.g, p.b) + Math.min(p.r, p.g, p.b)) / 2;
      row.push(p.a > 128 && lightness < 180);
    }
    out.push(row);
  }
  return out;
}

/** OpenCV(使える環境だけ)でQRコードを読み取る。使えなければ null */
function decodeWithOpenCv(file: string): string | null {
  try {
    execFileSync("python3", ["-c", "import cv2"], { stdio: "ignore" });
  } catch {
    return null;
  }
  const script = [
    "import sys, cv2, numpy as np",
    "img = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)",
    "if img.shape[2] == 4:",
    "    a = img[:, :, 3:4].astype(float) / 255.0",
    "    img = (img[:, :, :3].astype(float) * a + 255 * (1 - a)).astype(np.uint8)",
    "img = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))",
    "img = cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)",
    "text, pts, _ = cv2.QRCodeDetector().detectAndDecode(img)",
    "print(text)",
  ].join("\n");
  return execFileSync("python3", ["-c", script, file]).toString().trim();
}

/** 文字から作る印影：QRコードが番号だけを読み取れ、選んだ隅(画像の外側の30%の範囲)にあり、白い四角が無い */
function expectCornerQr(file: string, serial: string, corner: StampQrCorner) {
  const png = decodePng(file);
  let white = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (isWhite(px(png, x, y))) white++;
  expect(white, "白い四角がある").toBe(0);
  const decoders = qrDecoders();
  if (!decoders.opencv) return;
  const [r] = decodeQrFile(file);
  expect(r.opencv, "OpenCVで読み取れない").toBe(serial);
  if (r.zxing !== null) expect(r.zxing, "ZXingで読み取れない").toBe(serial);
  const pts = qrCorners(file);
  expect(pts, "QRコードの位置が見つからない").not.toBeNull();
  const cx = pts!.reduce((a, p) => a + p[0], 0) / 4 / png.width;
  const cy = pts!.reduce((a, p) => a + p[1], 0) / 4 / png.height;
  expect(corner.endsWith("right") ? cx > 0.7 : cx < 0.3, `QRコードが${corner}にない(x=${cx.toFixed(2)})`).toBe(true);
  expect(corner.startsWith("bottom") ? cy > 0.7 : cy < 0.3, `QRコードが${corner}にない(y=${cy.toFixed(2)})`).toBe(true);
}

function expectQrIsSerialOnly(file: string, serial: string) {
  const png = decodePng(file);
  const modules = readQrModules(png);
  expect(modules, "画像の中にQRコードが見つからない").not.toBeNull();
  expect(JSON.stringify(modules)).toBe(JSON.stringify(stampQrModules(serial)));
  const decoded = decodeWithOpenCv(file);
  if (decoded !== null) expect(decoded).toBe(serial);
}

async function generate(page: Page) {
  await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
  await waitForSuccess(page, "印影画像が完成しました");
  return (await page.getByTestId("stamp-serial").textContent())?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// 文字から作る印影
// ---------------------------------------------------------------------------

test.describe("固有番号とQRコード：文字から作る印影", () => {
  test("生成すると番号が発行され、ダウンロードした画像のQRコードに番号だけが入っている", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("山田");
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0); // 生成する前は番号を発行しない
    const serial = await generate(page);
    expect(serial).toMatch(STAMP_SERIAL_PATTERN);
    const download = await clickAndDownload(page, "PNGをダウンロード");
    expect(download.suggestedFilename()).toBe(`electronic-stamp-${serial}.png`);
    const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 100 });
    const png = decodePng(path);
    expect(png.width).toBe(300); // 既定の大きさは変わらない
    expect(png.height).toBe(300);
    expect(countTransparentPixels(png)).toBeGreaterThan(0); // 背景は透明のまま
    expectCornerQr(path, serial, "bottom-right"); // 既定は右下
    // 氏名などは入れない：QRコードの模様は、番号だけを入れたものと同じ(上で確認)。番号の文字列にも氏名は無い
    expect(serial).not.toContain("山田");
  });

  test("同じ印影の再ダウンロードでは番号も画像も同じ、もう一度生成すると新しい番号", async ({ page }) => {
    await page.goto(TOOL_URL);
    const serial1 = await generate(page);
    const d1 = await clickAndDownload(page, "PNGをダウンロード");
    const f1 = await d1.path();
    const d2 = await clickAndDownload(page, "PNGをダウンロード");
    const f2 = await d2.path();
    expect(d2.suggestedFilename()).toBe(d1.suggestedFilename());
    expect(fs.readFileSync(f2!).equals(fs.readFileSync(f1!))).toBe(true);
    await page.keyboard.press("Escape").catch(() => undefined);
    const closeButton = page.getByRole("button", { name: /閉じる/ }).first();
    if (await closeButton.isVisible().catch(() => false)) await closeButton.click();
    const serial2 = await generate(page);
    expect(serial2).toMatch(STAMP_SERIAL_PATTERN);
    expect(serial2).not.toBe(serial1);
  });

  test("角印・最大の大きさ・青でも、QRコードに番号だけが入っている", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("承認");
    await page.getByRole("button", { name: "角印", exact: true }).click();
    await page.getByRole("button", { name: /青/ }).click();
    await page.getByLabel(/印影サイズ/).fill("600");
    const serial = await generate(page);
    const { path } = await assertDownloadedFile(await clickAndDownload(page, "PNGをダウンロード"), { format: "png", minBytes: 100 });
    expect(decodePng(path).width).toBe(600);
    expectCornerQr(path, serial, "bottom-right");
  });

  for (const shape of ["round", "square"] as const) {
    test(`${shape === "round" ? "丸印は円の外側" : "角印は枠の内側"}の、選んだ隅にQRコードを置く(4つの隅・朱色と黒)`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(TOOL_URL);
      await page.locator("#stamp-text-input").fill("佐藤");
      if (shape === "square") await page.getByRole("button", { name: "角印", exact: true }).click();
      const preview = page.locator('canvas[aria-label="印影のプレビュー"]');
      const previews = new Set<string>();
      for (const [i, c] of STAMP_QR_CORNERS.entries()) {
        await page.getByRole("button", { name: i % 2 ? /黒/ : /朱色/ }).click();
        await page.getByTestId(`qr-corner-${c.id}`).click();
        await expect(page.getByTestId(`qr-corner-${c.id}`)).toHaveAttribute("aria-pressed", "true");
        previews.add(await preview.evaluate((el: HTMLCanvasElement) => el.toDataURL()));
        const serial = await generate(page);
        const { path } = await assertDownloadedFile(await clickAndDownload(page, "PNGをダウンロード"), { format: "png", minBytes: 100 });
        expectCornerQr(path, serial, c.id);
        await page.keyboard.press("Escape");
      }
      expect(previews.size, "隅を変えてもプレビューが変わらない").toBe(4);
    });
  }

  test("QRコードを入れない設定では、番号を発行せず、従来どおりの印影になる", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.getByLabel("固有番号とQRコードを入れる").uncheck();
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0);
    const download = await clickAndDownload(page, "PNGをダウンロード");
    expect(download.suggestedFilename()).toBe("electronic-stamp.png");
    const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 100 });
    expect(findQrBox(decodePng(path))).toBeNull();
    if (qrDecoders().opencv) expect(decodeQrFile(path)[0].opencv).toBe("");
  });

  test("小さすぎる印影では注意を出し、QRコードの無い印影にする", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.getByLabel(/印影サイズ/).fill("150");
    await expect(page.getByText("QRコードを入れる場所が足りません", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 取り込んだ印影
// ---------------------------------------------------------------------------

test("固有番号とQRコード：取り込んだ印影には、下に番号とQRコードを並べる", async ({ page }) => {
  await page.goto(TOOL_URL);
  await page.getByRole("button", { name: "印鑑を取り込む", exact: true }).click();
  await uploadFixture(page, fixtures.stampPng);
  await page.getByRole("button", { name: "切り抜く", exact: true }).click();
  await expect(page.locator('[data-testid="stamp-final-preview"]')).toBeVisible({ timeout: 15_000 });
  const serial = await generate(page);
  expect(serial).toMatch(STAMP_SERIAL_PATTERN);
  const { path } = await assertDownloadedFile(await clickAndDownload(page, "PNGをダウンロード"), { format: "png", minBytes: 100 });
  expectQrIsSerialOnly(path, serial);
});

// ---------------------------------------------------------------------------
// プライバシー・乱数
// ---------------------------------------------------------------------------

test("固有番号とQRコード：生成・ダウンロードのあいだに通信が起きず、ブラウザに保存せず、暗号学的に安全な乱数を使う", async ({ page }) => {
  await page.addInitScript(() => {
    const original = crypto.getRandomValues.bind(crypto);
    (window as unknown as { __rv: number }).__rv = 0;
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(a: T) => {
      (window as unknown as { __rv: number }).__rv++;
      return original(a as never) as T;
    }) as typeof crypto.getRandomValues;
  });
  await page.goto(TOOL_URL);
  await page.locator("#stamp-text-input").fill("佐藤");
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  // blob: / data: は、ブラウザのメモリの中の画像を指す(画面の表示用)で、通信ではないので除く
  page.on("request", (r) => {
    if (!/^(blob|data):/.test(r.url())) requests.push(`${r.method()} ${r.url()}`);
  });
  const before = await page.evaluate(() => (window as unknown as { __rv: number }).__rv);
  const serial = await generate(page);
  const after = await page.evaluate(() => (window as unknown as { __rv: number }).__rv);
  expect(after).toBeGreaterThan(before); // 番号の発行で crypto.getRandomValues を使った
  await clickAndDownload(page, "PNGをダウンロード");
  await page.waitForTimeout(500);
  // 画像を作る・番号を発行する・ダウンロードする処理で、通信は起きない(広告などの外部の通信も含めて、何も送らない)
  const offending = requests.filter((r) => !r.startsWith("GET ") || !new URL(r.slice(4)).hostname.match(/^(localhost|127\.0\.0\.1)$/) || r.includes(serial));
  expect(offending, offending.join("\n")).toEqual([]);
  // ブラウザに保存しない
  const stored = await page.evaluate(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return { local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), dbs: dbs.length };
  });
  expect(stored.local).not.toContain(serial);
  expect(stored.session).not.toContain(serial);
});
