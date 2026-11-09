import { test, expect } from "../fixtures/premium-test";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import fs from "node:fs";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { decodePng, countTransparentPixels, type DecodedPng } from "../helpers/png-inspect";
import { decodeQrFile, qrCorners, qrDecoders } from "../helpers/qr-decode";
import {
  STAMP_QR_CORNERS,
  STAMP_SERIAL_ALPHABET,
  STAMP_SERIAL_PATTERN,
  STAMP_AUTH_CODE_MAX_LENGTH,
  buildStampQrPayload,
  canPlaceStampQr,
  generateStampSerial,
  parseStampQrPayload,
  validateStampAuthCode,
  validateStampCreatedDate,
  stampQrMinSizePx,
  stampQrModules,
  type StampQrCorner,
  type StampQrOptionalInfo,
} from "@/lib/processors/browser/electronic-stamp";

/**
 * 電子印鑑：固有番号・印鑑作成日・認証コードとQRコードのテスト。
 *
 * 確かめること:
 *  - 固有番号の形式(MS-XXXX-XXXX-XXXX、見間違えやすい 0・1・I・L・O を使わない)・重複しない・暗号学的に安全な乱数を使う
 *  - QRコードに入れる文字列：「固有番号: …」の行は必ず、印鑑作成日・認証コードは入力したときだけ、入力どおりに入る
 *    (未入力の項目の行は入らない・ほかの情報は入らない)。認証コード・日付の入力の確認
 *  - 新しく生成すると新しい番号、同じ印影を何度ダウンロードしても同じ番号(同じ画像)。入力を変えただけでは番号は変わらない
 *  - 文字から作る印影：QRコードを、丸印は円の外側の四隅(円の大きさは変えず、画像を大きくする)、角印は枠の内側の四隅の、
 *    選んだ隅に置く(白い四角は使わない)。ダウンロードした画像を、独立した2つの読み取りライブラリ(OpenCV・ZXing。
 *    入っている環境だけ)で読み取り、入れた文字列と一致すること・QRコードが選んだ隅にあることを確かめる
 *  - 取り込んだ印影：下にQRコード(白い四角)を並べ、その模様が入れた文字列のQRコードと同じ
 *  - QRコードを入れない設定(番号・作成日・認証コードの欄を出さず、番号を発行しない)・小さすぎる印影・角印
 *  - 生成・ダウンロードのあいだに、通信が起きない・ブラウザに保存しない
 * 電子印鑑の出力はPNGだけ(PDFは取り込むときの入力だけで、PDFの出力は無い)。
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

plainTest("QRコードに入れる文字列：番号は必ず、作成日・認証コードは入力したときだけ、入力どおりに入る", () => {
  const serial = "MS-7K9P-2XQ8-4D6A";
  plainExpect(buildStampQrPayload({ serial })).toBe("固有番号: MS-7K9P-2XQ8-4D6A");
  plainExpect(buildStampQrPayload({ serial, createdDate: "2026-11-09" })).toBe("固有番号: MS-7K9P-2XQ8-4D6A\n印鑑作成日: 2026-11-09");
  plainExpect(buildStampQrPayload({ serial, authCode: "ABC123" })).toBe("固有番号: MS-7K9P-2XQ8-4D6A\n認証コード: ABC123");
  plainExpect(buildStampQrPayload({ serial, createdDate: "1999-01-31", authCode: "a-b_c.D" })).toBe(
    "固有番号: MS-7K9P-2XQ8-4D6A\n印鑑作成日: 1999-01-31\n認証コード: a-b_c.D"
  );
  // 空の項目は入れない(補わない)
  plainExpect(buildStampQrPayload({ serial, createdDate: "", authCode: "" })).toBe("固有番号: MS-7K9P-2XQ8-4D6A");
  // 読み取った文字列を項目に戻せる(ほかの形式は null)
  plainExpect(parseStampQrPayload("固有番号: MS-7K9P-2XQ8-4D6A\n認証コード: X:Y")).toEqual({ serial, authCode: "X:Y" });
  plainExpect(parseStampQrPayload("MS-7K9P-2XQ8-4D6A")).toBeNull();
  plainExpect(parseStampQrPayload("固有番号: A\n氏名: 山田")).toBeNull();
});

plainTest("入力の確認：認証コードは半角の英数字と記号・20文字まで(空白・改行・全角は理由を返す)、日付は実在する年-月-日", () => {
  plainExpect(validateStampAuthCode("")).toBeNull();
  plainExpect(validateStampAuthCode("ABC-123_x.~!")).toBeNull();
  plainExpect(validateStampAuthCode("A".repeat(STAMP_AUTH_CODE_MAX_LENGTH))).toBeNull();
  plainExpect(validateStampAuthCode("A".repeat(STAMP_AUTH_CODE_MAX_LENGTH + 1))).toContain("20文字まで");
  for (const bad of ["AB C", "AB\n固有番号: X", "ＡＢＣ", "山田"]) plainExpect(validateStampAuthCode(bad)).toContain("半角の英数字と記号");
  plainExpect(validateStampCreatedDate("")).toBeNull();
  plainExpect(validateStampCreatedDate("2026-11-09")).toBeNull();
  plainExpect(validateStampCreatedDate("2024-02-29")).toBeNull();
  plainExpect(validateStampCreatedDate("2026-02-30")).toContain("存在しない");
  plainExpect(validateStampCreatedDate("2026/11/09")).toContain("年-月-日");
});

plainTest("QRコード：入れる情報が増えると、マスの大きさはそのままで、マスの数(型番)が増える。番号ごとに模様が違う", () => {
  const serial = "MS-7K9P-2XQ8-4D6A";
  const sizes = [
    buildStampQrPayload({ serial }),
    buildStampQrPayload({ serial, createdDate: "2026-11-09" }),
    buildStampQrPayload({ serial, createdDate: "2026-11-09", authCode: "A".repeat(20) }),
  ].map((t) => stampQrModules(t).length);
  plainExpect(sizes[0]).toBeLessThan(sizes[1]);
  plainExpect(sizes[1]).toBeLessThan(sizes[2]);
  const a = stampQrModules(buildStampQrPayload({ serial }));
  const b = stampQrModules(buildStampQrPayload({ serial: "MS-7K9P-2XQ8-4D6B" }));
  plainExpect(a.every((row) => row.length === a.length)).toBe(true);
  plainExpect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
});

plainTest("QRコードの配置：丸印はいつでも入る。角印は、入れる情報が多いほど大きな印影が必要(既定の300pxなら全部入る)", () => {
  const full: StampQrOptionalInfo = { createdDate: "2026-11-09", authCode: "A".repeat(20) };
  for (const opt of [{}, { createdDate: "2026-11-09" }, { authCode: "ABC123" }, full]) {
    plainExpect(canPlaceStampQr({ sizePx: 120, shape: "round", borderWidthRatio: 0.05, ...opt })).toBe(true);
    plainExpect(canPlaceStampQr({ sizePx: 120, shape: "square", borderWidthRatio: 0.05, ...opt })).toBe(false);
    const min = stampQrMinSizePx({ shape: "square", borderWidthRatio: 0.05, ...opt })!;
    plainExpect(min).toBeLessThanOrEqual(300);
    plainExpect(canPlaceStampQr({ sizePx: min, shape: "square", borderWidthRatio: 0.05, ...opt })).toBe(true);
    plainExpect(canPlaceStampQr({ sizePx: min - 10, shape: "square", borderWidthRatio: 0.05, ...opt })).toBe(false);
  }
  plainExpect(stampQrMinSizePx({ shape: "square", borderWidthRatio: 0.05, ...full })!).toBeGreaterThan(stampQrMinSizePx({ shape: "square", borderWidthRatio: 0.05 })!);
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

/** QRコード(1辺 n マス)の模様を、画像から読み取る(マスの中心の画素の明るさ) */
function readQrModules(png: DecodedPng, n: number): boolean[][] | null {
  const box = findQrBox(png);
  if (!box) return null;
  const total = n + 8; // n マス + 余白4マス×2
  const m = box.side / total;
  if (Math.abs(m - Math.round(m)) > 0.01) return null; // マスの大きさは整数のpx
  const out: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) {
      const p = px(png, Math.floor(box.x + (c + 4.5) * m), Math.floor(box.y + (r + 4.5) * m));
      const lightness = (Math.max(p.r, p.g, p.b) + Math.min(p.r, p.g, p.b)) / 2;
      row.push(p.a > 128 && lightness < 180);
    }
    out.push(row);
  }
  return out;
}

