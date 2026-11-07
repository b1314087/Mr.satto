import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { audit, convert, type Expect } from "../helpers/print-audit";

/**
 * Excel→PDF：印刷の再現性と内容の欠落の監査(28種類のExcel)。
 *
 * テスト用のExcelと期待値は tests/fixtures/static/excel-print-audit/(*.xlsx と *.expect.json。架空のデータのみ)。
 * tests/fixtures/excel-print-audit/generate_print_audit_fixtures.py が、OOXMLを直接書いてExcelを作り、
 * Excelの印刷の決まり(用紙・余白・倍率・ページ数に合わせる・改ページ・印刷範囲・印刷タイトル・非表示の行列)に沿って、
 * Mr.Sattoの計算とは別に、期待値を計算している。
 *
 * 確かめること:
 *  - ページ数、各ページの用紙の大きさ(PDFのページの大きさ)
 *  - セルごとの固有の文字(例 @J50)が、期待したページに、1回だけ出ること(欠落・重複・ページのずれが無いこと)
 *  - 印刷範囲の外・非表示の行列・非表示のシートの文字が出ないこと
 *  - 出た文字が、ページの紙の中にあり、実際に描かれていること(切り取られて見えない状態でないこと)
 *  - 画像・グラフ(色で見分ける)が、期待したページにあること、範囲の外のものが無いこと
 * Excel本体で印刷した結果とは直接比べていない(同じファイルをLibreOfficeでPDFにした結果とも見比べた)。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "excel-print-audit");

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".xlsx")).sort();

test.describe.configure({ mode: "parallel" });

for (const file of files) {
  const e: Expect = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".xlsx", ".expect.json")), "utf-8"));
  test(`${file.replace(".xlsx", "")} ${e.title}：ページ数・用紙・セルの文字の欠落/重複/ページ・画像とグラフ`, async ({ page }) => {
    test.setTimeout(240_000);
    const { pdf, screen } = await convert(page, path.join(DIR, file));
    const problems = await audit(pdf, screen, e);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
