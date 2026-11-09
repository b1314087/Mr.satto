import { test, expect } from "../fixtures/premium-test";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { decodePng, countTransparentPixels, type DecodedPng } from "../helpers/png-inspect";
import { decodeQrFile, qrCorners, qrDecoders } from "../helpers/qr-decode";
import { scratchDir } from "../helpers/tmp";
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
  type StampQrOptionalInfo,
} from "@/lib/processors/browser/electronic-stamp";

/**
 * 電子印鑑：固有番号・印鑑作成日・認証コードとQRコード、PDFへの押印のテスト。
 *
 * 確かめること:
 *  - 固有番号の形式(MS-XXXX-XXXX-XXXX、見間違えやすい 0・1・I・L・O を使わない)・重複しない・暗号学的に安全な乱数を使う
 *  - QRコードに入れる文字列：「固有番号: …」の行は必ず、印鑑作成日・認証コードは入力したときだけ、入力どおりに入る
 *    (未入力の項目の行は入らない・ほかの情報は入らない)。認証コード・日付の入力の確認
 *  - 固有番号とQRコードを入れるときは、押印するPDFを選ばないと生成できない。印影は選んだページの、横(X)・縦(Y)の
 *    バーで決めた位置・大きさ(mm)に押し、PDFとして出力する(印影だけのPNGは出さない)。ページの回転(/Rotate)も反映する
 *  - 出力したPDFのページを画像にして、独立した2つの読み取りライブラリ(OpenCV・ZXing。入っている環境だけ)で読み取り、
 *    入れた文字列と一致すること・QRコードが選んだ隅(丸印は円の外側、角印は枠の内側)にあることを確かめる
 *  - 新しく生成すると新しい番号、同じPDFを何度ダウンロードしても同じ。入力を変えただけでは番号は変わらない
 *  - QRコードを入れない設定(既定)：PDFは不要で、従来どおり印影のPNGを出す(番号を発行しない)
 *  - 取り込んだ印影：下にQRコードを並べた印影を、選んだPDFに押す
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
// 押印するPDF・出力したPDFを調べる
// ---------------------------------------------------------------------------

const px = (png: DecodedPng, x: number, y: number) => {
  const i = (y * png.width + x) * 4;
  return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2], a: png.data[i + 3] };
};
const isWhite = (p: { r: number; g: number; b: number; a: number }) => p.a === 255 && p.r >= 250 && p.g >= 250 && p.b >= 250;

/** 画像の中のQRコードの白い四角を探す(QRコードの無い印影に、白い四角が無いことの確認用) */
function hasWhiteBox(png: DecodedPng): boolean {
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) if (isWhite(px(png, x, y))) return true;
  return false;
}

const A4 = { w: 595.28, h: 841.89 };

/** 押印するPDFを作る(テストの中で作る。pages は各ページの大きさ・回転) */
async function makePdf(name: string, pages: { w: number; h: number; rotate?: number }[]): Promise<string> {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const page = doc.addPage([p.w, p.h]);
    // 白い背景の上に、薄い灰色の線(文書の代わり)
    page.drawRectangle({ x: 36, y: 36, width: p.w - 72, height: p.h - 72, borderWidth: 0.5, borderColor: rgb(0.7, 0.7, 0.7) });
    if (p.rotate) page.setRotation(degrees(p.rotate));
  }
  const file = path.join(scratchDir("stamp-target-pdf"), name);
  fs.writeFileSync(file, await doc.save());
  return file;
}