/** 文字から作る印影：QRコードから入れた文字列(payload)だけを読み取れ、選んだ隅(画像の外側の30%の範囲)にあり、白い四角が無い */
function expectCornerQr(file: string, payload: string, corner: StampQrCorner) {
  const png = decodePng(file);
  let white = 0;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (isWhite(px(png, x, y))) white++;
  expect(white, "白い四角がある").toBe(0);
  const decoders = qrDecoders();
  if (!decoders.opencv) return;
  const [r] = decodeQrFile(file);
  expect(r.opencv, "OpenCVで読み取れない").toBe(payload);
  if (r.zxing !== null) expect(r.zxing, "ZXingで読み取れない").toBe(payload);
  const pts = qrCorners(file);
  expect(pts, "QRコードの位置が見つからない").not.toBeNull();
  const cx = pts!.reduce((a, p) => a + p[0], 0) / 4 / png.width;
  const cy = pts!.reduce((a, p) => a + p[1], 0) / 4 / png.height;
  expect(corner.endsWith("right") ? cx > 0.7 : cx < 0.3, `QRコードが${corner}にない(x=${cx.toFixed(2)})`).toBe(true);
  expect(corner.startsWith("bottom") ? cy > 0.7 : cy < 0.3, `QRコードが${corner}にない(y=${cy.toFixed(2)})`).toBe(true);
}

