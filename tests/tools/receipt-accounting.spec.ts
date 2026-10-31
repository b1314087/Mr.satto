import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { test, expect } from "../fixtures/premium-test";
import { uploadWhenReady } from "../helpers/tool-ready";
import { assertDownloadedFile, clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { buildGenericCsv, buildGenericCsvRows, neutralizeFormula, GENERIC_CSV_HEADER } from "@/lib/accounting/csv-generic";
import { extractDate, extractReceipt, extractTotal, extractVendor, formatDateSlash, toIsoDate } from "@/lib/accounting/receipt-extract";
import { checkReceiptFile, detectReceiptFileKind } from "@/lib/accounting/receipt-file-kind";
import { isTextLayerUsable, linesFromTextItems } from "@/lib/accounting/receipt-pdf-lines";
import { RECEIPT_LIMITS, type TextLine } from "@/lib/accounting/receipt-types";
import { duplicateKeys, parseAmountInput, parseDateInput, sanitizeVendor, validateRow } from "@/lib/accounting/receipt-validate";
import { isAdFreeToolPath } from "@/lib/tools/ad-free-tools";
import { encryptPdfDocument } from "@/lib/pdf/encrypt";

/**
 * 領収書・レシートから会計CSV作成（receipt-accounting-csv）のテスト（工程8）。
 * 1. 抽出・検証・CSV・ファイル判定・PDF文字情報の行まとめ（純粋な関数）の単体テスト。すべて架空のデータ。
 * 2. 実際に画像・PDFを読み込み、確認・修正・確認済み・CSV出力までを通す画面テスト。
 * 3. 読み込んだファイル名・読み取った内容が外部へ送信されないことの確認。
 *
 * OCRの「読み取り精度」は、このテストでは確かめない（実際の領収書での評価は別の工程）。
 * 画面テストでは、OCRの経路が動いて行が追加されることだけを確かめ、値は手入力して確認する。
 */

const lines = (...texts: string[]): TextLine[] => texts.map((text) => ({ text, confidence: null }));
const TODAY = "2026-10-06";

// ---------------------------------------------------------------------------
// 1. 規則（単体）
// ---------------------------------------------------------------------------
plainTest.describe("receipt-accounting: 日付・取引先・合計金額の抽出", () => {
  plainTest("ふつうのレシート：日付・取引先・合計を候補として取り出し、小計・消費税・お預り・お釣りは合計にしない", () => {
    const result = extractReceipt(
      lines(
        "株式会社サンプル商店",
        "東京都千代田区1-2-3",
        "TEL 03-1234-5678",
        "2026年9月15日 12:34",
        "領収書",
        "小計 ¥1,200",
        "消費税(10%) ¥120",
        "合計 ¥1,320",
        "お預り ¥2,000",
        "お釣り ¥680"
      )
    );
    plainExpect(result.date.value).toBe("2026-09-15");
    plainExpect(result.total.value).toBe("1320");
    plainExpect(result.vendor.value).toBe("株式会社サンプル商店");
  });

  plainTest("合計の候補が複数あって決められないときは、自動で入れずに候補を示す", () => {
    const result = extractTotal(lines("合計 ¥1,320", "お支払い金額 ¥1,500"));
    plainExpect(result.value).toBeNull();
    plainExpect(result.candidates.map((c) => c.value).sort()).toEqual(["1320", "1500"]);
    plainExpect(result.note).toBeTruthy();
  });

  plainTest("同じ金額が複数回出てきても、1つの金額なら自動で入れる", () => {
    const result = extractTotal(lines("合計 ¥1,320", "ご請求金額 1,320円"));
    plainExpect(result.value).toBe("1320");
  });

  plainTest("小計・消費税・お預り・お釣り・カード番号だけの書類は、合計を自動で入れない（値を作らない）", () => {
    const result = extractTotal(lines("小計 ¥1,200", "消費税 ¥120", "お預り ¥2,000", "お釣り ¥680", "カード番号 1234 5678 9012"));
    plainExpect(result.value).toBeNull();
    plainExpect(result.candidates.map((c) => c.value)).not.toContain("2000");
    plainExpect(result.candidates.map((c) => c.value)).not.toContain("680");
  });

  plainTest("何も読み取れない書類は、すべて空（推測で埋めない）", () => {
    const result = extractReceipt(lines("ありがとうございました", "またお越しください"));
    plainExpect(result.date.value).toBeNull();
    plainExpect(result.total.value).toBeNull();
    plainExpect(result.date.candidates).toEqual([]);
    plainExpect(result.total.candidates).toEqual([]);
    plainExpect(extractReceipt([]).vendor.value).toBeNull();
  });

  plainTest("日付が複数あるときは自動で入れず候補にする。有効期限などの日付は取引日にしない", () => {
    const two = extractDate(lines("2026/09/15", "2026/09/20"));
    plainExpect(two.value).toBeNull();
    plainExpect(two.candidates.map((c) => c.value)).toEqual(["2026-09-15", "2026-09-20"]);

    const withExpiry = extractDate(lines("2026/09/15 10:00", "有効期限 2027/01/01"));
    plainExpect(withExpiry.value).toBe("2026-09-15");
  });

  plainTest("実在しない日付は候補にしない。和暦・全角・スペース入りも読む", () => {
    plainExpect(extractDate(lines("2026/02/30")).candidates).toEqual([]);
    plainExpect(extractDate(lines("令和8年9月15日")).value).toBe("2026-09-15");
    plainExpect(extractDate(lines("２０２６年　９月　１５日")).value).toBe("2026-09-15");
    plainExpect(toIsoDate(2026, 2, 29)).toBeNull();
    plainExpect(toIsoDate(2024, 2, 29)).toBe("2024-02-29");
    plainExpect(formatDateSlash("2026-09-05")).toBe("2026/09/05");
  });

  plainTest("OCRの信頼度が低い行から読み取った値には「要確認」の印が付くが、値は入れる", () => {
    const low: TextLine[] = [{ text: "合計 ¥1,320", confidence: 40 }, { text: "2026/09/15", confidence: 95 }];
    const result = extractReceipt(low);
    plainExpect(result.total.value).toBe("1320");
    plainExpect(result.total.lowConfidence).toBe(true);
    plainExpect(result.date.lowConfidence).toBe(false);
  });

  plainTest("取引先は、会社名らしい行が1つだけのときに限り自動で入れる。電話番号・住所の行は取引先にしない", () => {
    plainExpect(extractVendor(lines("TEL 03-1234-5678", "東京都千代田区1-2-3")).value).toBeNull();
    const two = extractVendor(lines("株式会社あ商事", "有限会社い商店"));
    plainExpect(two.value).toBeNull();
    plainExpect(two.candidates.length).toBe(2);
  });
});

plainTest.describe("receipt-accounting: 入力の検証", () => {
  plainTest("正しい値は検証を通り、整えた値になる（全角・カンマ・円・前後の空白を許す）", () => {
    const r = validateRow({ date: "2026-09-15", vendor: "  株式会社　サンプル  ", total: " ¥１,３２０円 " }, { today: TODAY });
    plainExpect(r.errors).toEqual([]);
    plainExpect(r.normalized).toEqual({ date: "2026-09-15", vendor: "株式会社 サンプル", total: 1320 });
  });

  plainTest("必須の値が空・不正だと、理由つきのエラーになり、出力用の値は作られない", () => {
    const empty = validateRow({ date: "", vendor: "", total: "" }, { today: TODAY });
    plainExpect(empty.errors.length).toBe(3);
    plainExpect(empty.normalized).toBeNull();
    for (const total of ["0", "-5", "12.5", "abc", "1,000,000,000", "1e3"]) {
      const r = validateRow({ date: "2026-09-15", vendor: "A", total }, { today: TODAY });
      plainExpect(r.normalized, `合計金額 ${total}`).toBeNull();
      plainExpect(r.errors.length, `合計金額 ${total}`).toBeGreaterThan(0);
    }
    for (const date of ["2026-02-30", "2026/09/15", "20260915", "1900-01-01", "2100-01-01"]) {
      plainExpect(validateRow({ date, vendor: "A", total: "100" }, { today: TODAY }).normalized, `日付 ${date}`).toBeNull();
    }
    plainExpect(validateRow({ date: "2026-09-15", vendor: "あ".repeat(256), total: "100" }, { today: TODAY }).normalized).toBeNull();
  });

  plainTest("未来の日付・高額・電話番号らしい取引先は、エラーにはせず注意を出す", () => {
    const r = validateRow({ date: "2026-12-01", vendor: "03-1234-5678", total: "2000000" }, { today: TODAY });
    plainExpect(r.errors).toEqual([]);
    plainExpect(r.warnings.length).toBe(3);
    plainExpect(r.normalized).not.toBeNull();
  });

  plainTest("取引先の改行・タブ・見えない文字を取り除く。金額・日付の変換", () => {
    plainExpect(sanitizeVendor("A\r\nB\tC​D‮")).toBe("A B CD");
    plainExpect(parseAmountInput("１，２３４")).toBe(1234);
    plainExpect(parseAmountInput("")).toBeNull();
    plainExpect(parseDateInput("2026-9-5")).toBe("2026-09-05");
  });

  plainTest("日付・取引先・合計金額が同じ行は、2つ目以降を重複として知らせる（削除はしない）", () => {
    const same = { date: "2026-09-15", vendor: "A店", total: "100" };
    const ids = duplicateKeys([
      { id: "a", values: same },
      { id: "b", values: { ...same, total: "１００" } },
      { id: "c", values: { ...same, total: "200" } },
      { id: "d", values: { date: "", vendor: "A店", total: "100" } },
    ]);
    plainExpect([...ids]).toEqual(["b"]);
  });
});

plainTest.describe("receipt-accounting: CSVの内容と安全対策", () => {
  plainTest("見出しは日付・取引先・合計金額。UTF-8のBOM付き、CRLF、日付は「/」区切り、金額は整数", () => {
    plainExpect([...GENERIC_CSV_HEADER]).toEqual(["日付", "取引先", "合計金額"]);
    const csv = buildGenericCsv([{ date: "2026-09-05", vendor: "サンプル商店", total: 1320 }])!;
    plainExpect(csv.startsWith("﻿")).toBe(true);
    plainExpect(csv.replace(/^﻿/, "")).toBe("日付,取引先,合計金額\r\n2026/09/05,サンプル商店,1320");
  });

  plainTest("確認済みが0件のときは、見出しだけのCSVは作らない（null）", () => {
    plainExpect(buildGenericCsv([])).toBeNull();
  });

  plainTest("カンマ・引用符・改行を含む取引先は、CSVとして正しくエスケープされる（数式対策とは別の処理）", () => {
    const rows = buildGenericCsvRows([{ date: "2026-09-05", vendor: 'A,"B"', total: 1 }]);
    plainExpect(rows[1]).toEqual(["2026/09/05", 'A,"B"', "1"]); // 行の値は加工しない
    const csv = buildGenericCsv([{ date: "2026-09-05", vendor: 'A,"B"', total: 1 }])!.replace(/^﻿/, "");
    plainExpect(csv.split("\r\n")[1]).toBe('2026/09/05,"A,""B""",1');
  });

  plainTest("取引先が「=」「+」「-」「@」・タブ・復帰で始まるときは、数式として実行されないよう「'」を付ける。それ以外は変えない", () => {
    for (const v of ["=1+1", "+81-3", "-1", "@SUM(A1)", "\tcmd", "\rcmd"]) plainExpect(neutralizeFormula(v), JSON.stringify(v)).toBe(`'${v}`);
    for (const v of ["A=B", "株式会社", "1+1", "'=x", " =1"]) plainExpect(neutralizeFormula(v), JSON.stringify(v)).toBe(v);
    const csv = buildGenericCsv([{ date: "2026-09-05", vendor: "=HYPERLINK(\"http://x\")", total: 10 }])!.replace(/^﻿/, "");
    plainExpect(csv.split("\r\n")[1]).toBe(`2026/09/05,"'=HYPERLINK(""http://x"")",10`);
  });
});

plainTest.describe("receipt-accounting: ファイルの判定とPDFの文字情報", () => {
  plainTest("ファイルの種類は、拡張子ではなく先頭のバイトで判定する", () => {
    plainExpect(detectReceiptFileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    plainExpect(detectReceiptFileKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    plainExpect(detectReceiptFileKind(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    plainExpect(detectReceiptFileKind(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
    plainExpect(detectReceiptFileKind(new TextEncoder().encode("hello, this is text"))).toBeNull();
    plainExpect(detectReceiptFileKind(new TextEncoder().encode("ftypheic....."))).toBeNull();
    plainExpect(detectReceiptFileKind(new Uint8Array([]))).toBeNull();
  });

  plainTest("サイズの上限と、空・対応外のファイルの理由", () => {
    plainExpect(checkReceiptFile("png", 1000)).toBeNull();
    plainExpect(checkReceiptFile("png", RECEIPT_LIMITS.maxImageMB * 1024 * 1024 + 1)).toContain("大きすぎます");
    plainExpect(checkReceiptFile("pdf", RECEIPT_LIMITS.maxPdfMB * 1024 * 1024)).toBeNull();
    plainExpect(checkReceiptFile("pdf", RECEIPT_LIMITS.maxPdfMB * 1024 * 1024 + 1)).toContain("大きすぎます");
    plainExpect(checkReceiptFile("png", 0)).toContain("空");
    plainExpect(checkReceiptFile(null, 10)).toContain("対応していない");
  });

  plainTest("PDFの文字の断片を、上から下・左から右の順に、見た目の行にまとめる", () => {
    const item = (str: string, x: number, y: number, width = str.length * 10) => ({ str, x, y, width, fontHeight: 10 });
    const result = linesFromTextItems([
      item("1,320円", 200, 500),
      item("合計", 20, 500),
      item("株式会社サンプル", 20, 700),
      item("2026/09/15", 20, 600),
      item(" ", 5, 600),
    ]);
    plainExpect(result.map((l) => l.text)).toEqual(["株式会社サンプル", "2026/09/15", "合計 1,320円"]);
    plainExpect(result.every((l) => l.confidence === null)).toBe(true);
  });

  plainTest("文字情報が極端に少ない・文字化けが多いPDFは、そのまま使わずOCRに回す", () => {
    plainExpect(isTextLayerUsable(lines("あ"))).toBe(false);
    plainExpect(isTextLayerUsable(lines("����������"))).toBe(false);
    plainExpect(isTextLayerUsable(lines("株式会社サンプル商店", "合計 1,320円"))).toBe(true);
  });

  plainTest("領収書ツールのページだけ、広告枠を出さない対象として判定される", () => {
    plainExpect(isAdFreeToolPath("/tools/receipt-accounting-csv")).toBe(true);
    plainExpect(isAdFreeToolPath("/tools/receipt-accounting-csv/")).toBe(true);
    plainExpect(isAdFreeToolPath("/tools/ocr")).toBe(false);
    plainExpect(isAdFreeToolPath("/")).toBe(false);
    plainExpect(isAdFreeToolPath(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------
let dir: string;
const files: Record<string, string> = {};

const RECEIPT_TEXT = ["株式会社テスト商店", "2026年9月15日", "小計 1,200円", "消費税 120円", "合計 1,320円", "お預り 2,000円", "お釣り 680円"];
const SECRET_VENDOR = "秘密屋ユニーク商店";

async function openTool(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/tools/receipt-accounting-csv");
  await expect(page.getByTestId("receipt-tool")).toBeVisible();
}

/** 架空のレシートの画像を、ブラウザのcanvasで作って、PNGのバイト列を返す（同梱の日本語フォントで描く。バイナリのフィクスチャを置かない） */
async function renderReceiptPng(page: Page, textLines: string[]): Promise<Buffer> {
  const base64 = await page.evaluate(async (texts) => {
    const font = new FontFace("ReceiptTestFont", "url(/fonts/NotoSansJP-Regular.ttf)");
    await font.load();
    document.fonts.add(font);
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 80 + texts.length * 70;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.font = "40px ReceiptTestFont";
    texts.forEach((t, i) => ctx.fillText(t, 40, 80 + i * 70));
    return canvas.toDataURL("image/png").split(",")[1];
  }, textLines);
  return Buffer.from(base64, "base64");
}

/** 文字情報のあるPDF（1ページ＝1枚のレシート）を作る */
async function buildTextPdf(pages: string[][]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(path.join(process.cwd(), "public/fonts/NotoSansJP-Regular.ttf")), { subset: true });
  for (const texts of pages) {
    const page = pdf.addPage([300, 360]);
    texts.forEach((t, i) => page.drawText(t, { x: 20, y: 320 - i * 28, size: 14, font, color: rgb(0, 0, 0) }));
  }
  return pdf.save();
}

/** 画像だけのPDF（文字情報なし。スキャンしたPDFの代わり） */
async function buildImageOnlyPdf(png: Buffer): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(png);
  const page = pdf.addPage([image.width / 2, image.height / 2]);
  page.drawImage(image, { x: 0, y: 0, width: image.width / 2, height: image.height / 2 });
  return pdf.save();
}

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-"));
  files.textPdf = path.join(dir, "text-receipts.pdf");
  fs.writeFileSync(
    files.textPdf,
    await buildTextPdf([RECEIPT_TEXT, ["有限会社二枚目", "2026年9月20日", "合計 4,500円"]])
  );
  files.garbageJpg = path.join(dir, "broken.jpg");
  fs.writeFileSync(files.garbageJpg, Buffer.from("this is not an image at all"));
  files.fakePdf = path.join(dir, "fake.pdf");
  fs.writeFileSync(files.fakePdf, Buffer.from("plain text pretending to be a pdf"));
  files.empty = path.join(dir, "empty.png");
  fs.writeFileSync(files.empty, Buffer.alloc(0));
  files.heic = path.join(dir, "photo.heic");
  fs.writeFileSync(files.heic, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic")]));
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function makeImageFile(page: Page, name: string, textLines: string[]): Promise<string> {
  const p = path.join(dir, name);
  fs.writeFileSync(p, await renderReceiptPng(page, textLines));
  return p;
}

async function loadFiles(page: Page, paths: string[], expectedRows: number) {
  await uploadWhenReady(page, paths, page.getByTestId("receipt-row").nth(expectedRows - 1), { readyTimeoutMs: 120_000 });
  await expect(page.getByTestId("receipt-job-summary")).toContainText("読み取りは完了しています", { timeout: 120_000 });
}

async function fillRow(page: Page, index: number, v: { date?: string; vendor?: string; total?: string }) {
  const row = page.getByTestId("receipt-row").nth(index);
  if (v.date !== undefined) await row.getByTestId("receipt-date").fill(v.date);
  if (v.vendor !== undefined) await row.getByTestId("receipt-vendor").fill(v.vendor);
  if (v.total !== undefined) await row.getByTestId("receipt-total").fill(v.total);
}

function readCsv(p: string): string[] {
  return fs.readFileSync(p, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l !== "");
}

test.setTimeout(240_000);

test("receipt-accounting: 画像を読み込むとOCRで行が追加され、未確認のまま。確認済みがないとCSVは出せずに案内が出る", async ({ page }) => {
  await openTool(page);
  await expect(page.getByTestId("receipt-empty")).toBeVisible();
  await expect(page.getByTestId("receipt-export-empty")).toBeVisible();
  const img = await makeImageFile(page, "receipt1.png", RECEIPT_TEXT);
  await loadFiles(page, [img], 1);

  const row = page.getByTestId("receipt-row").first();
  await expect(row).toHaveAttribute("data-method", "ocr");
  await expect(row).toHaveAttribute("data-confirmed", "false");
  await expect(row.getByTestId("receipt-status")).toHaveText("未確認");
  await expect(row.getByTestId("receipt-label")).toHaveText("receipt1.png");
  await expect(row.getByTestId("receipt-preview")).toBeVisible();
  await expect(page.getByTestId("receipt-summary")).toContainText("書類 1件：確認済み 0件／未確認 1件");
  await expect(page.getByTestId("receipt-raw-text")).toBeAttached();

  // 確認済みが0件：案内を出し、ダウンロードはできない
  await expect(page.getByTestId("receipt-export-empty")).toContainText("確認済みのデータがありません");
  await expect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();
});

test("receipt-accounting: 値を入れて確認済みにした行だけがCSVに出る。未確認の行・取引先の特殊文字・数式対策を確かめる", async ({ page }) => {
  await openTool(page);
  const a = await makeImageFile(page, "a.png", ["A"]);
  const b = await makeImageFile(page, "b.png", ["B"]);
  const c = await makeImageFile(page, "c.png", ["C"]);
  await loadFiles(page, [a, b, c], 3);

  await fillRow(page, 0, { date: "2026-09-15", vendor: "株式会社テスト商店", total: "1,320" });
  await fillRow(page, 1, { date: "2026-09-16", vendor: '=SUM(A1:A2)', total: "500" });
  await fillRow(page, 2, { date: "2026-09-17", vendor: 'カンマ,引用"符"店', total: "２,０００円" });

  // 確認済みにしたのは0行目と1行目だけ。2行目は未確認のまま
  const rows = page.getByTestId("receipt-row");
  await rows.nth(0).getByTestId("receipt-confirm").click();
  await rows.nth(1).getByTestId("receipt-confirm").click();
  await expect(rows.nth(0)).toHaveAttribute("data-confirmed", "true");
  await expect(rows.nth(1)).toHaveAttribute("data-confirmed", "true");
  await expect(rows.nth(2)).toHaveAttribute("data-confirmed", "false");
  await expect(page.getByTestId("receipt-summary")).toContainText("確認済み 2件／未確認 1件");
  await expect(page.getByTestId("receipt-export-count")).toContainText("出力される書類：2件");
  await expect(page.getByTestId("receipt-formula-note")).toContainText("1件");
  const preview = page.getByTestId("receipt-export-preview");
  await expect(preview).toContainText("2026/09/15");
  await expect(preview).toContainText("株式会社テスト商店");
  await expect(preview).not.toContainText("カンマ");

  const download = await clickAndDownload(page, "CSVをダウンロード");
  expect(download.suggestedFilename()).toMatch(/^receipts-\d{8}\.csv$/);
  const { path: csvPath } = await assertDownloadedFile(download, { minBytes: 20 });
  const raw = fs.readFileSync(csvPath);
  expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8のBOM
  expect(readCsv(csvPath)).toEqual(["日付,取引先,合計金額", "2026/09/15,株式会社テスト商店,1320", "2026/09/16,'=SUM(A1:A2),500"]);

  // 未確認だった行を確認済みにすると、特殊文字がCSVの書式どおりにエスケープされる
  await rows.nth(2).getByTestId("receipt-confirm").click();
  const download2 = await clickAndDownload(page, "CSVをダウンロード");
  const { path: csvPath2 } = await assertDownloadedFile(download2, { minBytes: 20 });
  expect(readCsv(csvPath2).slice(-1)[0]).toBe('2026/09/17,"カンマ,引用""符""店",2000');
});

test("receipt-accounting: 不備のある行は確認済みにできない。値を直すと確認済みが外れ、直し直すまで出力されない", async ({ page }) => {
  await openTool(page);
  const img = await makeImageFile(page, "x.png", ["X"]);
  await loadFiles(page, [img], 1);
  const row = page.getByTestId("receipt-row").first();

  // 日付・取引先・合計金額が空のまま確認済みにしようとする
  await row.getByTestId("receipt-confirm").click();
  await expect(row.getByTestId("receipt-row-errors")).toBeVisible();
  await expect(row.getByTestId("receipt-row-errors")).toContainText("日付が入力されていません");
  await expect(row.getByTestId("receipt-row-errors")).toContainText("取引先が入力されていません");
  await expect(row.getByTestId("receipt-row-errors")).toContainText("合計金額が入力されていません");
  await expect(row).toHaveAttribute("data-confirmed", "false");
  await expect(page.getByTestId("receipt-export-empty")).toBeVisible();

  // 合計金額が不正（0円・小数）
  await fillRow(page, 0, { date: "2026-09-15", vendor: "テスト店", total: "0" });
  await row.getByTestId("receipt-confirm").click();
  await expect(row.getByTestId("receipt-row-errors")).toContainText("合計金額が正しくありません");
  await row.getByTestId("receipt-total").fill("12.5");
  await row.getByTestId("receipt-confirm").click();
  await expect(row).toHaveAttribute("data-confirmed", "false");

  // 正しい値にして確認済みにする → 値を変えると確認済みが外れる
  await row.getByTestId("receipt-total").fill("800");
  await row.getByTestId("receipt-confirm").click();
  await expect(row).toHaveAttribute("data-confirmed", "true");
  await expect(page.getByTestId("receipt-export-count")).toContainText("出力される書類：1件");
  await row.getByTestId("receipt-total").fill("900");
  await expect(row).toHaveAttribute("data-confirmed", "false");
  await expect(page.getByTestId("receipt-export-count")).toContainText("出力される書類：0件");
  await expect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();
  await expect(row.getByTestId("receipt-source-total")).toHaveText("入力・修正済み");

  // 確認済みの取り消し
  await row.getByTestId("receipt-confirm").click();
  await expect(row).toHaveAttribute("data-confirmed", "true");
  await row.getByTestId("receipt-confirm").click();
  await expect(row).toHaveAttribute("data-confirmed", "false");
});

test("receipt-accounting: 文字情報のあるPDFは、ページごとに1行になり、文字情報から値が入る（確認済みにはならない）。候補・削除・全消去も動く", async ({ page }) => {
  await openTool(page);
  await loadFiles(page, [files.textPdf], 2);
  const rows = page.getByTestId("receipt-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-method", "text-layer");
  await expect(rows.nth(0).getByTestId("receipt-label")).toContainText("text-receipts.pdf（1/2ページ）");
  await expect(rows.nth(1).getByTestId("receipt-label")).toContainText("（2/2ページ）");
  await expect(rows.nth(0).getByTestId("receipt-date")).toHaveValue("2026-09-15");
  await expect(rows.nth(0).getByTestId("receipt-total")).toHaveValue("1320");
  await expect(rows.nth(0).getByTestId("receipt-vendor")).toHaveValue("株式会社テスト商店");
  await expect(rows.nth(0).getByTestId("receipt-source-total")).toHaveText("自動読み取り");
  await expect(rows.nth(1).getByTestId("receipt-total")).toHaveValue("4500");
  await expect(rows.nth(0)).toHaveAttribute("data-confirmed", "false");
  await expect(page.getByTestId("receipt-export-empty")).toBeVisible(); // 自動で確認済みにはならない

  // 候補（お預り・小計などは候補に出ない）から別の金額を選べる
  const candidates = rows.nth(0).getByTestId("receipt-candidates-total");
  if (await candidates.count()) {
    await expect(candidates).not.toContainText("2,000");
    await expect(candidates).not.toContainText("680");
  }

  // 1行を削除すると、件数が減る
  await rows.nth(0).getByTestId("receipt-delete").click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("receipt-summary")).toContainText("書類 1件");

  // すべて消去は、確認の2回押しが必要
  await page.getByTestId("receipt-reset").click();
  await expect(rows).toHaveCount(1);
  await page.getByTestId("receipt-reset").click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId("receipt-empty")).toBeVisible();
});

test("receipt-accounting: 画像だけのPDFはOCRで読み取る。壊れたファイル・対応外・空のファイルは、それぞれ個別にエラーになり、ほかのファイルの処理は続く", async ({ page }) => {
  await openTool(page);
  const good = await makeImageFile(page, "good.png", RECEIPT_TEXT);
  const imagePdf = path.join(dir, "scan.pdf");
  fs.writeFileSync(imagePdf, await buildImageOnlyPdf(fs.readFileSync(good)));

  await loadFiles(page, [files.garbageJpg, files.fakePdf, files.empty, files.heic, good, imagePdf], 2);

  const rows = page.getByTestId("receipt-row");
  await expect(rows).toHaveCount(2); // good.png と scan.pdf だけ
  await expect(rows.nth(0)).toHaveAttribute("data-method", "ocr");
  await expect(rows.nth(1)).toHaveAttribute("data-method", "ocr");
  await expect(rows.nth(1).getByTestId("receipt-label")).toContainText("scan.pdf");

  const errors = page.locator('[data-testid="receipt-job"][data-status="error"]');
  await expect(errors).toHaveCount(4);
  await expect(errors.filter({ hasText: "broken.jpg" })).toContainText("対応していない形式、またはファイルが壊れています");
  await expect(errors.filter({ hasText: "fake.pdf" })).toContainText("対応していない形式、またはファイルが壊れています");
  await expect(errors.filter({ hasText: "empty.png" })).toContainText("空のファイルです");
  await expect(errors.filter({ hasText: "photo.heic" })).toContainText("HEIC");
  // エラー文に、ファイルの中身は出ない
  await expect(page.getByTestId("receipt-jobs")).not.toContainText("this is not an image");

  // エラー表示は閉じられる
  await errors.first().getByRole("button", { name: "閉じる" }).click();
  await expect(errors).toHaveCount(3);
});

test("receipt-accounting: 読み込んだファイル名・読み取った内容・入力した取引先は、外部にも自社APIにも送信されない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  const img = await makeImageFile(page, "secret-file-name-xyz.png", [SECRET_VENDOR, "2026年9月15日", "合計 7,777円"]);
  await loadFiles(page, [img, files.textPdf], 3);
  await fillRow(page, 0, { date: "2026-09-15", vendor: SECRET_VENDOR, total: "7777" });
  await page.getByTestId("receipt-row").nth(0).getByTestId("receipt-confirm").click();
  const download = await clickAndDownload(page, "CSVをダウンロード");
  const { path: csvPath } = await assertDownloadedFile(download, { minBytes: 20 });
  expect(readCsv(csvPath)[1]).toBe(`2026/09/15,${SECRET_VENDOR},7777`);

  const origin = new URL(baseURL!).origin;
  for (const needle of [SECRET_VENDOR, "secret-file-name-xyz", "7777", "text-receipts", "株式会社テスト商店", "有限会社二枚目"]) {
    expect(findLeakedRequests(recorder, needle), needle).toEqual([]);
  }
  expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
  // 画像・PDFそのものも、POST/PUTでは送られていない
  const uploads = recorder.requests.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method) && r.bodySize > 20_000);
  expect(uploads.map((r) => `${r.method} ${r.url}`)).toEqual([]);
});

plainTest("receipt-accounting: このツールのページには広告枠が出ない（ほかのツールには出る）", async ({ page }) => {
  await page.goto("/tools/receipt-accounting-csv");
  await plainExpect(page.getByTestId("receipt-tool")).toBeVisible();
  await plainExpect(page.getByText("ツール内広告")).toHaveCount(0);
  await plainExpect(page.getByText("フッター広告")).toHaveCount(0);
  // 比較：広告のあるツール（開発・テストでは枠が表示される）
  await page.goto("/tools/char-count");
  await plainExpect(page.getByText("ツール内広告").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. PDFの異常系・上限（工程9）
// ---------------------------------------------------------------------------
/** 内容のない（空白の）ページだけのPDF */
async function buildBlankPdf(pageCount: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) pdf.addPage([300, 360]);
  return pdf.save();
}

/** 文字情報のあるPDF（ページ数を指定。各ページに、ページごとに違う架空の店名・日付・合計を入れる） */
async function buildTextPdfPages(pageCount: number, label: string): Promise<Uint8Array> {
  const pages: string[][] = [];
  for (let i = 1; i <= pageCount; i++) {
    pages.push([`${label}${i}号店`, `2026年9月${(i % 27) + 1}日`, `合計 ${(1000 + i * 10).toLocaleString("en-US")}円`]);
  }
  return buildTextPdf(pages);
}

test("receipt-accounting: パスワード付きPDF・壊れたPDF・21ページのPDFは、それぞれ理由つきのエラーになり、ほかのファイルは読み込まれる", async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 360]);
  const encrypted = await encryptPdfDocument(doc, { userPassword: "pw-test-1234", permissions: { print: true, copy: true, modify: true } });
  const encryptedPath = path.join(dir, "locked.pdf");
  fs.writeFileSync(encryptedPath, encrypted);
  const brokenPath = path.join(dir, "truncated.pdf");
  fs.writeFileSync(brokenPath, Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n(途中で切れたPDF)"));
  const tooManyPath = path.join(dir, "twenty-one-pages.pdf");
  fs.writeFileSync(tooManyPath, await buildBlankPdf(21));

  await openTool(page);
  await loadFiles(page, [encryptedPath, brokenPath, tooManyPath, files.textPdf], 2);

  const errors = page.locator('[data-testid="receipt-job"][data-status="error"]');
  await expect(errors).toHaveCount(3);
  await expect(errors.filter({ hasText: "locked.pdf" })).toContainText("パスワード保護されたPDFは処理できません");
  await expect(errors.filter({ hasText: "truncated.pdf" })).toContainText("PDFを開けませんでした");
  await expect(errors.filter({ hasText: "twenty-one-pages.pdf" })).toContainText("20ページまで");
  await expect(errors.filter({ hasText: "twenty-one-pages.pdf" })).toContainText("21ページ");
  // 読み込めたのは、文字情報のあるPDFの2ページだけ
  await expect(page.getByTestId("receipt-row")).toHaveCount(2);
  // エラー文に、パスワードやファイルの中身は出ない
  await expect(page.getByTestId("receipt-jobs")).not.toContainText("pw-test-1234");
  await expect(page.getByTestId("receipt-jobs")).not.toContainText("途中で切れたPDF");
});

test("receipt-accounting: ちょうど20ページのPDFは、20行になる（上限の境界）", async ({ page }) => {
  const p = path.join(dir, "twenty-pages.pdf");
  fs.writeFileSync(p, await buildTextPdfPages(20, "境界"));
  await openTool(page);
  await loadFiles(page, [p], 20);
  await expect(page.getByTestId("receipt-row")).toHaveCount(20);
  await expect(page.getByTestId("receipt-summary")).toContainText("書類 20件");
  await expect(page.getByTestId("receipt-row").nth(19).getByTestId("receipt-label")).toContainText("（20/20ページ）");
  await expect(page.getByTestId("receipt-row").nth(19).getByTestId("receipt-total")).toHaveValue("1200");
});

test("receipt-accounting: 空白のページ・文字情報と画像が混在するPDFでも止まらず、空欄のまま確認できる", async ({ page }) => {
  await openTool(page);
  const blankPath = path.join(dir, "blank.pdf");
  fs.writeFileSync(blankPath, await buildBlankPdf(2));
  const png = await renderReceiptPng(page, RECEIPT_TEXT);
  const mixed = await PDFDocument.create();
  mixed.registerFontkit(fontkit);
  const font = await mixed.embedFont(fs.readFileSync(path.join(process.cwd(), "public/fonts/NotoSansJP-Regular.ttf")), { subset: true });
  const textPage = mixed.addPage([300, 360]);
  ["株式会社混在商店", "2026年9月8日", "合計 2,222円"].forEach((t, i) => textPage.drawText(t, { x: 20, y: 320 - i * 28, size: 14, font }));
  const image = await mixed.embedPng(png);
  const imagePage = mixed.addPage([image.width / 2, image.height / 2]);
  imagePage.drawImage(image, { x: 0, y: 0, width: image.width / 2, height: image.height / 2 });
  const mixedPath = path.join(dir, "mixed.pdf");
  fs.writeFileSync(mixedPath, await mixed.save());

  await loadFiles(page, [blankPath, mixedPath], 4);
  const rows = page.getByTestId("receipt-row");
  await expect(rows).toHaveCount(4);
  // 空白ページ：値は空で、確認済みにはできない
  await expect(rows.nth(0).getByTestId("receipt-total")).toHaveValue("");
  await expect(rows.nth(0).getByTestId("receipt-raw-text")).toContainText("文字を読み取れませんでした");
  await rows.nth(0).getByTestId("receipt-confirm").click();
  await expect(rows.nth(0)).toHaveAttribute("data-confirmed", "false");
  await expect(rows.nth(0).getByTestId("receipt-row-errors")).toBeVisible();
  // 混在：1ページ目は文字情報、2ページ目（画像）はOCR
  await expect(rows.nth(2)).toHaveAttribute("data-method", "text-layer");
  await expect(rows.nth(2).getByTestId("receipt-total")).toHaveValue("2222");
  await expect(rows.nth(3)).toHaveAttribute("data-method", "ocr");
});

test("receipt-accounting: 大きすぎる画像・PDFは、中身を読まずにサイズのエラーにする。31ファイル以上は追加を30ファイルまでにする", async ({ page }) => {
  const bigPdf = path.join(dir, "big.pdf");
  fs.writeFileSync(bigPdf, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(RECEIPT_LIMITS.maxPdfMB * 1024 * 1024)]));
  const bigPng = path.join(dir, "big.png");
  fs.writeFileSync(bigPng, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(RECEIPT_LIMITS.maxImageMB * 1024 * 1024)]));
  await openTool(page);
  await uploadWhenReady(page, [bigPdf, bigPng], page.getByTestId("receipt-job").nth(1), { readyTimeoutMs: 60_000 });
  const errors = page.locator('[data-testid="receipt-job"][data-status="error"]');
  await expect(errors).toHaveCount(2);
  await expect(errors.filter({ hasText: "big.pdf" })).toContainText(`PDFは1つ${RECEIPT_LIMITS.maxPdfMB}MBまで`);
  await expect(errors.filter({ hasText: "big.png" })).toContainText(`画像は1つ${RECEIPT_LIMITS.maxImageMB}MBまで`);
  await expect(page.getByTestId("receipt-row")).toHaveCount(0);

  // 31ファイル：先頭の30ファイルだけを受け付け、残りは追加していないと知らせる
  const many: string[] = [];
  for (let i = 0; i < RECEIPT_LIMITS.maxFilesPerAdd + 1; i++) {
    const p = path.join(dir, `junk-${i}.jpg`);
    fs.writeFileSync(p, Buffer.from(`not an image ${i}`));
    many.push(p);
  }
  await uploadFixture(page, many);
  await expect(page.getByTestId("receipt-notice")).toContainText(`一度に追加できるのは${RECEIPT_LIMITS.maxFilesPerAdd}ファイルまで`);
  // 先に並んでいるサイズのエラー2件に、受け付けた30ファイル分のエラーが加わる（31個目は追加されない）
  await expect(page.locator('[data-testid="receipt-job"][data-status="error"]')).toHaveCount(2 + RECEIPT_LIMITS.maxFilesPerAdd);
  await expect(page.locator('[data-testid="receipt-job"]').filter({ hasText: `junk-${RECEIPT_LIMITS.maxFilesPerAdd}.jpg` })).toHaveCount(0);
});

test("receipt-accounting: 画面に並べられる書類が60件に達したら、以降の追加は件数の上限のエラーになり、既存の行は残る", async ({ page }) => {
  const p20 = path.join(dir, "limit-20.pdf");
  fs.writeFileSync(p20, await buildTextPdfPages(20, "上限"));
  await openTool(page);
  await loadFiles(page, [p20, p20, p20], 60);
  await expect(page.getByTestId("receipt-summary")).toContainText("書類 60件");
  const before = await page.getByTestId("receipt-row").count();
  await uploadFixture(page, [files.textPdf]);
  const limitError = page.locator('[data-testid="receipt-job"][data-status="error"]').filter({ hasText: "60件まで" });
  await expect(limitError).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("receipt-row")).toHaveCount(before);
});

test("receipt-accounting: スマートフォンの幅（390px）でも、横にはみ出さず、確認・出力の操作ができる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/receipt-accounting-csv");
  await expect(page.getByTestId("receipt-tool")).toBeVisible();
  await loadFiles(page, [files.textPdf], 2);
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(1);
  const row = page.getByTestId("receipt-row").first();
  await row.getByTestId("receipt-confirm").scrollIntoViewIfNeeded();
  const box = await row.getByTestId("receipt-confirm").boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
  await row.getByTestId("receipt-confirm").click();
  await expect(row).toHaveAttribute("data-confirmed", "true");
  const download = await clickAndDownload(page, "CSVをダウンロード");
  const { path: csvPath } = await assertDownloadedFile(download, { minBytes: 20 });
  expect(readCsv(csvPath)).toEqual(["日付,取引先,合計金額", "2026/09/15,株式会社テスト商店,1320"]);
  expect(await overflow()).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// 3-2. freee会計向けCSV（工程10）
// ---------------------------------------------------------------------------
const FREEE_HEADER_LINE =
  "収支区分,管理番号,発生日,決済期日,取引先コード,取引先,勘定科目,税区分,金額,税計算区分,税額,備考,品目,部門,メモタグ（複数指定可、カンマ区切り）,セグメント1,セグメント2,セグメント3,決済日,決済口座,決済金額";

test("receipt-accounting: 出力形式を選べる。freee向けCSVは必要項目を入力するまで出力できず、不足項目と直し方が出る。形式を切り替えても入力は消えない", async ({ page }) => {
  await openTool(page);
  const a = await makeImageFile(page, "fa.png", ["A"]);
  const b = await makeImageFile(page, "fb.png", ["B"]);
  const c = await makeImageFile(page, "fc.png", ["C"]);
  await loadFiles(page, [a, b, c], 3);
  await fillRow(page, 0, { date: "2026-09-15", vendor: "株式会社テスト商店", total: "1,320" });
  await fillRow(page, 1, { date: "2026-09-16", vendor: "=SUM(A1:A2)", total: "500" });
  await fillRow(page, 2, { date: "2026-09-17", vendor: 'カンマ,引用"符"店', total: "2000" });
  const rows = page.getByTestId("receipt-row");
  await rows.nth(0).getByTestId("receipt-confirm").click();
  await rows.nth(1).getByTestId("receipt-confirm").click(); // 2行目（c）は未確認のまま

  // 既定は汎用CSV（従来どおり）
  await expect(page.getByTestId("receipt-format-generic")).toBeChecked();
  await expect(page.getByTestId("receipt-export-preview")).toBeVisible();
  await expect(page.getByTestId("freee-settings")).toHaveCount(0);

  // freee向けに切り替える：説明が出て、必要な入力が足りないので出力できない
  await page.getByTestId("receipt-format-freee").check();
  await expect(page.getByTestId("freee-explain")).toContainText("取引データのインポート");
  await expect(page.getByTestId("freee-explain")).toContainText("保証するものではありません");
  await expect(page.getByTestId("freee-explain")).toContainText("推測しません");
  await expect(page.getByTestId("freee-direction")).toHaveValue(""); // 初期値は空（推測して入れない）
  await expect(page.getByTestId("freee-payment-mode")).toHaveValue("");
  await expect(page.getByTestId("freee-account")).toHaveValue("");
  await expect(page.getByTestId("freee-tax")).toHaveValue("");
  await expect(page.getByTestId("freee-problems")).toContainText("収支区分を選んでください");
  await expect(page.getByTestId("freee-problems")).toContainText("支払い状況を選んでください");
  await expect(page.getByTestId("freee-blocked-note")).toContainText("まだ出力できません");
  await expect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();
  const freeeRows = page.getByTestId("freee-row");
  await expect(freeeRows).toHaveCount(2); // 確認済みの2行だけ（未確認の行は出ない）
  await expect(freeeRows.nth(0)).toHaveAttribute("data-valid", "false");
  // 取引先が「=」で始まる行にだけ、「'」を付けて出力する旨が出る
  await expect(freeeRows.nth(1).getByTestId("freee-row-formula-note")).toContainText("先頭に");
  await expect(freeeRows.nth(0).getByTestId("freee-row-formula-note")).toHaveCount(0);
  await expect(freeeRows.nth(0).getByTestId("freee-row-errors")).toContainText("勘定科目が入力されていません");
  await expect(freeeRows.nth(0).getByTestId("freee-row-errors")).toContainText("税区分が入力されていません");

  // 収支区分・支払い状況（未決済）を選んでも、勘定科目・税区分が空なら出力できない
  await page.getByTestId("freee-direction").selectOption("支出");
  await page.getByTestId("freee-payment-mode").selectOption("unpaid");
  await expect(page.getByTestId("freee-problems")).toHaveCount(0);
  await expect(page.getByTestId("freee-blocked-note")).toContainText("勘定科目・税区分が決まっていない行が2件");
  await expect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();

  // 勘定科目の先頭が数式になりうる文字のときは、理由つきのエラー
  await page.getByTestId("freee-account").fill("=消耗品費");
  await expect(freeeRows.nth(0).getByTestId("freee-row-errors")).toContainText("勘定科目の先頭に");
  await page.getByTestId("freee-account").fill("消耗品費");
  await page.getByTestId("freee-tax").fill("課対仕入10%");
  await expect(freeeRows.nth(0)).toHaveAttribute("data-valid", "true");
  await expect(page.getByTestId("freee-blocked-note")).toHaveCount(0);

  // 行ごとの上書き
  await freeeRows.nth(1).getByTestId("freee-row-account").fill("会議費");

  // 汎用CSVへ戻しても、freeeの入力は残る。汎用CSVは従来どおり
  await page.getByTestId("receipt-format-generic").check();
  await expect(page.getByTestId("receipt-export-preview")).toContainText("株式会社テスト商店");
  const generic = await clickAndDownload(page, "CSVをダウンロード");
  expect(generic.suggestedFilename()).toMatch(/^receipts-\d{8}\.csv$/);
  const { path: genericPath } = await assertDownloadedFile(generic, { minBytes: 20 });
  expect(readCsv(genericPath)).toEqual(["日付,取引先,合計金額", "2026/09/15,株式会社テスト商店,1320", "2026/09/16,'=SUM(A1:A2),500"]);
  await page.getByTestId("receipt-format-freee").check();
  await expect(page.getByTestId("freee-direction")).toHaveValue("支出");
  await expect(page.getByTestId("freee-account")).toHaveValue("消耗品費");
  await expect(page.getByTestId("freee-tax")).toHaveValue("課対仕入10%");
  await expect(freeeRows.nth(1).getByTestId("freee-row-account")).toHaveValue("会議費");

  // 出力：公式サンプルと同じ見出し・列順。確認済みの2行だけ。未決済なので決済の3列は空
  const freee = await clickAndDownload(page, "CSVをダウンロード");
  expect(freee.suggestedFilename()).toMatch(/^receipts-freee-\d{8}\.csv$/);
  const { path: freeePath } = await assertDownloadedFile(freee, { minBytes: 100 });
  const raw = fs.readFileSync(freeePath);
  expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
  const text = raw.toString("utf8").replace(/^\ufeff/, "");
  expect(text.endsWith("\n")).toBe(false);
  expect(text.split("\r\n")).toEqual([
    FREEE_HEADER_LINE,
    "支出,,2026/09/15,,,株式会社テスト商店,消耗品費,課対仕入10%,1320,,,,,,,,,,,,",
    "支出,,2026/09/16,,,'=SUM(A1:A2),会議費,課対仕入10%,500,,,,,,,,,,,,",
  ]);

  // 未確認だった行を確認済みにすると、引用符・カンマを含む取引先が、CSVの書式どおりに出る
  await rows.nth(2).getByTestId("receipt-confirm").click();
  await expect(freeeRows).toHaveCount(3);
  await page.getByTestId("freee-payment-mode").selectOption("paid");
  await expect(page.getByTestId("freee-problems")).toContainText("決済口座が入力されていません");
  await expect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();
  await page.getByTestId("freee-payment-account").fill("現金");
  const freee2 = await clickAndDownload(page, "CSVをダウンロード");
  const { path: freeePath2 } = await assertDownloadedFile(freee2, { minBytes: 100 });
  const lines2 = fs.readFileSync(freeePath2, "utf8").replace(/^\ufeff/, "").split("\r\n");
  expect(lines2).toHaveLength(4);
  expect(lines2[1]).toBe("支出,,2026/09/15,,,株式会社テスト商店,消耗品費,課対仕入10%,1320,,,,,,,,,,2026/09/15,現金,1320");
  expect(lines2[3]).toBe('支出,,2026/09/17,,,"カンマ,引用""符""店",消耗品費,課対仕入10%,2000,,,,,,,,,,2026/09/17,現金,2000');

  // 確認済みを外して0件になると、freee向けでも出力できない
  await page.getByRole("button", { name: "確認済みをすべて外す" }).click();
  await expect(page.getByTestId("receipt-export-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();
});

test("receipt-accounting: スマートフォンの幅（390px）でも、freee向けCSVの入力欄が横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/receipt-accounting-csv");
  await expect(page.getByTestId("receipt-tool")).toBeVisible();
  await loadFiles(page, [files.textPdf], 2);
  await page.getByTestId("receipt-row").first().getByTestId("receipt-confirm").click();
  await page.getByTestId("receipt-format-freee").check();
  await page.getByTestId("freee-payment-mode").selectOption("paid");
  const overflow = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await expect(page.getByTestId("freee-row")).toHaveCount(1);
  await page.getByTestId("freee-account").scrollIntoViewIfNeeded();
  expect(await overflow()).toBeLessThanOrEqual(1);
  for (const id of ["freee-direction", "freee-payment-mode", "freee-payment-account", "freee-account", "freee-tax"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390, id).toBeTruthy();
  }
  const rowBox = await page.getByTestId("freee-row-account").boundingBox();
  expect(rowBox && rowBox.x >= 0 && rowBox.x + rowBox.width <= 390).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 4. 広告（工程9）：このツールでは、ダウンロード時の広告確認も出さない
// ---------------------------------------------------------------------------
plainTest("receipt-accounting: 無料プランでも、CSVのダウンロード前に広告の確認画面を出さない", async ({ page, context }) => {
  plainTest.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  const pdfPath = path.join(dir, "ad-free-check.pdf");
  fs.writeFileSync(pdfPath, await buildTextPdf([RECEIPT_TEXT]));
  await page.goto("/tools/receipt-accounting-csv");
  await plainExpect(page.getByTestId("receipt-tool")).toBeVisible();
  await plainExpect(page.getByTestId("download-ad-notice")).toHaveCount(0);
  await uploadWhenReady(page, pdfPath, page.getByTestId("receipt-row").first(), { readyTimeoutMs: 60_000 });
  await plainExpect(page.getByTestId("receipt-row")).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId("receipt-confirm").click();
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "CSVをダウンロード" }).click();
  const download = await downloadPromise;
  plainExpect(download.suggestedFilename()).toMatch(/\.csv$/);
  await plainExpect(page.getByTestId("download-gate-dialog")).toHaveCount(0);
  void context;
});

plainTest("receipt-accounting: 無料プランでも、freee向けCSVのダウンロード前に広告の確認画面を出さない（入力不足の間は出力できない）", async ({ page }) => {
  plainTest.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  const pdfPath = path.join(dir, "ad-free-check-freee.pdf");
  fs.writeFileSync(pdfPath, await buildTextPdf([RECEIPT_TEXT]));
  await page.goto("/tools/receipt-accounting-csv");
  await plainExpect(page.getByTestId("receipt-tool")).toBeVisible();
  await uploadWhenReady(page, pdfPath, page.getByTestId("receipt-row").first(), { readyTimeoutMs: 60_000 });
  await plainExpect(page.getByTestId("receipt-row")).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId("receipt-confirm").click();
  await page.getByTestId("receipt-format-freee").check();
  await plainExpect(page.getByRole("button", { name: "CSVをダウンロード" })).toBeDisabled();
  await page.getByTestId("freee-direction").selectOption("支出");
  await page.getByTestId("freee-payment-mode").selectOption("unpaid");
  await page.getByTestId("freee-account").fill("消耗品費");
  await page.getByTestId("freee-tax").fill("課対仕入10%");
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "CSVをダウンロード" }).click();
  const download = await downloadPromise;
  plainExpect(download.suggestedFilename()).toMatch(/^receipts-freee-\d{8}\.csv$/);
  await plainExpect(page.getByTestId("download-gate-dialog")).toHaveCount(0);
});