/** PDFの1ページを画像(PNG)にする(dpi はインチあたりの点の数)。表示される向き(回転を反映)で描かれる */
function renderPdfPage(pdf: string, pageNo: number, dpi = 300): string {
  const dir = scratchDir("stamp-rendered");
  const base = path.join(dir, `p${pageNo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  execFileSync("pdftoppm", ["-png", "-r", String(dpi), "-f", String(pageNo), "-l", String(pageNo), "-singlefile", pdf, base]);
  return `${base}.png`;
}

/** 出力したPDFのページの見た目の大きさ(pt。回転を反映) */
async function visiblePageBox(pdf: string, pageNo: number) {
  const doc = await PDFDocument.load(fs.readFileSync(pdf));
  const page = doc.getPage(pageNo - 1);
  const { width, height } = page.getCropBox();
  const r = page.getRotation().angle % 180 !== 0;
  return { width: r ? height : width, height: r ? width : height, pageCount: doc.getPageCount() };
}

interface PlacedCheck {
  payload: string;
  pageNo: number;
  xPct: number;
  yPct: number;
  widthMm: number;
}

/**
 * 出力したPDFの指定ページを画像にして、QRコードを読み取り、入れた文字列だけが取れること・QRコードが押した印影の範囲の、
 * 選んだ隅にあること・正しい向き(上下・左右が逆でない)であることを確かめる
 */
async function expectStampedQr(pdf: string, c: PlacedCheck) {
  const dpi = 300;
  const png = renderPdfPage(pdf, c.pageNo, dpi);
  if (!qrDecoders().opencv) return;
  const [r] = decodeQrFile(png);
  expect(r.opencv, "OpenCVで読み取れない").toBe(c.payload);
  if (r.zxing !== null) expect(r.zxing, "ZXingで読み取れない").toBe(c.payload);
  const pts = qrCorners(png);
  expect(pts, "QRコードの位置が見つからない").not.toBeNull();
  const k = dpi / 72;
  const box = await visiblePageBox(pdf, c.pageNo);
  const qx = pts!.reduce((a, p) => a + p[0], 0) / 4 / k;
  const qy = pts!.reduce((a, p) => a + p[1], 0) / 4 / k;
  // 印影の幅(widthMm)を基準に、画像は最大でその1.4倍。X・Yのバーの割合から、印影の左上の位置の範囲を確かめる
  const wMin = (c.widthMm * 72) / 25.4;
  const wMax = wMin * 1.4;
  const xLo = (c.xPct / 100) * (box.width - wMax);
  const xHi = (c.xPct / 100) * (box.width - wMin) + wMax;
  const yLo = (c.yPct / 100) * (box.height - wMax * 1.3);
  const yHi = (c.yPct / 100) * (box.height - wMin) + wMax * 1.3;
  expect(qx >= xLo - 2 && qx <= xHi + 2, `QRコードの横の位置 ${qx.toFixed(0)}pt が、押した位置(${xLo.toFixed(0)}〜${xHi.toFixed(0)}pt)にない`).toBe(true);
  expect(qy >= yLo - 2 && qy <= yHi + 2, `QRコードの縦の位置 ${qy.toFixed(0)}pt が、押した位置(${yLo.toFixed(0)}〜${yHi.toFixed(0)}pt)にない`).toBe(true);
  // 向き：OpenCV が返すQRコードの角は、QRコードの左上から時計回り。正しい向きなら、1つ目の角が左上にある
  const [p0] = pts!;
  const cx = qx * k;
  const cy = qy * k;
  expect(p0[0] < cx && p0[1] < cy, "QRコードの向きが正しくない(回転している)").toBe(true);
}

async function enableQr(page: Page) {
  // 画面の準備(読み込み直後)が終わる前に押すと、チェックだけが付いて欄が出ないことがあるので、欄が出るまで押し直す
  await expect(async () => {
    const box = page.getByLabel("固有番号とQRコードを入れる");
    if (await box.isChecked()) await box.uncheck();
    await box.check();
    await expect(page.getByTestId("stamp-pdf-target")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

async function attachPdf(page: Page, file: string) {
  await page.getByTestId("stamp-target-pdf-input").setInputFiles(file);
  await expect(page.getByTestId("stamp-target-pdf-name")).toContainText(path.basename(file));
}

async function setSlider(page: Page, label: string, value: number) {
  await page.getByRole("slider", { name: label }).fill(String(value));
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

async function downloadPdf(page: Page) {
  const d = await clickAndDownload(page, "PDFをダウンロード");
  const { path: file } = await assertDownloadedFile(d, { format: "pdf", minBytes: 100 });
  return { file, name: d.suggestedFilename() };
}

// ---------------------------------------------------------------------------
// 文字から作る印影
// ---------------------------------------------------------------------------

test.describe("固有番号とQRコード：文字から作る印影をPDFに押す", () => {
  test("QRコードを入れるときはPDFを選ばないと生成できず、選ぶと、選んだ位置に押したPDFを出力する(番号だけのQRコード)", async ({ page }) => {
    const src = await makePdf("one-page.pdf", [A4]);
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("山田");
    await enableQr(page);
    const button = page.getByRole("button", { name: "印影画像を生成する", exact: true });
    await expect(button).toBeDisabled();
    await expect(page.getByText("PDFを選ぶと、印影を生成できるようになります", { exact: false })).toBeVisible();
    await attachPdf(page, src);
    await expect(button).toBeEnabled();
    // 位置の確認用に、PDFのページの上に印影を重ねて表示する
    await expect(page.locator('canvas[aria-label="PDFの上の印影の位置"]')).toBeVisible();
    await setSlider(page, "PDF上の印影の大きさ", 50);
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0); // 生成する前は番号を発行しない
    const serial = await generate(page);
    expect(serial).toMatch(STAMP_SERIAL_PATTERN);
    await expect(page.getByTestId("stamp-result-summary")).toHaveText("この印影を、PDF（全1ページ）の1ページ目に押しました。");
    // QRコードを入れた印影は、PNGでは出さない
    await expect(page.getByRole("button", { name: "PNGをダウンロード" })).toHaveCount(0);
    const { file, name } = await downloadPdf(page);
    expect(name).toBe(`electronic-stamp-${serial}.pdf`);
    const box = await visiblePageBox(file, 1);
    expect(box.pageCount).toBe(1);
    expect(Math.round(box.width)).toBe(595); // ページの大きさは変わらない
    // 既定の位置は右上(横85%・縦10%)。読み取ると「固有番号: …」の1行だけ
    await expectStampedQr(file, { payload: buildStampQrPayload({ serial }), pageNo: 1, xPct: 85, yPct: 10, widthMm: 50 });
    expect(serial).not.toContain("山田");
  });

  test("X・Yのバーで位置を、ページの選択で押すページを変えられ、見た目の位置・向きどおりに押す(回転したページ・横向きのページ)", async ({ page }) => {
    test.setTimeout(180_000);
    const src = await makePdf("three-pages.pdf", [A4, { w: A4.h, h: A4.w }, { ...A4, rotate: 90 }]);
    await page.goto(TOOL_URL);
    await page.locator("#stamp-text-input").fill("佐藤");
    await enableQr(page);
    await attachPdf(page, src);
    await setSlider(page, "PDF上の印影の大きさ", 50);
    const cases = [
      { pageIndex: 0, x: 0, y: 100 },
      { pageIndex: 1, x: 100, y: 0 },
      { pageIndex: 2, x: 20, y: 70 },
    ];
    for (const c of cases) {
      await page.getByTestId("stamp-target-page").selectOption(String(c.pageIndex));
      await setSlider(page, "印影の横の位置（X）", c.x);
      await setSlider(page, "印影の縦の位置（Y）", c.y);
      const serial = await generate(page);
      await expect(page.getByTestId("stamp-result-summary")).toContainText(`${c.pageIndex + 1}ページ目`);
      const { file } = await downloadPdf(page);
      expect((await visiblePageBox(file, 1)).pageCount).toBe(3);
      await expectStampedQr(file, { payload: buildStampQrPayload({ serial }), pageNo: c.pageIndex + 1, xPct: c.x, yPct: c.y, widthMm: 50 });
      // ほかのページには押さない
      if (qrDecoders().opencv) {
        for (let p = 1; p <= 3; p++) if (p !== c.pageIndex + 1) expect(decodeQrFile(renderPdfPage(file, p, 150))[0].opencv).toBe("");
      }
      await page.keyboard.press("Escape");
    }
  });

  test("PDF上の印影の大きさ(mm)：丸印は円の直径が指定した大きさになる(QRコードは円の外側)", async ({ page }) => {
    const src = await makePdf("size.pdf", [A4]);
    await page.goto(TOOL_URL);
    await enableQr(page);
    await attachPdf(page, src);
    await setSlider(page, "PDF上の印影の大きさ", 40);
    await setSlider(page, "印影の横の位置（X）", 50);
    await setSlider(page, "印影の縦の位置（Y）", 50);
    await generate(page);
    const { file } = await downloadPdf(page);
    // ページの中央の行で、朱色の画素の左端〜右端(円の外側の直径)を測る。QRコードは円の外側の隅なので、中央の行には無い
    const dpi = 200;
    const png = decodePng(renderPdfPage(file, 1, dpi));
    let best = 0;
    for (let y = Math.floor(png.height * 0.4); y < png.height * 0.6; y += 2) {
      let x0 = -1;
      let x1 = -1;
      for (let x = 0; x < png.width; x++) {
        const p = px(png, x, y);
        if (p.r > 140 && p.g < 110 && p.b < 110) {
          if (x0 < 0) x0 = x;
          x1 = x;
        }
      }
      if (x0 >= 0) best = Math.max(best, x1 - x0 + 1);
    }
    const mm = (best / dpi) * 25.4;
    expect(Math.abs(mm - 40), `円の直径 ${mm.toFixed(1)}mm`).toBeLessThanOrEqual(1);
  });

  const combos: { label: string; opt: StampQrOptionalInfo }[] = [
    { label: "固有番号のみ", opt: {} },
    { label: "固有番号＋作成日", opt: { createdDate: "2026-11-09" } },
    { label: "固有番号＋認証コード", opt: { authCode: "ABC123" } },
    { label: "固有番号＋作成日＋認証コード(20文字・記号)", opt: { createdDate: "1999-01-31", authCode: "Zz9-_.~!@#$%^&*()+=A" } },
  ];
  for (const shape of ["round", "square"] as const) {
    test(`QRコードに入れる情報の組み合わせ・4つの隅(${shape === "round" ? "丸印" : "角印"})：読み取った内容が入力どおり・未入力の項目は入らない`, async ({ page }) => {
      test.setTimeout(180_000);
      const src = await makePdf(`combos-${shape}.pdf`, [A4]);
      await page.goto(TOOL_URL);
      await page.locator("#stamp-text-input").fill("鈴木");
      if (shape === "square") await page.getByRole("button", { name: "角印", exact: true }).click();
      await enableQr(page);
      await attachPdf(page, src);
      await setSlider(page, "PDF上の印影の大きさ", 50);
      const previews = new Set<string>();
      for (const [i, { label, opt }] of combos.entries()) {
        const corner = STAMP_QR_CORNERS[i].id;
        await page.getByRole("button", { name: i % 2 ? /黒/ : /朱色/ }).click();
        await fillQrInfo(page, opt);
        await page.getByTestId(`qr-corner-${corner}`).click();
        await expect(page.getByTestId(`qr-corner-${corner}`)).toHaveAttribute("aria-pressed", "true");
        previews.add(await page.locator('canvas[aria-label="印影のプレビュー"]').evaluate((el: HTMLCanvasElement) => el.toDataURL()));
        await setSlider(page, "印影の横の位置（X）", 50);
        await setSlider(page, "印影の縦の位置（Y）", 50);
        const serial = await generate(page);
        expect(serial, label).toMatch(STAMP_SERIAL_PATTERN);
        // 完成画面：入力した項目だけを表示
        await expect(page.getByTestId("stamp-qr-created-date")).toHaveCount(opt.createdDate ? 1 : 0);
        await expect(page.getByTestId("stamp-qr-auth-code")).toHaveCount(opt.authCode ? 1 : 0);
        if (opt.createdDate) await expect(page.getByTestId("stamp-qr-created-date")).toHaveText(opt.createdDate);
        if (opt.authCode) await expect(page.getByTestId("stamp-qr-auth-code")).toHaveText(opt.authCode);
        await expect(page.getByTestId("stamp-qr-contents")).not.toContainText("認証済み");
        const { file } = await downloadPdf(page);
        const payload = buildStampQrPayload({ serial, ...opt });
        await expectStampedQr(file, { payload, pageNo: 1, xPct: 50, yPct: 50, widthMm: 50 });
        if (qrDecoders().opencv) {
          const png = renderPdfPage(file, 1, 300);
          expect(parseStampQrPayload(decodeQrFile(png)[0].opencv!)).toEqual({ serial, ...opt });
          // QRコードは、ページの中央に押した印影の、選んだ隅の側にある
          const pts = qrCorners(png)!;
          const img = decodePng(png);
          const cx = pts.reduce((a, p) => a + p[0], 0) / 4 / img.width;
          const cy = pts.reduce((a, p) => a + p[1], 0) / 4 / img.height;
          expect(corner.endsWith("right") ? cx > 0.5 : cx < 0.5, `${corner}：横`).toBe(true);
          expect(corner.startsWith("bottom") ? cy > 0.5 : cy < 0.5, `${corner}：縦`).toBe(true);
        }
        await page.keyboard.press("Escape");
      }
      expect(previews.size, "隅・色を変えてもプレビューが変わらない").toBe(4);
    });
  }

  test("入力を変えても番号は変わらない(再ダウンロードも同じPDF)・もう一度生成すると新しい番号と新しい入力", async ({ page }) => {
    const src = await makePdf("keep.pdf", [A4]);
    await page.goto(TOOL_URL);
    await enableQr(page);
    await attachPdf(page, src);
    await setSlider(page, "PDF上の印影の大きさ", 50);
    await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "FIRST" });
    const serial = await generate(page);
    const first = await downloadPdf(page);
    await page.keyboard.press("Escape");
    // 入力・設定・位置を変える(画面は描き直されるが、完成したPDFと番号はそのまま)
    await fillQrInfo(page, { createdDate: "2027-01-01", authCode: "SECOND" });
    await page.getByTestId("qr-corner-top-left").click();
    await setSlider(page, "印影の横の位置（X）", 10);
    await page.getByRole("button", { name: "結果を表示する" }).click();
    await expect(page.getByTestId("stamp-serial")).toHaveText(serial);
    await expect(page.getByTestId("stamp-qr-auth-code")).toHaveText("FIRST");
    const again = await downloadPdf(page);
    expect(again.name).toBe(first.name);
    expect(fs.readFileSync(again.file).equals(fs.readFileSync(first.file))).toBe(true);
    await expectStampedQr(first.file, {
      payload: buildStampQrPayload({ serial, createdDate: "2026-11-09", authCode: "FIRST" }),
      pageNo: 1,
      xPct: 85,
      yPct: 10,
      widthMm: 50,
    });
    await page.keyboard.press("Escape");
    const serial2 = await generate(page);
    expect(serial2).not.toBe(serial);
    await expect(page.getByTestId("stamp-qr-auth-code")).toHaveText("SECOND");
    await expect(page.getByTestId("stamp-qr-created-date")).toHaveText("2027-01-01");
  });

  test("使えない認証コードは理由を出し、生成できない(入力を勝手に直さない)", async ({ page }) => {
    const src = await makePdf("validate.pdf", [A4]);
    await page.goto(TOOL_URL);
    await enableQr(page);
    await attachPdf(page, src);
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

  test("QRコードを入れない設定(既定)では、PDFは不要で、番号を発行せず、従来どおり印影のPNGになる", async ({ page }) => {
    await page.goto(TOOL_URL);
    await expect(page.getByLabel("固有番号とQRコードを入れる")).not.toBeChecked();
    // 番号・作成日・認証コード・押印するPDFの欄は出さない
    await expect(page.getByTestId("stamp-created-date")).toHaveCount(0);
    await expect(page.getByTestId("stamp-auth-code")).toHaveCount(0);
    await expect(page.getByTestId("stamp-pdf-target")).toHaveCount(0);
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-serial")).toHaveCount(0);
    await expect(page.getByTestId("stamp-qr-contents")).toHaveCount(0);
    const download = await clickAndDownload(page, "PNGをダウンロード");
    expect(download.suggestedFilename()).toBe("electronic-stamp.png");
    const { path: file } = await assertDownloadedFile(download, { format: "png", minBytes: 100 });
    const png = decodePng(file);
    expect(png.width).toBe(300); // QRコードを入れないときは、丸印でも画像は印影サイズのまま
    expect(countTransparentPixels(png)).toBeGreaterThan(0);
    expect(hasWhiteBox(png)).toBe(false);
    if (qrDecoders().opencv) expect(decodeQrFile(file)[0].opencv).toBe("");
  });

  test("小さすぎる角印では注意を出し、QRコードを入れて生成はできない", async ({ page }) => {
    const src = await makePdf("small.pdf", [A4]);
    await page.goto(TOOL_URL);
    await page.getByRole("button", { name: "角印", exact: true }).click();
    await page.getByLabel(/印影サイズ/).fill("150");
    await enableQr(page);
    await attachPdf(page, src);
    await expect(page.getByText("QRコードを入れる場所が足りません", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "印影画像を生成する", exact: true })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 取り込んだ印影
// ---------------------------------------------------------------------------

test("固有番号とQRコード：取り込んだ印影の下にQRコードを並べ、選んだPDFに押す", async ({ page }) => {
  const src = await makePdf("import-target.pdf", [A4, A4]);
  await page.goto(TOOL_URL);
  await page.getByRole("button", { name: "印鑑を取り込む", exact: true }).click();
  await uploadFixture(page, fixtures.stampPng);
  await page.getByRole("button", { name: "切り抜く", exact: true }).click();
  await expect(page.locator('[data-testid="stamp-final-preview"]')).toBeVisible({ timeout: 15_000 });
  await enableQr(page);
  await expect(page.getByRole("button", { name: "印影画像を生成する", exact: true })).toBeDisabled();
  await attachPdf(page, src);
  await page.getByTestId("stamp-target-page").selectOption("1");
  await setSlider(page, "PDF上の印影の大きさ", 50);
  await setSlider(page, "印影の横の位置（X）", 30);
  await setSlider(page, "印影の縦の位置（Y）", 40);
  await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "IMPORT-1" });
  const serial = await generate(page);
  expect(serial).toMatch(STAMP_SERIAL_PATTERN);
  const { file } = await downloadPdf(page);
  await expectStampedQr(file, {
    payload: buildStampQrPayload({ serial, createdDate: "2026-11-09", authCode: "IMPORT-1" }),
    pageNo: 2,
    xPct: 30,
    yPct: 40,
    widthMm: 50,
  });
});

// ---------------------------------------------------------------------------
// プライバシー・乱数
// ---------------------------------------------------------------------------

test("固有番号とQRコード：PDFの読み込み・生成・ダウンロードのあいだに通信が起きず、ブラウザに保存せず、暗号学的に安全な乱数を使う", async ({ page }) => {
  const src = await makePdf("private.pdf", [A4]);
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
  await enableQr(page);
  await fillQrInfo(page, { createdDate: "2026-11-09", authCode: "PRIVATE-77" });
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  // blob: / data: は、ブラウザのメモリの中の画像を指す(画面の表示用)で、通信ではないので除く
  page.on("request", (r) => {
    if (!/^(blob|data):/.test(r.url())) requests.push(`${r.method()} ${r.url()}`);
  });
  await attachPdf(page, src);
  const before = await page.evaluate(() => (window as unknown as { __rv: number }).__rv);
  const serial = await generate(page);
  const after = await page.evaluate(() => (window as unknown as { __rv: number }).__rv);
  expect(after).toBeGreaterThan(before); // 番号の発行で crypto.getRandomValues を使った
  await downloadPdf(page);
  await page.waitForTimeout(500);
  // PDFを読み込む・番号を発行する・押す・ダウンロードする処理で、外部への通信は起きない。
  // (PDFの読み込みに使う、このサイトの中の部品(pdf.js の worker など)の取得だけは、同じサイトからの GET として許す)
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
