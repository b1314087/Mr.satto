import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { parsePageSelection } from "@/lib/processors/browser/filled-pdf-to-excel";

/**
 * 記入済みPDF→Excel（自動抽出）の、スキャンしたPDFの読み取りのテスト。
 *
 * テスト用のPDFは、架空の申込者の表（日本語・電話番号・金額・罫線）を画像にして、文字情報のないPDFにしたもの
 * （tests/fixtures/scanned-forms）：
 *   scan_clean = 200dpi のきれいなスキャン／scan_skew = 150dpi・2.5度傾いた・ノイズあり／scan_multi = 2ページ／
 *   mixed = 文字情報の見出し＋表の画像（混在）／scan_low = 55dpi・ぼかし（読み取りが難しい）
 * ダウンロードした .xlsx を openpyxl で開き、セルの配置と文字を確かめる（「テストが通った」だけで合格にしない）。
 */

const DIR = path.join(__dirname, "..", "fixtures", "scanned-forms");
const pythonOk = (() => {
  try {
    execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function convert(page: Page, name: string, pages?: string) {
  await page.goto("/tools/filled-pdf-to-excel");
  await uploadFixture(page, path.join(DIR, name));
  if (pages) await page.getByTestId("filled-pdf-page-selection").fill(pages);
  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await expect(page.getByTestId("filled-pdf-page-methods")).toBeVisible({ timeout: 240_000 });
}

async function download(page: Page): Promise<{ sheets: Record<string, (string | number | null)[][]>; fills: string[] }> {
  const dl = await clickAndDownload(page, "Excelファイルをダウンロード");
  // openpyxl は拡張子で形式を判断するため、.xlsx を付けて保存し直す
  const file = `${(await dl.path())!}.xlsx`;
  await dl.saveAs(file);
  const out = execFileSync("python3", [
    "-c",
    `
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
sheets = {ws.title: [[c.value for c in row] for row in ws.iter_rows()] for ws in wb.worksheets}
ws = wb.worksheets[0]
fills = [c.coordinate for row in ws.iter_rows() for c in row if c.fill and c.fill.fill_type == "solid"]
print(json.dumps({"sheets": sheets, "fills": fills}, ensure_ascii=False, default=str))`,
    file,
  ]).toString();
  return JSON.parse(out);
}

const flat = (rows: (string | number | null)[][]) => rows.map((r) => r.map((v) => (v === null ? "" : String(v)).replace(/\s/g, "")));

test.describe("記入済みPDF→Excel：スキャンしたPDF", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test("ページ番号の指定を読み取る", () => {
    expect(parsePageSelection("1-3, 5", 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageSelection("２、４〜５", 6)).toEqual([2, 4, 5]);
    expect(parsePageSelection("0-2", 6)).toBeNull();
    expect(parsePageSelection("7", 6)).toBeNull();
    expect(parsePageSelection("a", 6)).toBeNull();
    expect(parsePageSelection("", 6)).toBeNull();
  });

  test("きれいなスキャン：表の行・列をそのままセルにし、日本語・電話番号・金額を読み取る", async ({ page }) => {
    await convert(page, "scan_clean.pdf");
    await expect(page.getByTestId("filled-pdf-page-methods").locator("li")).toHaveAttribute("data-method", "ocr");
    test.skip(!pythonOk, "openpyxl が無い環境");
    const x = await download(page);
    const rows = flat(x.sheets["読み取り結果"] ?? Object.values(x.sheets)[0]);
    const header = rows.findIndex((r) => r.includes("氏名"));
    expect(header, JSON.stringify(rows)).toBeGreaterThanOrEqual(0);
    expect(rows[header].filter(Boolean)).toEqual(["氏名", "住所", "電話番号", "金額"]);
    const body = rows.slice(header + 1).filter((r) => r.some(Boolean));
    expect(body).toHaveLength(4);
    const col = (name: string) => rows[header].indexOf(name);
    // 文字認識（Tesseract）は「一」を「—」と読むなど、漢字1〜2文字の読み違いがあり得る。4人中3人以上が正しく読めること
    const names = body.map((r) => r[col("氏名")]);
    expect(names.filter((n, i) => n === ["山田太郎", "佐藤花子", "鈴木一郎", "高橋美咲"][i]).length, names.join(",")).toBeGreaterThanOrEqual(3);
    expect(body.map((r) => r[col("電話番号")])).toEqual(["03-1234-5678", "06-2345-6789", "078-345-6789", "011-456-7890"]);
    expect(body.map((r) => r[col("金額")])).toEqual(["12800", "5400", "120000", "980"]);
    expect(body[2][col("住所")]).toContain("神戸市中央区");
  });

  test("傾いた・解像度の低いスキャン：傾きを直して読み取り、列がずれない", async ({ page }) => {
    await convert(page, "scan_skew.pdf");
    await expect(page.getByTestId("filled-pdf-page-methods")).toContainText("傾き");
    test.skip(!pythonOk, "openpyxl が無い環境");
    const x = await download(page);
    const rows = flat(Object.values(x.sheets)[0]);
    const header = rows.findIndex((r) => r.includes("氏名"));
    expect(header, JSON.stringify(rows)).toBeGreaterThanOrEqual(0);
    const body = rows.slice(header + 1).filter((r) => r.some(Boolean));
    expect(body).toHaveLength(4);
    const tel = rows[header].indexOf("電話番号");
    expect(body.filter((r) => /^0\d{1,3}-\d{3,4}-\d{4}$/.test(r[tel])).length).toBeGreaterThanOrEqual(3);
  });

  test("2ページのスキャン：両方のページを読み取り、ページの指定で1ページだけにもできる", async ({ page }) => {
    await convert(page, "scan_multi.pdf");
    await expect(page.getByTestId("filled-pdf-page-methods").locator("li")).toHaveCount(2);
    test.skip(!pythonOk, "openpyxl が無い環境");
    const all = flat(Object.values((await download(page)).sheets)[0]).map((r) => r.join("|"));
    expect(all.some((r) => r.includes("伊藤健"))).toBe(true);
    expect(all.some((r) => r.includes("山田太郎"))).toBe(true);

    await convert(page, "scan_multi.pdf", "2");
    await expect(page.getByTestId("filled-pdf-page-methods").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("filled-pdf-page-methods")).toContainText("2ページ目");
  });

  test("文字情報と画像の混在：見出しは文字情報から、表は画像の文字認識から読み取る", async ({ page }) => {
    await convert(page, "mixed.pdf");
    await expect(page.getByTestId("filled-pdf-page-methods").locator("li")).toHaveAttribute("data-method", "mixed");
    test.skip(!pythonOk, "openpyxl が無い環境");
    const text = flat(Object.values((await download(page)).sheets)[0]).map((r) => r.join("")).join("\n");
    expect(text).toContain("混在ページの見出し");
    expect(text).toContain("鈴木一郎");
    expect(text).toContain("120000");
  });

  test("読み取りが難しいスキャン：自信のないセルに色を付け、確認のシートにまとめる", async ({ page }) => {
    await convert(page, "scan_low.pdf");
    await expect(page.getByTestId("filled-pdf-low-confidence")).toBeVisible();
    await expect(page.locator("td[data-low]").first()).toBeVisible();
    test.skip(!pythonOk, "openpyxl が無い環境");
    const x = await download(page);
    expect(Object.keys(x.sheets)).toContain("読み取りの確認");
    expect(x.sheets["読み取りの確認"][0]).toEqual(["ファイル", "ページ", "セル", "読み取った文字", "信頼度（0〜100）"]);
    expect(x.sheets["読み取りの確認"].length).toBeGreaterThan(1);
    expect(x.fills.length).toBeGreaterThan(0);
  });

  test("読み取りの途中で中断できる", async ({ page }) => {
    await page.goto("/tools/filled-pdf-to-excel");
    await uploadFixture(page, path.join(DIR, "scan_multi.pdf"));
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await page.getByTestId("filled-pdf-cancel").click();
    await expect(page.getByTestId("filled-pdf-cancelled")).toBeVisible({ timeout: 60_000 });
    // 中断のあとも、もう一度読み取れる
    await page.getByRole("button", { name: "Excelに変換する" }).click();
    await expect(page.getByTestId("filled-pdf-page-methods")).toBeVisible({ timeout: 240_000 });
  });
});

test("文字情報のあるPDFは、これまでどおり文字情報から読み取る（OCRしない）", async ({ page }) => {
  await page.goto("/tools/filled-pdf-to-excel");
  await uploadFixture(page, path.join(DIR, "text_table.pdf"));
  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await expect(page.getByTestId("filled-pdf-page-methods")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("filled-pdf-page-methods").locator("li").first()).toHaveAttribute("data-method", "text-layer");
});
