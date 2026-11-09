import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { effectiveRequiredPlan, getListedTools, getToolById, tools } from "@/lib/tools/data";
import { canUsePremiumFeature } from "@/lib/plans/premium-feature";
import { toolSeoContent } from "@/lib/seo/tool-content";
import { TOOL_HANDOFF } from "@/lib/handoff/config";
import { searchTools } from "@/lib/tools/search";
import { pageTextFromItems, type PageTextItem } from "@/lib/pdf/page-text";
import { classifyPage, formatPageText, combinePages, type OcrPageResult } from "@/lib/processors/browser/ocr";
import { detectTextColumns } from "@/lib/pdf/text-columns";
import { parseCellValue, parseDateText, toExcelWriteCell } from "@/lib/pdf/cell-value";
import { widgetsToTextItems, FORM_CHECKED_MARK, FORM_UNCHECKED_MARK } from "@/lib/pdf/form-fields";
import { buildFormDataTable, formDataCellToString, guessHeaderRowIndex, parsePastedTable, parseTsv } from "@/lib/forms/data-source";
import { dedupeFileNamesIgnoreCase } from "@/lib/processors/browser/form-to-individual-pdfs";
import {
  checkReceiptDetails,
  expectedInclusiveTax,
  extractItems,
  extractReceiptDetails,
  extractRegistrationNumber,
  extractTaxAmount,
  extractTaxRate,
  EMPTY_RECEIPT_DETAILS,
} from "@/lib/accounting/receipt-details";
import { buildJournalCsvRows, buildJournalXlsxRows, JOURNAL_HEADER } from "@/lib/accounting/journal-export";
import { clampMoveDelta, displayToPageMatrix } from "@/lib/pdf-annotate/geometry";
import {
  computeAutoExportScale,
  computeFitCanvas,
  findOverflowingItems,
  rotatedItemBounds,
  wrapTextLines,
  type ImageLayoutItem,
} from "@/lib/processors/browser/image-layout";
import { BLACKOUT_COLOR, BLACKOUT_NOTICE, isBlackoutObject, isWhiteoutObject, WHITEOUT_COLOR } from "@/lib/pdf-annotate/whiteout";
import type { AnnotationObject } from "@/lib/pdf-annotate/types";
import { uploadFixture, clickAndDownload, closeResultPopup, waitForSuccess, assertDownloadedFile } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";
import { setDevPlanOverride } from "../helpers/dev-plan";
import { scratchDir } from "../helpers/tmp";
import { fixtures } from "../fixtures/paths";

/**
 * 工程4（既存ツールの改善）のテスト。
 *  4-1 画像ホワイトボード（旧 画像レイアウト）：はみ出しの確認・キャンバスを広げる・書き出しの解像度・表示と書き出しの一致
 *  4-2 PDF修正：置いたものをどのモードでも動かせる・ページの外へ出ない・つまみで大きさ・枠なしのチェック・
 *      黒塗り（見た目だけ）と墨消し（PDF黒塗り・墨消し）の区別・回転したページでの位置
 *  4-3 PDF→テキスト（OCR対応）：OCRの統合・ページごとの読み取り方・改行と段落・ページの区切り・旧URL
 *  4-4 電子印鑑：複数ページ押印（プレミアム）。スタンダードは1ページのまま
 *  4-5 PDF差し込み印刷：データソースの拡張（貼り付け・見出しの行・シート）・結果の一覧
 *  4-6 記入済みPDF→Excel：入力フォームの値・チェックボックス・金額/マイナス/日付の型
 *  4-7 PDF→Word：段組み（2段）の読む順番とWordの段組み
 *  4-8 領収書・レシート：税率・税額・登録番号・品目の読み取り、税区分・勘定科目の入力、明細CSV/Excel、金額と税額の不一致
 */

const FONT_PATH = path.join(process.cwd(), "public/fonts/NotoSansJP-Regular.ttf");