/** 取り込んだ印影：下の白い四角のQRコードの模様が、payload を入れたQRコードと同じで、読み取ると payload だけ */
function expectBelowQr(file: string, payload: string) {
  const png = decodePng(file);
  const expected = stampQrModules(payload);
  const modules = readQrModules(png, expected.length);
  expect(modules, "画像の中にQRコードが見つからない").not.toBeNull();
  expect(JSON.stringify(modules)).toBe(JSON.stringify(expected));
  if (qrDecoders().opencv) {
    const [r] = decodeQrFile(file);
    expect(r.opencv).toBe(payload);
    if (r.zxing !== null) expect(r.zxing).toBe(payload);
  }
}

/** 画像の中央の行で、いちばん左といちばん右の不透明な画素のあいだの幅(丸印の円の外側の直径) */
function centerRowSpan(png: DecodedPng): number {
  const y = Math.floor(png.height / 2);
  let x0 = -1;
  let x1 = -1;
  for (let x = 0; x < png.width; x++) {
    if (px(png, x, y).a > 128) {
      if (x0 < 0) x0 = x;
      x1 = x;
    }
  }
  return x0 < 0 ? 0 : x1 - x0 + 1;
}

async function fillQrInfo(page: Page, opt: StampQrOptionalInfo) {
  await page.getByTestId("stamp-created-date").fill(opt.createdDate ?? "");
  await page.getByTestId("stamp-auth-code").fill(opt.authCode ?? "");
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
    // 丸印は、円の大きさ(印影サイズ300px)を変えずに、隅のQRコードの分だけ画像が大きくなる
    expect(png.width).toBe(png.height);
    expect(png.width).toBeGreaterThan(300);
    expect(Math.abs(centerRowSpan(png) - 296)).toBeLessThanOrEqual(2);
    expect(countTransparentPixels(png)).toBeGreaterThan(0); // 背景は透明のまま
    expectCornerQr(path, buildStampQrPayload({ serial }), "bottom-right"); // 既定は右下。作成日・認証コードの行は無い
    // 氏名などは入れない：読み取った文字列は「固有番号: …」の1行だけ(上で確認)
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
    expect(decodePng(path).width).toBe(600); // 角印は画像の大きさが変わらない
    expectCornerQr(path, buildStampQrPayload({ serial }), "bottom-right");
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
        expectCornerQr(path, buildStampQrPayload({ serial }), c.id);
        await page.keyboard.press("Escape");
      }
      expect(previews.size, "隅を変えてもプレビューが変わらない").toBe(4);
    });
  }

  const combos: { label: string; opt: StampQrOptionalInfo }[] = [
    { label: "固有番号のみ", opt: {} },
    { label: "固有番号＋作成日", opt: { createdDate: "2026-11-09" } },
    { label: "固有番号＋認証コード", opt: { authCode: "ABC123" } },
    { label: "固有番号＋作成日＋認証コード(20文字・記号)", opt: { createdDate: "1999-01-31", authCode: "Zz9-_.~!@#$%^&*()+=A" } },
  ];
  for (const shape of ["round", "square"] as const) {
    test(`QRコードに入れる情報の組み合わせ(${shape === "round" ? "丸印" : "角印"})：読み取った内容が入力どおり・未入力の項目は入らない・完成画面に表示`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(TOOL_URL);
      await page.locator("#stamp-text-input").fill("鈴木");
      if (shape === "square") await page.getByRole("button", { name: "角印", exact: true }).click();
      for (const [i, { label, opt }] of combos.entries()) {
        await fillQrInfo(page, opt);
        await page.getByTestId(`qr-corner-${STAMP_QR_CORNERS[i].id}`).click();
        const serial = await generate(page);
        expect(serial, label).toMatch(STAMP_SERIAL_PATTERN);
        // 完成画面：入力した項目だけを表示
        await expect(page.getByTestId("stamp-qr-created-date")).toHaveCount(opt.createdDate ? 1 : 0);
        await expect(page.getByTestId("stamp-qr-auth-code")).toHaveCount(opt.authCode ? 1 : 0);
        if (opt.createdDate) await expect(page.getByTestId("stamp-qr-created-date")).toHaveText(opt.createdDate);
        if (opt.authCode) await expect(page.getByTestId("stamp-qr-auth-code")).toHaveText(opt.authCode);
        await expect(page.getByTestId("stamp-qr-contents")).not.toContainText("認証済み");
        const { path } = await assertDownloadedFile(await clickAndDownload(page, "PNGをダウンロード"), { format: "png", minBytes: 100 });
        const payload = buildStampQrPayload({ serial, ...opt });
        expectCornerQr(path, payload, STAMP_QR_CORNERS[i].id);
        if (qrDecoders().opencv) expect(parseStampQrPayload(decodeQrFile(path)[0].opencv!)).toEqual({ serial, ...opt });
        // 認証コード・番号は印影に文字として出さない(画像の中に文字は描いていない：確認は読み取り結果と、下の画面の文字で)
        await page.keyboard.press("Escape");
      }
    });
  }

  test("入力を変えても番号は変わらない(再ダウンロードも同じ)・もう一度生成すると新しい番号と新しい入力", async ({ page }) => {
    await page.goto(TOOL_URL);
    await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "FIRST" });
    const serial = await generate(page);
    const first = await clickAndDownload(page, "PNGをダウンロード");
    const f1 = (await first.path())!;
    await page.keyboard.press("Escape");
    // 入力・設定を変える(画面は描き直されるが、完成した印影と番号はそのまま)
    await fillQrInfo(page, { createdDate: "2027-01-01", authCode: "SECOND" });
    await page.getByTestId("qr-corner-top-left").click();
    await page.getByRole("button", { name: "結果を表示する" }).click();
    await expect(page.getByTestId("stamp-serial")).toHaveText(serial);
    await expect(page.getByTestId("stamp-qr-auth-code")).toHaveText("FIRST");
    const again = await clickAndDownload(page, "PNGをダウンロード");
    expect(again.suggestedFilename()).toBe(first.suggestedFilename());
    expect(fs.readFileSync((await again.path())!).equals(fs.readFileSync(f1))).toBe(true);
    if (qrDecoders().opencv) expect(decodeQrFile(f1)[0].opencv).toBe(buildStampQrPayload({ serial, createdDate: "2026-11-09", authCode: "FIRST" }));
    await page.keyboard.press("Escape");
    const serial2 = await generate(page);
    expect(serial2).not.toBe(serial);
    await expect(page.getByTestId("stamp-qr-auth-code")).toHaveText("SECOND");
    await expect(page.getByTestId("stamp-qr-created-date")).toHaveText("2027-01-01");
  });

  test("使えない認証コードは理由を出し、生成できない(入力を勝手に直さない)", async ({ page }) => {
    await page.goto(TOOL_URL);
    const button = page.getByRole("button", { name: "印影画像を生成する", exact: true });
    for (const bad of ["AB C", "全角", "A".repeat(21)]) {
      await page.getByTestId("stamp-auth-code").fill(bad);
      await expect(page.getByTestId("stamp-auth-code")).toHaveValue(bad);
      await expect(page.getByText(validateStampAuthCode(bad)!, { exact: true })).toBeVisible();
      await expect(button).toBeDisabled();
    }
    await page.getByTestId("stamp-auth-code").fill("OK-1");
    await expect(button).toBeEnabled();
  });

  test("QRコードを入れない設定では、番号を発行せず、従来どおりの印影になる", async ({ page }) => {
    await page.goto(TOOL_URL);
    await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "ABC" });
    await page.getByLabel("固有番号とQRコードを入れる").uncheck();
    // 番号・作成日・認証コードの欄は出さない
    await expect(page.getByTestId("stamp-created-date")).toHaveCount(0);
    await expect(page.getByTestId("stamp-auth-code")).toHaveCount(0);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0);
    const download = await clickAndDownload(page, "PNGをダウンロード");
    expect(download.suggestedFilename()).toBe("electronic-stamp.png");
    const { path } = await assertDownloadedFile(download, { format: "png", minBytes: 100 });
    expect(findQrBox(decodePng(path))).toBeNull();
    expect(decodePng(path).width).toBe(300); // QRコードを入れないときは、丸印でも画像は印影サイズのまま
    await expect(page.getByTestId("stamp-qr-contents")).toHaveCount(0);
    if (qrDecoders().opencv) expect(decodeQrFile(path)[0].opencv).toBe("");
  });

  test("小さすぎる印影では注意を出し、QRコードの無い印影にする", async ({ page }) => {
    await page.goto(TOOL_URL);
    await page.getByRole("button", { name: "角印", exact: true }).click();
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

test("固有番号とQRコード：取り込んだ印影には、下にQRコード(番号・作成日・認証コード)を並べる", async ({ page }) => {
  await page.goto(TOOL_URL);
  await page.getByRole("button", { name: "印鑑を取り込む", exact: true }).click();
  await uploadFixture(page, fixtures.stampPng);
  await page.getByRole("button", { name: "切り抜く", exact: true }).click();
  await expect(page.locator('[data-testid="stamp-final-preview"]')).toBeVisible({ timeout: 15_000 });
  await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "IMPORT-1" });
  const serial = await generate(page);
  expect(serial).toMatch(STAMP_SERIAL_PATTERN);
  const { path } = await assertDownloadedFile(await clickAndDownload(page, "PNGをダウンロード"), { format: "png", minBytes: 100 });
  expectBelowQr(path, buildStampQrPayload({ serial, createdDate: "2026-11-09", authCode: "IMPORT-1" }));
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
  await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "PRIVATE-77" });
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
  const offending = requests.filter(
    (r) => !r.startsWith("GET ") || !new URL(r.slice(4)).hostname.match(/^(localhost|127\.0\.0\.1)$/) || r.includes(serial) || r.includes("PRIVATE-77")
  );
  expect(offending, offending.join("\n")).toEqual([]);
  // ブラウザに保存しない
  const stored = await page.evaluate(async () => {
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return { local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), dbs: dbs.length };
  });
  for (const v of [serial, "PRIVATE-77", "2026-11-09"]) {
    expect(stored.local).not.toContain(v);
    expect(stored.session).not.toContain(v);
  }
});