function py(script: string, args: string[] = []): string {
  return execFileSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** openpyxl は拡張子で形式を判断するため、ダウンロードしたファイルを .xlsx の名前で写してから読む */
function asXlsx(file: string): string {
  const copy = path.join(scratchDir("step4-xlsx"), "book.xlsx");
  fs.copyFileSync(file, copy);
  return copy;
}

function item(str: string, x: number, y: number, width: number, fontHeight = 10, hasEOL = false): PageTextItem & { height: number } {
  return { str, x, y, width, height: fontHeight, fontHeight, hasEOL };
}

// ===========================================================================
// 1. 登録・SEO・検索・URL（ブラウザ不要）
// ===========================================================================
plainTest("4-3: OCRは一覧・登録・SEO・受け渡しから消え、PDF→テキスト（OCR対応）にまとまっている", () => {
  plainExpect(getToolById("ocr")).toBeUndefined();
  plainExpect((toolSeoContent as Record<string, unknown>).ocr).toBeUndefined();
  plainExpect((TOOL_HANDOFF as Record<string, unknown>).ocr).toBeUndefined();
  plainExpect(tools.some((t) => (t.relatedToolIds ?? []).includes("ocr"))).toBe(false);
  const hub = getToolById("pdf-to-text")!;
  plainExpect(hub.name).toBe("PDF→テキスト（OCR対応）");
  plainExpect(hub.keywords).toEqual(expect.arrayContaining(["OCR", "文字認識", "スキャン"]));
  plainExpect(TOOL_HANDOFF["pdf-to-text"]?.receive?.kinds).toEqual(expect.arrayContaining(["pdf", "png", "jpeg", "webp"]));
  plainExpect(searchTools(getListedTools(), "OCR").map((t) => t.id)).toContain("pdf-to-text");
  plainExpect(toolSeoContent["pdf-to-text"].faq.map((f) => f.question)).toContain("文字のページとスキャンしたページが混ざったPDFはどうなりますか？");
});

plainTest("4-1: 画像レイアウトは「画像ホワイトボード」になり、URL（image-layout）は変わらず、旧名で検索できる", () => {
  const t = getToolById("image-layout")!;
  plainExpect(t.name).toBe("画像ホワイトボード");
  plainExpect(t.keywords).toContain("画像レイアウト");
  plainExpect(toolSeoContent["image-layout"].metaTitle.startsWith("画像ホワイトボード｜")).toBe(true);
  plainExpect(searchTools(getListedTools(), "画像レイアウト").map((x) => x.id)).toContain("image-layout");
});

test("4-3: 旧 /tools/ocr は /tools/pdf-to-text へ308で転送する", async ({ request }) => {
  const res = await request.get("/tools/ocr", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toBe("/tools/pdf-to-text");
});

// ===========================================================================
// 2. 純粋な関数
// ===========================================================================
plainTest.describe("4-3: ページの文字の組み立て（改行・段落・日本語の空白）", () => {
  plainTest("行の終わり・段落の切れ目を残し、日本語の文字の間に空白を入れない", () => {
    const text = pageTextFromItems([
      item("これは", 50, 700, 30),
      item("一行目です。", 80, 700, 60, 10, true),
      item("二行目です。", 50, 686, 60, 10, true),
      // 段落の切れ目（行の間が大きく空く）
      item("次の段落。", 50, 650, 50, 10, true),
      item("Hello", 50, 636, 25),
      item("World", 80, 636, 25, 10, true),
    ]);
    plainExpect(text).toBe("これは一行目です。\n二行目です。\n\n次の段落。\nHello World");
  });
  plainTest("縦書き（上から下へ続く文字）は1文字ずつ改行しない", () => {
    const text = pageTextFromItems([item("縦", 300, 700, 10), item("書", 300, 689, 10), item("き", 300, 678, 10)]);
    plainExpect(text).toBe("縦書き");
  });
  plainTest("ページの区切りに、ページ番号と読み取り方が入る", () => {
    const pages: OcrPageResult[] = [
      { pageNumber: 1, text: "あ", method: "text-layer", confidence: null },
      { pageNumber: 2, text: "い", method: "ocr", confidence: 80 },
      { pageNumber: 3, text: "", method: "needs-ocr", confidence: null },
    ];
    plainExpect(formatPageText(pages[1])).toBe("--- 2ページ（OCR） ---\nい");
    plainExpect(combinePages(pages)).toContain("--- 3ページ（未読み取り（OCRが必要）） ---");
  });
});

plainTest.describe("4-3: ページの読み取り方の判定（混在PDF）", () => {
  const page = { x0: 0, y0: 0, width: 600, height: 800 };
  plainTest("文字情報がなければOCR、文字だけならテキスト抽出", () => {
    plainExpect(classifyPage(0, [], page).kind).toBe("ocr");
    plainExpect(classifyPage(200, [], page).kind).toBe("text-layer");
  });
  plainTest("文字情報と、ある程度大きな画像があれば混在（画像の部分だけOCR）。小さなロゴは読まない", () => {
    const mixed = classifyPage(200, [{ x0: 50, y0: 100, x1: 400, y1: 300 }], page);
    plainExpect(mixed.kind).toBe("mixed");
    plainExpect(mixed.regions).toHaveLength(1);
    plainExpect(classifyPage(200, [{ x0: 10, y0: 10, x1: 40, y1: 40 }], page).kind).toBe("text-layer");
  });
  plainTest("ページ番号だけの文字情報で、ページの大部分が画像なら、スキャンしたページとしてOCR", () => {
    plainExpect(classifyPage(3, [{ x0: 0, y0: 0, x1: 600, y1: 800 }], page).kind).toBe("ocr");
  });
});

plainTest.describe("4-7: 段組み（2段）の検出と読む順番", () => {
  function twoColumnItems(): (PageTextItem & { height: number })[] {
    const out: (PageTextItem & { height: number })[] = [item("TITLE SPANNING BOTH COLUMNS OF THE PAGE", 60, 760, 470, 14)];
    for (let i = 0; i < 10; i++) {
      out.push(item(`Left column line ${i} with enough text to fill`, 60, 720 - i * 14, 220));
      out.push(item(`Right column line ${i} with enough text to fill`, 320, 720 - i * 14, 220));
    }
    return out;
  }
  plainTest("左の段→右の段の順に読み、段をまたぐ見出しは先に来る", () => {
    const layout = detectTextColumns(twoColumnItems());
    plainExpect(layout.columnCount).toBe(2);
    const order = layout.segments.map((s) => s.items[0].str);
    plainExpect(order[0]).toContain("TITLE");
    plainExpect(order[1]).toContain("Left column line 0");
    plainExpect(order[2]).toContain("Right column line 0");
    // どの文字もなくならない
    plainExpect(layout.segments.reduce((n, s) => n + s.items.length, 0)).toBe(21);
  });
  plainTest("ラベルと値の表（左の列が短い）は段組みとみなさない", () => {
    const rows: (PageTextItem & { height: number })[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(item(`Label${i}`, 60, 720 - i * 14, 40));
      rows.push(item(`Value text number ${i} that is long enough`, 320, 720 - i * 14, 220));
    }
    plainExpect(detectTextColumns(rows).columnCount).toBe(1);
  });
});

plainTest.describe("4-6: セルの値の型（数値・金額・マイナス・日付・空欄）", () => {
  plainTest("全角数字・桁区切り・小数の桁・金額・マイナスの表記", () => {
    plainExpect(parseCellValue("１，２３４")).toEqual({ kind: "number", value: 1234, format: "#,##0;-#,##0" });
    plainExpect(parseCellValue("12.50")).toMatchObject({ kind: "number", value: 12.5, format: "0.00;-0.00" });
    plainExpect(parseCellValue("¥1,000-")).toMatchObject({ kind: "number", value: 1000 });
    plainExpect(parseCellValue("1,234円")).toMatchObject({ kind: "number", value: 1234 });
    plainExpect(parseCellValue("△500")).toMatchObject({ kind: "number", value: -500 });
    plainExpect(parseCellValue("▲1,200")).toMatchObject({ kind: "number", value: -1200 });
    plainExpect(parseCellValue("(300)")).toMatchObject({ kind: "number", value: -300 });
    plainExpect(parseCellValue("−42")).toMatchObject({ kind: "number", value: -42 });
    plainExpect(parseCellValue("12.5%")).toMatchObject({ kind: "number", value: 0.125, format: "0.0%" });
  });
  plainTest("番号・空欄・記号・複数行は文字のまま（推測しない）", () => {
    plainExpect(parseCellValue("")).toEqual({ kind: "empty" });
    plainExpect(parseCellValue("001")).toEqual({ kind: "text", value: "001" });
    plainExpect(parseCellValue("03-1234-5678")).toEqual({ kind: "text", value: "03-1234-5678" });
    plainExpect(parseCellValue("☑")).toEqual({ kind: "text", value: "☑" });
    plainExpect(parseCellValue("一行目\n二行目")).toEqual({ kind: "text", value: "一行目\n二行目" });
    plainExpect(parseCellValue("1234567890123456")).toEqual({ kind: "text", value: "1234567890123456" });
    plainExpect(toExcelWriteCell("  ")).toBe("");
  });
  plainTest("日付（西暦・和暦・略記）。年のない日付は文字のまま", () => {
    const iso = (s: string) => parseDateText(s)?.toISOString().slice(0, 10) ?? null;
    plainExpect(iso("2026/4/1")).toBe("2026-04-01");
    plainExpect(iso("2026.04.01")).toBe("2026-04-01");
    plainExpect(iso("令和8年4月1日")).toBe("2026-04-01");
    plainExpect(iso("令和元年5月1日")).toBe("2019-05-01");
    plainExpect(iso("R8.4.1")).toBe("2026-04-01");
    plainExpect(iso("平成31年4月30日")).toBe("2019-04-30");
    plainExpect(iso("4月1日")).toBeNull();
    plainExpect(iso("2026/2/30")).toBeNull();
  });
});

plainTest("4-6: 入力フォームの値（テキスト・チェックボックス・ラジオ・選択欄）を、文字情報と同じ形にする", () => {
  const items = widgetsToTextItems([
    { subtype: "Widget", fieldType: "Tx", fieldValue: "山田 太郎", rect: [100, 700, 300, 720] },
    { subtype: "Widget", fieldType: "Tx", fieldValue: "一行目\n二行目", multiLine: true, rect: [100, 600, 300, 640] },
    { subtype: "Widget", fieldType: "Btn", checkBox: true, fieldValue: "Yes", exportValue: "Yes", rect: [100, 560, 112, 572] },
    { subtype: "Widget", fieldType: "Btn", checkBox: true, fieldValue: "Off", exportValue: "Yes", rect: [130, 560, 142, 572] },
    { subtype: "Widget", fieldType: "Btn", radioButton: true, fieldValue: "B", buttonValue: "A", rect: [100, 540, 112, 552] },
    { subtype: "Widget", fieldType: "Btn", radioButton: true, fieldValue: "B", buttonValue: "B", rect: [130, 540, 142, 552] },
    { subtype: "Widget", fieldType: "Ch", fieldValue: ["東京", "大阪"], rect: [100, 500, 300, 520] },
    { subtype: "Widget", fieldType: "Tx", fieldValue: "", rect: [100, 480, 300, 500] },
    { subtype: "Widget", fieldType: "Btn", pushButton: true, rect: [100, 460, 160, 480] },
    { subtype: "Link", rect: [0, 0, 10, 10] },
  ]);
  plainExpect(items.map((i) => i.str)).toEqual(["山田 太郎", "一行目", "二行目", FORM_CHECKED_MARK, FORM_UNCHECKED_MARK, FORM_UNCHECKED_MARK, FORM_CHECKED_MARK, "東京、大阪"]);
  // 複数行の欄は、上の行ほど上に置く
  plainExpect(items[1].y).toBeGreaterThan(items[2].y);
});

plainTest.describe("4-5: データの読み込み（タブ区切り・貼り付け・見出しの行・Excelの日付）", () => {
  plainTest("タブ区切り（引用符の中の改行・タブ）と、貼り付け（タブ／カンマの自動判定）", () => {
    plainExpect(parseTsv('氏名\t住所\n山田\t"東京都\n千代田区"\n')).toEqual([["氏名", "住所"], ["山田", "東京都\n千代田区"]]);
    plainExpect(parsePastedTable("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
    plainExpect(parsePastedTable("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  plainTest("見出しの行を選べる。空の見出し・重なる見出しは区別できる名前にし、空の行は除く", () => {
    const rows = [["名簿（2026年度）"], ["氏名", "", "氏名"], ["山田", "a", "x"], ["", "", ""], ["佐藤", "b"]];
    plainExpect(guessHeaderRowIndex([[""], ...rows])).toBe(1);
    const t = buildFormDataTable(rows, 1);
    plainExpect(t.headers).toEqual(["氏名", "列2", "氏名(2)"]);
    plainExpect(t.rows).toEqual([["山田", "a", "x"], ["佐藤", "b", ""]]);
  });
  plainTest("Excelの日付はUTCで読み、時刻のない日付は日付だけ。計算誤差の桁を出さない", () => {
    plainExpect(formDataCellToString(new Date(Date.UTC(2026, 3, 1)))).toBe("2026/04/01");
    plainExpect(formDataCellToString(new Date(Date.UTC(2026, 3, 1, 9, 30)))).toBe("2026/04/01 09:30");
    plainExpect(formDataCellToString(0.1 + 0.2)).toBe("0.3");
    plainExpect(formDataCellToString(true)).toBe("TRUE");
    plainExpect(formDataCellToString(null)).toBe("");
  });
  plainTest("ファイル名は、大文字・小文字の違いも同じ名前として重ならないようにする", () => {
    plainExpect(dedupeFileNamesIgnoreCase(["Yamada.pdf", "yamada.pdf", "YAMADA.pdf", "a.pdf"])).toEqual(["Yamada.pdf", "yamada_2.pdf", "YAMADA_3.pdf", "a.pdf"]);
  });
});

plainTest.describe("4-8: 税率・税額・登録番号・品目の読み取りと確認", () => {
  const L = (...t: string[]) => t.map((text) => ({ text, confidence: null }));
  plainTest("登録番号（T＋13桁。空白・ハイフンを除いて読む）", () => {
    plainExpect(extractRegistrationNumber(L("登録番号 T1234-5678-90123"))).toBe("T1234567890123");
    plainExpect(extractRegistrationNumber(L("登録番号：Ｔ１２３４５６７８９０１２３"))).toBe("T1234567890123");
    plainExpect(extractRegistrationNumber(L("T1234567890123", "T9999999999999"))).toBeNull();
    plainExpect(extractRegistrationNumber(L("TEL 03-1234-5678"))).toBeNull();
  });
  plainTest("税率と税額（合計の行・税率ごとの行・決められないとき）", () => {
    plainExpect(extractTaxRate(L("10%対象 ¥1,100", "消費税(10%) ¥100"))).toBe("10");
    plainExpect(extractTaxRate(L("8%対象 ¥540", "10%対象 ¥1,100"))).toBe("mixed");
    plainExpect(extractTaxRate(L("合計 ¥1,000"))).toBeNull();
    plainExpect(extractTaxAmount(L("10%対象 ¥1,100", "消費税(10%) ¥100", "合計 ¥1,100"), 1100)).toBe(100);
    plainExpect(extractTaxAmount(L("(10%対象 ¥1,100 内消費税 ¥100)", "(8%対象 ¥540 内消費税 ¥40)"), 1640)).toBe(140);
    plainExpect(extractTaxAmount(L("内消費税 ¥100", "内消費税 ¥40", "消費税計 ¥140"), 1640)).toBe(140);
    plainExpect(extractTaxAmount(L("消費税 ¥100", "税額 ¥150"), 2000)).toBeNull();
    plainExpect(extractTaxAmount(L("合計 ¥1,000"), 1000)).toBeNull();
  });
  plainTest("品目（品名と金額の行の品名。合計・税・支払いの行は除く）", () => {
    plainExpect(extractItems(L("コピー用紙 ¥550", "ボールペン ¥110※", "小計 ¥660", "消費税 ¥60", "合計 ¥660", "お預り ¥1,000"))).toBe("コピー用紙、ボールペン");
    plainExpect(extractItems(L("ありがとうございました"))).toBeNull();
  });
  plainTest("読み取れない項目は空欄（不明）。税区分・勘定科目は自動で入れない", () => {
    const d = extractReceiptDetails(L("株式会社サンプル", "合計 ¥1,000"), 1000);
    plainExpect(d).toEqual(EMPTY_RECEIPT_DETAILS);
    const d2 = extractReceiptDetails(L("登録番号 T1234567890123", "10%対象 ¥1,100", "消費税 ¥100"), 1100);
    plainExpect(d2.taxCategory).toBe("");
    plainExpect(d2.debitAccount).toBe("");
    plainExpect(d2.creditAccount).toBe("");
    plainExpect(d2.taxRate).toBe("10");
    plainExpect(d2.taxAmount).toBe("100");
  });
  plainTest("金額と税額が合わない・登録番号の形が違う・税区分と税率が合わないときに注意を出す", () => {
    plainExpect(expectedInclusiveTax(1100, 10)).toEqual([100]);
    const base = { ...EMPTY_RECEIPT_DETAILS, taxRate: "10", taxAmount: "100" };
    plainExpect(checkReceiptDetails(base, 1100)).toEqual([]);
    plainExpect(checkReceiptDetails({ ...base, taxAmount: "150" }, 1100)[0]).toContain("合計金額と消費税額が合いません");
    plainExpect(checkReceiptDetails({ ...base, taxAmount: "2000" }, 1100)[0]).toContain("合計金額以上");
    plainExpect(checkReceiptDetails({ ...base, registrationNumber: "T123" }, 1100)[0]).toContain("登録番号の形");
    plainExpect(checkReceiptDetails({ ...base, taxCategory: "課税仕入 8%（軽減）" }, 1100)[0]).toContain("税区分");
    plainExpect(checkReceiptDetails({ ...EMPTY_RECEIPT_DETAILS, taxRate: "mixed", taxAmount: "140" }, 1640)).toEqual([]);
  });
  plainTest("明細・仕訳CSV／Excel：列・数式の無害化・読み取り元・型", () => {
    const rec = {
      date: "2026-09-15",
      vendor: "=危険な取引先",
      total: 1100,
      source: "receipt.pdf（1/2ページ）",
      details: { ...EMPTY_RECEIPT_DETAILS, taxRate: "10", taxAmount: "100", registrationNumber: "T1234567890123", items: "コピー用紙", memo: "事務用品", taxCategory: "課税仕入 10%", debitAccount: "消耗品費", creditAccount: "現金" },
    };
    const rows = buildJournalCsvRows([rec]);
    plainExpect(rows[0]).toEqual([...JOURNAL_HEADER]);
    plainExpect(rows[1]).toEqual(["2026/09/15", "'=危険な取引先", "1100", "10%", "100", "T1234567890123", "コピー用紙", "事務用品", "課税仕入 10%", "消耗品費", "現金", "receipt.pdf（1/2ページ）"]);
    const x = buildJournalXlsxRows([rec]);
    plainExpect(x[1][0]).toMatchObject({ type: Date, format: "yyyy/mm/dd" });
    plainExpect(x[1][2]).toMatchObject({ value: 1100, type: Number });
    plainExpect(x[1][1]).toMatchObject({ value: "=危険な取引先", type: String });
  });
});

plainTest.describe("4-2: 座標（回転したページ・ページの外へ出さない）と黒塗りの区別", () => {
  plainTest("見た目の座標をページ本来の座標へ移す（回転0・90・180・270、原点が(0,0)でないCropBox）", () => {
    const crop = { x: 10, y: 20, width: 600, height: 800 };
    const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    // 見た目の左下(0,0)が、それぞれのページ本来の座標のどこになるか
    plainExpect(apply(displayToPageMatrix(0, crop), 0, 0)).toEqual([10, 20]);
    plainExpect(apply(displayToPageMatrix(90, crop), 0, 0)).toEqual([610, 20]);
    plainExpect(apply(displayToPageMatrix(180, crop), 0, 0)).toEqual([610, 820]);
    plainExpect(apply(displayToPageMatrix(270, crop), 0, 0)).toEqual([10, 820]);
    // 90度：見た目の左上（0, 600）は、ページ本来の左下(10,20)
    plainExpect(apply(displayToPageMatrix(90, crop), 0, 600)).toEqual([10, 20]);
  });
  plainTest("動かす量は、ページの中に収まる範囲に抑える", () => {
    const page = { width: 600, height: 800 };
    plainExpect(clampMoveDelta({ minX: 10, maxX: 110, minY: 10, maxY: 60 }, -50, -50, page)).toEqual({ dx: -10, dy: -10 });
    plainExpect(clampMoveDelta({ minX: 10, maxX: 110, minY: 10, maxY: 60 }, 600, 900, page)).toEqual({ dx: 490, dy: 740 });
  });
  plainTest("黒塗り（見た目だけ）は真っ黒の塗りつぶし。白消し・図形の黒とは区別し、注意書きは墨消しと言わない", () => {
    const rect = (color: typeof BLACKOUT_COLOR): AnnotationObject => ({ id: "x", page: 1, type: "shape", shapeKind: "rectangle", x: 0, y: 0, width: 10, height: 10, rotation: 0, color, strokeWidth: 1, fill: true });
    plainExpect(isBlackoutObject(rect(BLACKOUT_COLOR))).toBe(true);
    plainExpect(isWhiteoutObject(rect(BLACKOUT_COLOR))).toBe(false);
    plainExpect(isBlackoutObject(rect(WHITEOUT_COLOR))).toBe(false);
    plainExpect(isBlackoutObject(rect({ r: 0.1, g: 0.1, b: 0.12 }))).toBe(false);
    plainExpect(`${BLACKOUT_NOTICE.title}${BLACKOUT_NOTICE.body}`).toContain("墨消し（元のデータの削除）ではありません");
    plainExpect(`${BLACKOUT_NOTICE.title}${BLACKOUT_NOTICE.body}`).not.toMatch(/復元(でき|不可|不能)|完全に削除しま/);
  });
});

plainTest.describe("4-1: はみ出しの確認・キャンバスを広げる・書き出しの倍率・文字の折り返し", () => {
  const base: ImageLayoutItem = { id: "a", kind: "image", x: 0, y: 0, width: 100, height: 50, rotation: 0, zIndex: 1, fit: "contain", imageIndex: 0 };
  plainTest("回転を反映した外枠で、はみ出しを見つける", () => {
    const rb = rotatedItemBounds({ ...base, rotation: 90 });
    plainExpect(rb.minX).toBeCloseTo(25, 6);
    plainExpect(rb.minY).toBeCloseTo(-25, 6);
    plainExpect(rb.maxX).toBeCloseTo(75, 6);
    plainExpect(rb.maxY).toBeCloseTo(75, 6);
    plainExpect(findOverflowingItems([base, { ...base, id: "b", x: 950 }], 1000, 500).map((i) => i.id)).toEqual(["b"]);
    plainExpect(findOverflowingItems([{ ...base, rotation: 90 }], 1000, 500).map((i) => i.id)).toEqual(["a"]);
  });
  plainTest("キャンバスを広げて、左・上にはみ出したぶんは全体をずらす", () => {
    plainExpect(computeFitCanvas([{ ...base, x: -20, y: -10 }, { ...base, id: "b", x: 980, y: 480 }], 1000, 500)).toEqual({ width: 1100, height: 540, shiftX: 20, shiftY: 10 });
    plainExpect(computeFitCanvas([base], 1000, 500)).toEqual({ width: 1000, height: 500, shiftX: 0, shiftY: 0 });
  });
  plainTest("自動の倍率：元の画像の解像度を落とさない（2〜4倍、画素数の上限まで）", () => {
    const sizes = new Map([[0, { width: 400, height: 200 }]]);
    plainExpect(computeAutoExportScale([base], sizes, 1000, 500)).toBe(4);
    plainExpect(computeAutoExportScale([{ ...base, width: 300, height: 150 }], sizes, 1000, 500)).toBeCloseTo(2, 5);
    plainExpect(computeAutoExportScale([base], sizes, 6000, 6000)).toBeLessThan(2);
  });
  plainTest("文字は枠の幅で折り返し、改行を保つ（英単語の途中では切らない）", () => {
    const measure = (s: string) => s.length * 10;
    plainExpect(wrapTextLines("あいうえおかきくけこ", 50, measure)).toEqual(["あいうえお", "かきくけこ"]);
    plainExpect(wrapTextLines("hello world", 60, measure)).toEqual(["hello", "world"]);
    plainExpect(wrapTextLines("a\n\nb", 100, measure)).toEqual(["a", "", "b"]);
  });
});

// ===========================================================================
// 3. 画面（4-3 PDF→テキスト（OCR対応））
// ===========================================================================
async function buildTextPdf(file: string, pages: string[][], opts: { rotate?: number } = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    lines.forEach((t, i) => page.drawText(t, { x: 60, y: 780 - i * 24, size: 14, font, color: rgb(0, 0, 0) }));
    if (opts.rotate) page.setRotation(degrees(opts.rotate));
  }
  fs.writeFileSync(file, await pdf.save());
}

/** ブラウザのcanvasで、文字を描いた画像（PNG）を作る（同梱の日本語フォント） */
async function renderTextPng(page: Page, lines: string[]): Promise<Buffer> {
  const base64 = await page.evaluate(async (texts) => {
    const font = new FontFace("Step4Font", "url(/fonts/NotoSansJP-Regular.ttf)");
    await font.load();
    document.fonts.add(font);
    const canvas = document.createElement("canvas");
    canvas.width = 1000;
    canvas.height = 120 + texts.length * 90;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    ctx.font = "56px Step4Font";
    texts.forEach((t, i) => ctx.fillText(t, 50, 100 + i * 90));
    return canvas.toDataURL("image/png").split(",")[1];
  }, lines);
  return Buffer.from(base64, "base64");
}

test.describe("4-3: PDF→テキスト（OCR対応）の画面", () => {
  test.setTimeout(240_000);

  test("文字のページ・スキャンしたページ・文字と画像の混在ページを、ページごとに読み分け、区切り付きのテキストで保存する", async ({ page }) => {
    const dir = scratchDir("step4-text");
    await page.goto("/tools/pdf-to-text");
    const scanPng = await renderTextPng(page, ["スキャン見本"]);
    const figurePng = await renderTextPng(page, ["図の文字"]);
    const mixed = path.join(dir, "mixed.pdf");
    {
      const pdf = await PDFDocument.create();
      pdf.registerFontkit(fontkit);
      const font = await pdf.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
      // 1ページ目：文字だけ（2つの段落）
      const p1 = pdf.addPage([595, 842]);
      p1.drawText("一つ目の段落の一行目です。", { x: 60, y: 780, size: 14, font });
      p1.drawText("一つ目の段落の二行目です。", { x: 60, y: 760, size: 14, font });
      p1.drawText("二つ目の段落です。", { x: 60, y: 700, size: 14, font });
      // 2ページ目：画像だけ（スキャンの代わり）
      const scan = await pdf.embedPng(scanPng);
      const p2 = pdf.addPage([595, 842]);
      p2.drawImage(scan, { x: 0, y: 842 - 300, width: 595, height: (595 * scan.height) / scan.width });
      // 3ページ目：文字と画像（図）
      const fig = await pdf.embedPng(figurePng);
      const p3 = pdf.addPage([595, 842]);
      p3.drawText("本文の文字です。", { x: 60, y: 780, size: 14, font });
      p3.drawImage(fig, { x: 60, y: 400, width: 450, height: (450 * fig.height) / fig.width });
      fs.writeFileSync(mixed, await pdf.save());
    }
    await uploadFixture(page, mixed);
    await expect(page.getByTestId("pdf-text-ocr-language")).toBeVisible();
    await page.getByRole("button", { name: "テキストを抽出する", exact: true }).click();
    await waitForSuccess(page, "テキスト抽出が完了しました", 200_000);
    await expect(page.getByTestId("pdf-text-page-1")).toHaveAttribute("data-method", "text-layer");
    await expect(page.getByTestId("pdf-text-page-2")).toHaveAttribute("data-method", "ocr");
    await expect(page.getByTestId("pdf-text-page-3")).toHaveAttribute("data-method", "mixed");
    await expect(page.getByTestId("pdf-text-ocr-accuracy")).toBeVisible();
    const d = await clickAndDownload(page, "テキストをダウンロード");
    const { path: txt } = await assertDownloadedFile(d, { minBytes: 10 });
    const text = fs.readFileSync(txt, "utf8").replace(/^﻿/, "");
    expect(text).toContain("--- 1ページ（テキスト抽出） ---\n一つ目の段落の一行目です。\n一つ目の段落の二行目です。\n\n二つ目の段落です。");
    expect(text).toContain("--- 2ページ（OCR） ---");
    expect(text.replace(/\s/g, "")).toContain("スキャン");
    expect(text).toContain("--- 3ページ（テキスト抽出＋画像OCR） ---\n本文の文字です。\n\n[画像の中の文字（OCR）]");
    expect(d.suggestedFilename()).toBe("mixed.txt");
  });

  test("画像ファイルもOCRで読み取れる", async ({ page }) => {
    const dir = scratchDir("step4-img");
    await page.goto("/tools/pdf-to-text");
    const png = path.join(dir, "photo.png");
    fs.writeFileSync(png, await renderTextPng(page, ["見本の文字"]));
    await uploadFixture(page, png);
    await expect(page.getByRole("img", { name: "読み取る画像" })).toBeVisible();
    await page.getByRole("button", { name: "テキストを抽出する", exact: true }).click();
    await waitForSuccess(page, "テキスト抽出が完了しました", 200_000);
    await expect(page.getByTestId("pdf-text-count-ocr")).toContainText("OCR：画像");
    await expect(page.getByTestId("pdf-text-result")).toContainText("見本");
  });
});

plainTest("4-3・4-4: ツールの中のプレミアム機能の判定（OCRは元のOCRと同じ条件・複数ページ押印はプレミアムだけ）", () => {
  // 運用スイッチ ALL_TOOLS_STANDARD がオンの間は、元はプレミアム限定だったOCRもスタンダード扱い（統合で使えなくならない）
  const switchOn = effectiveRequiredPlan("premium") === "standard";
  plainExpect(canUsePremiumFeature("free", "premium-tool")).toBe(switchOn);
  plainExpect(canUsePremiumFeature("premium", "premium-tool")).toBe(true);
  // 電子印鑑の複数ページ押印（新しいプレミアムの機能）は、スイッチに関わらずプレミアムだけ
  plainExpect(canUsePremiumFeature("free", "premium-only")).toBe(false);
  plainExpect(canUsePremiumFeature("standard", "premium-only")).toBe(false);
  plainExpect(canUsePremiumFeature("premium", "premium-only")).toBe(true);
});

// ===========================================================================
// 4. 画面（4-4 電子印鑑の複数ページ押印）
// ===========================================================================
async function makeBlankPdf(file: string, pageCount: number) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const p = doc.addPage([595, 842]);
    p.drawRectangle({ x: 36, y: 36, width: 523, height: 770, borderWidth: 0.5, borderColor: rgb(0.7, 0.7, 0.7) });
  }
  fs.writeFileSync(file, await doc.save());
}

async function enableQr(page: Page) {
  await expect(async () => {
    const box = page.getByLabel("固有番号とQRコードを入れる");
    if (await box.isChecked()) await box.uncheck();
    await box.check();
    await expect(page.getByTestId("stamp-pdf-target")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

/** PDFのページを画像にして、赤い画素（印影）の数を数える */
function redPixels(pdf: string, pageNo: number): number {
  const dir = scratchDir("step4-stamp-render");
  const base = path.join(dir, `p${pageNo}`);
  execFileSync("pdftoppm", ["-png", "-r", "40", "-f", String(pageNo), "-l", String(pageNo), "-singlefile", pdf, base]);
  return Number(
    py(
      "import sys,subprocess\nraw=subprocess.run(['ffmpeg','-v','error','-i',sys.argv[1],'-f','rawvideo','-pix_fmt','rgb24','-'],capture_output=True).stdout\nn=0\nfor i in range(0,len(raw),3):\n  r,g,b=raw[i],raw[i+1],raw[i+2]\n  n+= 1 if (r>150 and g<110 and b<110) else 0\nprint(n)",
      [`${base}.png`]
    ).trim()
  );
}

test.describe("4-4: 電子印鑑の複数ページ押印（プレミアム）", () => {
  test.use({ viewport: { width: 1280, height: 1400 } });
  test.setTimeout(180_000);

  test("プレミアム：ページの一覧から押すページを選び、ページごとに位置・大きさ・角度を決めて押す（選ばないページには押さない）", async ({ page }) => {
    const dir = scratchDir("step4-stamp");
    const src = path.join(dir, "three.pdf");
    await makeBlankPdf(src, 3);
    await page.goto("/tools/electronic-stamp-generator");
    await page.locator("#stamp-text-input").fill("山田");
    await enableQr(page);
    await page.getByTestId("stamp-target-pdf-input").setInputFiles(src);
    await expect(page.getByTestId("stamp-target-pdf-name")).toContainText("three.pdf");
    // 既定は、これまでどおり1ページだけ（ページの選択）
    await expect(page.getByTestId("stamp-target-page")).toBeVisible();
    await page.getByTestId("stamp-multipage-toggle").check();
    await expect(page.getByTestId("stamp-page-list")).toBeVisible();
    await expect(page.getByTestId("stamp-page-1")).toHaveAttribute("data-stamped", "true");
    // 3ページ目にも押す。3ページ目を選んで、位置・角度を変える
    await page.getByTestId("stamp-page-toggle-3").check();
    await page.getByTestId("stamp-page-select-3").click();
    await expect(page.getByTestId("stamp-active-page")).toContainText("3ページ目");
    await page.getByRole("slider", { name: "印影の横の位置（X）" }).fill("10");
    await page.getByRole("slider", { name: "印影の縦の位置（Y）" }).fill("90");
    await page.getByRole("slider", { name: "印影の角度" }).fill("30");
    await expect(page.getByTestId("stamp-multipage-summary")).toContainText("2ページに押します（1・3ページ目）");
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-result-summary")).toHaveText("この印影を、PDF（全3ページ）の1・3ページ目に押しました。");
    const d = await clickAndDownload(page, "PDFをダウンロード");
    const { path: out } = await assertDownloadedFile(d, { format: "pdf", minBytes: 100 });
    expect(redPixels(out, 1)).toBeGreaterThan(20);
    expect(redPixels(out, 2)).toBe(0);
    expect(redPixels(out, 3)).toBeGreaterThan(20);
  });

  test("スタンダード（無料）：これまでどおり1ページだけに押し、複数ページの押印はプレミアムの機能と案内する", async ({ page, context, baseURL }) => {
    await setDevPlanOverride(context, "standard", baseURL!);
    const dir = scratchDir("step4-stamp-std");
    const src = path.join(dir, "two.pdf");
    await makeBlankPdf(src, 2);
    await page.goto("/tools/electronic-stamp-generator");
    await page.locator("#stamp-text-input").fill("佐藤");
    await enableQr(page);
    await page.getByTestId("stamp-target-pdf-input").setInputFiles(src);
    await expect(page.getByTestId("stamp-multipage-premium-note")).toBeVisible();
    await expect(page.getByTestId("stamp-multipage-toggle")).toHaveCount(0);
    await expect(page.getByRole("slider", { name: "印影の角度" })).toHaveCount(0);
    await page.getByTestId("stamp-target-page").selectOption("1");
    await page.getByRole("button", { name: "印影画像を生成する", exact: true }).click();
    await waitForSuccess(page, "印影画像が完成しました");
    await expect(page.getByTestId("stamp-result-summary")).toHaveText("この印影を、PDF（全2ページ）の2ページ目に押しました。");
  });
});

// ===========================================================================
// 5. 画面（4-2 PDF修正）
// ===========================================================================
const CANVAS = '[data-testid="pdf-annotate-canvas"]';

test.describe("4-2: PDF修正の操作", () => {
  test.use({ viewport: { width: 1280, height: 1400 } });
  test.setTimeout(120_000);

  test("黒塗り（見た目だけ）：置ける・注意書きと墨消しへの案内が出る。書き出したPDFには元の文字が残る（墨消しではないことの確認）", async ({ page }) => {
    const dir = scratchDir("step4-blackout");
    const src = path.join(dir, "secret.pdf");
    await buildTextPdf(src, [["秘密の情報ABC"]]);
    await page.goto("/tools/pdf-fix");
    await uploadWhenReady(page, src, page.locator(CANVAS));
    await expect(page.getByTestId("pdf-fix-redaction-methods")).toContainText("墨消し（元のデータごと削除）＝PDF黒塗り・墨消し");
    await page.getByRole("button", { name: "黒塗り（見た目だけ）", exact: true }).click();
    await expect(page.getByTestId("pdf-blackout-panel")).toContainText("墨消し（元のデータの削除）ではありません");
    await expect(page.getByTestId("pdf-blackout-redact-link")).toHaveAttribute("href", "/tools/pdf-redact");
    await page.locator(CANVAS).click({ position: { x: 120, y: 60 } });
    await expect(page.getByTestId("pdf-blackout-object")).toHaveCount(1);
    await expect(page.getByTestId("pdf-blackout-badge")).toContainText("元データは残る");
    await expect(page.getByTestId("pdf-blackout-export-notice")).toBeVisible();
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    await waitForSuccess(page, "書き出しが完了しました");
    const d = await clickAndDownload(page, "PDFをダウンロード");
    const { path: out } = await assertDownloadedFile(d, { format: "pdf", minBytes: 10 });
    // 見た目だけを隠す方式なので、文字の抽出では元の文字が読める（「墨消し」と表示しないことの根拠）
    expect(execFileSync("pdftotext", [out, "-"], { encoding: "utf8" })).toContain("秘密の情報ABC");
  });

  test("置いたものは、配置用のモードのままでもつかんで動かせ、ページの外へは出ない。右下のつまみで大きさを変えられる", async ({ page }) => {
    await page.goto("/tools/pdf-fix");
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS));
    await page.getByRole("button", { name: "図形", exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 200, y: 200 } });
    const shape = page.locator(`${CANVAS} > div.absolute`).last();
    await expect(shape).toBeVisible();
    // もう一度「図形」モードにしても、置いた図形をつかんで動かせる（新しい図形は増えない）
    await page.getByRole("button", { name: "図形", exact: true }).click();
    const canvasBox = (await page.locator(CANVAS).boundingBox())!;
    const before = (await shape.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x - 400, canvasBox.y - 400, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByText("配置した注釈（1件）")).toBeVisible();
    const after = (await shape.boundingBox())!;
    // 左上の角で止まる（ページの外へ出ない）
    expect(Math.abs(after.x - canvasBox.x)).toBeLessThan(3);
    expect(Math.abs(after.y - canvasBox.y)).toBeLessThan(3);
    // つまみで大きくする
    const handle = page.getByTestId("pdf-annotate-resize-handle");
    await expect(handle).toBeVisible();
    const h = (await handle.boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 80, h.y + 40, { steps: 6 });
    await page.mouse.up();
    const resized = (await shape.boundingBox())!;
    expect(resized.width).toBeGreaterThan(after.width + 50);
    expect(resized.height).toBeGreaterThan(after.height + 20);
    expect(Math.abs(resized.x - after.x)).toBeLessThan(3); // 左上は動かない
  });

  test("枠なしのチェック（マークだけ）を置ける。チェックした状態で置かれ、書き出せる", async ({ page }) => {
    await page.goto("/tools/pdf-fix");
    await uploadWhenReady(page, fixtures.singlePagePdf, page.locator(CANVAS));
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await page.getByTestId("pdf-annotate-checkbox-frame").uncheck();
    await page.locator(CANVAS).click({ position: { x: 100, y: 100 } });
    await page.getByRole("button", { name: "チェック", exact: true }).click();
    await page.getByTestId("pdf-annotate-checkbox-frame").uncheck();
    await page.locator(CANVAS).click({ position: { x: 160, y: 100 } });
    const marks = page.getByTestId("pdf-annotate-checkbox-object");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveAttribute("data-frame", "false");
    await expect(marks.first()).toContainText("✓");
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    await waitForSuccess(page, "書き出しが完了しました");
  });

  test("回転したページ（/Rotate 90）でも、見た目の左上に置いた黒塗りは、書き出したPDFでも見た目の左上に来る", async ({ page }) => {
    const dir = scratchDir("step4-rotate");
    const src = path.join(dir, "rotated.pdf");
    {
      const doc = await PDFDocument.create();
      doc.addPage([595, 842]).setRotation(degrees(90));
      fs.writeFileSync(src, await doc.save());
    }
    await page.goto("/tools/pdf-fix");
    await uploadWhenReady(page, src, page.locator(CANVAS));
    await page.getByRole("button", { name: "黒塗り（見た目だけ）", exact: true }).click();
    const box = (await page.locator(CANVAS).boundingBox())!;
    // 見た目の左上あたり（キャンバスの幅の1/6・高さの1/6）に置く
    await page.locator(CANVAS).click({ position: { x: box.width / 6, y: box.height / 6 } });
    await page.getByRole("button", { name: "PDFを書き出す" }).click();
    await waitForSuccess(page, "書き出しが完了しました");
    const d = await clickAndDownload(page, "PDFをダウンロード");
    const { path: out } = await assertDownloadedFile(d, { format: "pdf", minBytes: 10 });
    const base = path.join(dir, "out");
    execFileSync("pdftoppm", ["-png", "-r", "30", "-singlefile", out, base]);
    // 見た目（回転を反映した画像）の、左上の4分の1に黒い画素が集まり、右下には無い
    const result = py(
      "import sys,subprocess,json\np=sys.argv[1]\nw,h=[int(x) for x in subprocess.run(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0',p],capture_output=True,text=True).stdout.strip().split(',')]\nraw=subprocess.run(['ffmpeg','-v','error','-i',p,'-f','rawvideo','-pix_fmt','gray','-'],capture_output=True).stdout\ntl=br=0\nfor y in range(h):\n  for x in range(w):\n    if raw[y*w+x]<60:\n      if x<w/2 and y<h/2: tl+=1\n      if x>=w/2 and y>=h/2: br+=1\nprint(json.dumps({'w':w,'h':h,'tl':tl,'br':br}))",
      [`${base}.png`]
    );
    const r = JSON.parse(result);
    expect(r.w).toBeGreaterThan(r.h); // 横向き（回転を反映）
    expect(r.tl).toBeGreaterThan(20);
    expect(r.br).toBe(0);
  });
});

// ===========================================================================
// 6. 画面（4-1 画像ホワイトボード）
// ===========================================================================
test.describe("4-1: 画像ホワイトボード", () => {
  test.use({ viewport: { width: 1280, height: 1200 } });

  test("はみ出した画像を知らせ、「キャンバスを広げて全体を収める」で切らずに書き出せる。Deleteキーで削除できる", async ({ page }) => {
    await page.goto("/tools/image-layout");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("画像ホワイトボード");
    await uploadFixture(page, [fixtures.png, fixtures.jpg]);
    const canvas = page.getByTestId("tool-preview");
    const itemsLoc = canvas.locator(":scope > div.absolute");
    await expect(itemsLoc).toHaveCount(2);
    // 2枚目を右下の外へドラッグする
    const target = itemsLoc.nth(1);
    const b = (await target.boundingBox())!;
    const c = (await canvas.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(c.x + c.width - 10, c.y + c.height - 10, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId("whiteboard-overflow-warning")).toHaveAttribute("data-count", "1");
    await page.getByTestId("whiteboard-fit-canvas").click();
    await expect(page.getByTestId("whiteboard-overflow-warning")).toHaveCount(0);
    const w = Number(await page.getByLabel("キャンバスの幅(px)").inputValue());
    expect(w).toBeGreaterThan(1200);
    // 書き出し（解像度 2倍）。出力の大きさは キャンバス×2
    await page.getByTestId("whiteboard-export-scale").selectOption("2");
    const h = Number(await page.getByLabel("キャンバスの高さ(px)").inputValue());
    await expect(page.getByTestId("whiteboard-export-note")).toContainText(`${w * 2}×${h * 2}px`);
    await page.getByRole("button", { name: "書き出す", exact: true }).click();
    await waitForSuccess(page, "書き出しが完了しました");
    await expect(page.getByTestId("whiteboard-result-size")).toContainText(`${w * 2} × ${h * 2}px`);
    await closeResultPopup(page);
    // 選んだアイテムを Delete キーで削除
    await itemsLoc.nth(0).click();
    await page.keyboard.press("Delete");
    await expect(itemsLoc).toHaveCount(1);
  });

  test("透明な背景のPNGは透明のまま、JPEGは白で書き出す（案内も出る）", async ({ page }) => {
    await page.goto("/tools/image-layout");
    await uploadFixture(page, fixtures.stampTransparentPng);
    await page.getByRole("button", { name: "透過", exact: true }).click();
    await expect(page.getByTestId("whiteboard-export-note")).toContainText("背景は透明のまま");
    await page.getByRole("button", { name: "書き出す", exact: true }).click();
    await waitForSuccess(page, "書き出しが完了しました");
    const d = await clickAndDownload(page, /ダウンロード/);
    const { path: png } = await assertDownloadedFile(d, { format: "png" });
    const alpha = py(
      "import sys,subprocess\nraw=subprocess.run(['ffmpeg','-v','error','-i',sys.argv[1],'-f','rawvideo','-pix_fmt','rgba','-'],capture_output=True).stdout\nprint(sum(1 for i in range(3,len(raw),4) if raw[i]==0))",
      [png]
    );
    expect(Number(alpha)).toBeGreaterThan(1000);
    await closeResultPopup(page);
    await page.getByRole("button", { name: "jpeg", exact: true }).click();
    await expect(page.getByTestId("whiteboard-export-note")).toContainText("透明な部分は白");
  });
});

// ===========================================================================
// 7. 画面（4-5 PDF差し込み印刷）
// ===========================================================================
test("4-5: 貼り付けたデータ（上にタイトルの行がある表）で見出しの行を選び直し、一括生成の結果を一覧で確かめられる", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto("/tools/form-to-individual-pdfs");
  await uploadFixture(page, fixtures.singlePagePdf);
  await page.getByRole("button", { name: "+ フィールドを追加" }).click();
  await page.getByTestId("tool-preview").locator("div.relative").first().click({ position: { x: 60, y: 60 } });
  await page.getByRole("button", { name: "次へ（CSV/Excelのアップロード）" }).click();
  await page.getByTestId("form-data-paste-toggle").click();
  await page.getByTestId("form-data-paste").fill("参加者名簿（2026年度）\n項目1\t備考\n山田\tA\n\t\n佐藤\tB\n");
  await page.getByTestId("form-data-paste-apply").click();
  // 最初の空でない行（タイトル）が見出しになっているので、2行目を選び直す
  await page.getByTestId("form-data-header-row").selectOption("1");
  await expect(page.getByTestId("form-data-summary")).toContainText("2件のデータ行を読み込みました（列: 項目1, 備考）");
  await page.getByLabel("列の対応・ファイル名の設定内容を確認しました").check();
  await page.getByRole("button", { name: "1人分プレビューする" }).click();
  await page.getByRole("button", { name: "内容に問題なければ、全員分を一括生成する" }).click();
  await page.getByRole("button", { name: "一括生成してZIPを作成する" }).click();
  await waitForSuccess(page, "全員分のPDF生成が完了しました", 60_000);
  await page.getByTestId("form-result-list").locator("summary").click();
  await expect(page.getByTestId("form-result-name")).toHaveText(["1.pdf", "2.pdf"]);
});

// ===========================================================================
// 8. 画面（4-6 記入済みPDF→Excel）
// ===========================================================================
test("4-6: 入力フォームに記入したPDF（テキスト欄・チェックボックス）と、金額・マイナス・和暦の日付を、Excelの値として読み取る", async ({ page }) => {
  test.setTimeout(120_000);
  const dir = scratchDir("step4-filled");
  const src = path.join(dir, "form.pdf");
  {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(fs.readFileSync(FONT_PATH), { subset: false });
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const p = pdf.addPage([595, 842]);
    p.drawText("金額", { x: 60, y: 780, size: 12, font });
    p.drawText("¥1,234", { x: 300, y: 780, size: 12, font });
    p.drawText("差額", { x: 60, y: 750, size: 12, font });
    p.drawText("△500", { x: 300, y: 750, size: 12, font });
    p.drawText("日付", { x: 60, y: 720, size: 12, font });
    p.drawText("令和8年4月1日", { x: 300, y: 720, size: 12, font });
    p.drawText("氏名", { x: 60, y: 690, size: 12, font });
    p.drawText("同意", { x: 60, y: 660, size: 12, font });
    const form = pdf.getForm();
    const name = form.createTextField("name");
    name.setText("Taro Yamada");
    name.addToPage(p, { x: 300, y: 684, width: 150, height: 18, font: helv });
    const agree = form.createCheckBox("agree");
    agree.addToPage(p, { x: 300, y: 656, width: 14, height: 14 });
    agree.check();
    fs.writeFileSync(src, await pdf.save());
  }
  await page.goto("/tools/filled-pdf-to-excel");
  await uploadFixture(page, src);
  await page.getByRole("button", { name: "Excelに変換する", exact: true }).click();
  await waitForSuccess(page, "Excelファイルの生成が完了しました", 90_000);
  const d = await clickAndDownload(page, "Excelファイルをダウンロード");
  const { path: xlsx } = await assertDownloadedFile(d, { format: "zip" });
  const cells = JSON.parse(
    py(
      "import sys,json,openpyxl,datetime\nws=openpyxl.load_workbook(sys.argv[1]).active\nout=[]\nfor row in ws.iter_rows():\n  for c in row:\n    v=c.value\n    if v is None: continue\n    out.append([type(v).__name__, v.isoformat() if isinstance(v,datetime.datetime) else v, c.number_format])\nprint(json.dumps(out, ensure_ascii=False))",
      [asXlsx(xlsx)]
    )
  ) as [string, string | number, string][];
  const find = (pred: (c: [string, string | number, string]) => boolean) => cells.find(pred);
  expect(find((c) => c[1] === 1234 && c[0] === "int")).toBeTruthy();
  expect(find((c) => c[1] === -500)).toBeTruthy();
  expect(find((c) => c[0] === "datetime" && String(c[1]).startsWith("2026-04-01"))).toBeTruthy();
  expect(find((c) => c[1] === "Taro Yamada")).toBeTruthy();
  expect(find((c) => c[1] === FORM_CHECKED_MARK)).toBeTruthy();
});

// ===========================================================================
// 9. 画面（4-7 PDF→Word の段組み）
// ===========================================================================
test("4-7: 2段組みのPDFは、左の段→右の段の順に読み、Wordの段組み（2段）にする。Wordファイルとして開ける", async ({ page }) => {
  test.setTimeout(120_000);
  const dir = scratchDir("step4-word");
  const src = path.join(dir, "two-col.pdf");
  {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let pg = 0; pg < 2; pg++) {
      const p = pdf.addPage([595, 842]);
      for (let i = 0; i < 25; i++) {
        p.drawText(`Left column sentence number ${pg}-${i} goes here.`, { x: 50, y: 780 - i * 14, size: 10, font });
        p.drawText(`Right column sentence number ${pg}-${i} goes here.`, { x: 320, y: 780 - i * 14, size: 10, font });
      }
    }
    fs.writeFileSync(src, await pdf.save());
  }
  await page.goto("/tools/pdf-to-word");
  await uploadFixture(page, src);
  await page.getByRole("button", { name: "Wordに変換する", exact: true }).click();
  await expect(page.getByTestId("result-popup")).toBeVisible({ timeout: 90_000 });
  const d = await clickAndDownload(page, "Word文書をダウンロード");
  const { path: docx } = await assertDownloadedFile(d, { format: "zip" });
  const info = JSON.parse(
    py(
      "import sys,zipfile,re,json\nx=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf8')\ncols=re.search(r'<w:cols [^>]*w:num=\"(\\d+)\"',x)\ntext=''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',x))\nprint(json.dumps({'cols':cols.group(1) if cols else None,'l24':text.find('Left column sentence number 0-24'),'r0':text.find('Right column sentence number 0-0'),'l0':text.find('Left column sentence number 0-0')}))",
      [docx]
    )
  );
  expect(info.cols).toBe("2");
  expect(info.l0).toBeGreaterThanOrEqual(0);
  // 左の段を読み終えてから、右の段に進む（左右の文が交互に混ざらない）
  expect(info.l24).toBeLessThan(info.r0);
  // LibreOffice で開ける（Wordファイルとして壊れていない）
  const outDir = path.join(dir, "lo");
  execFileSync("soffice", ["--headless", "--convert-to", "txt:Text", "--outdir", outDir, docx], { timeout: 90_000 });
  expect(fs.readFileSync(path.join(outDir, path.basename(docx).replace(/\.[^.]+$/, "") + ".txt"), "utf8")).toContain("Right column sentence number 1-24");
});

// ===========================================================================
// 10. 画面（4-8 領収書・レシート）
// ===========================================================================
test("4-8: 文字情報のある領収書から税率・税額・登録番号・品目を読み取り、税区分・勘定科目を入力して、明細CSV・Excelに出力する", async ({ page }) => {
  test.setTimeout(180_000);
  const dir = scratchDir("step4-receipt");
  const src = path.join(dir, "receipt.pdf");
  await buildTextPdf(src, [
    ["株式会社サンプル商店", "2026年9月15日", "登録番号 T1234567890123", "コピー用紙 ¥1,000", "10%対象 ¥1,100", "消費税(10%) ¥100", "合計 ¥1,100"],
    ["有限会社二枚目", "2026年9月20日", "合計 ¥2,000", "消費税(10%) ¥300"],
  ]);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto("/tools/receipt-accounting-csv");
  await uploadWhenReady(page, src, page.getByTestId("receipt-row").nth(1), { readyTimeoutMs: 120_000 });
  const rows = page.getByTestId("receipt-row");
  const r1 = rows.nth(0);
  await expect(r1.getByTestId("receipt-tax-rate")).toHaveValue("10");
  await expect(r1.getByTestId("receipt-taxAmount")).toHaveValue("100");
  await expect(r1.getByTestId("receipt-registrationNumber")).toHaveValue("T1234567890123");
  await expect(r1.getByTestId("receipt-items")).toHaveValue("コピー用紙");
  await expect(r1.getByTestId("receipt-detail-source-taxAmount")).toHaveText("自動読み取り");
  // 税区分・勘定科目は空のまま（自動で入れない）。自動で確認済みにもならない
  await expect(r1.getByTestId("receipt-tax-category")).toHaveValue("");
  await expect(r1.getByTestId("receipt-debitAccount")).toHaveValue("");
  await expect(r1).toHaveAttribute("data-confirmed", "false");
  // 2枚目は、合計と税額が合わない → 注意。登録番号は不明
  const r2 = rows.nth(1);
  await expect(r2.getByTestId("receipt-detail-warning")).toContainText("合計金額と消費税額が合いません");
  await expect(r2.getByTestId("receipt-detail-source-registrationNumber")).toHaveText("不明（読み取れませんでした）");
  // 入力して確認済みにする
  await r1.getByTestId("receipt-tax-category").fill("課税仕入 10%");
  await r1.getByTestId("receipt-memo").fill("事務用品");
  await r1.getByTestId("receipt-debitAccount").fill("消耗品費");
  await r1.getByTestId("receipt-creditAccount").fill("現金");
  await r1.getByTestId("receipt-confirm").click();
  await expect(r1).toHaveAttribute("data-confirmed", "true");
  // 税区分を変えると、確認済みは外れる
  await r1.getByTestId("receipt-memo").fill("事務用品（コピー用紙）");
  await expect(r1).toHaveAttribute("data-confirmed", "false");
  await r1.getByTestId("receipt-confirm").click();
  await page.getByTestId("receipt-format-journal").check();
  await expect(page.getByTestId("journal-row")).toHaveCount(1);
  const csvDl = await clickAndDownload(page, "CSVをダウンロード");
  // 文字コードの選択が出る場合は、既定（UTF-8）のまま保存する
  const { path: csv } = await assertDownloadedFile(csvDl, { minBytes: 10 });
  const lines = fs.readFileSync(csv, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  expect(lines[0]).toBe(JOURNAL_HEADER.join(","));
  expect(lines[1]).toBe("2026/09/15,株式会社サンプル商店,1100,10%,100,T1234567890123,コピー用紙,事務用品（コピー用紙）,課税仕入 10%,消耗品費,現金,receipt.pdf（1/2ページ）");
  const xDl = await clickAndDownload(page, "Excelをダウンロード");
  const { path: xlsx } = await assertDownloadedFile(xDl, { format: "zip" });
  const row = JSON.parse(
    py("import sys,json,openpyxl\nws=openpyxl.load_workbook(sys.argv[1]).active\nr=[c.value for c in ws[2]]\nprint(json.dumps([str(r[0])[:10], r[1], r[2], r[4], r[8], r[11]], ensure_ascii=False))", [asXlsx(xlsx)])
  );
  expect(row).toEqual(["2026-09-15", "株式会社サンプル商店", 1100, 100, "課税仕入 10%", "receipt.pdf（1/2ページ）"]);
});
