import { test, expect } from "../fixtures/premium-test";
import fs from "node:fs";
import path from "node:path";
import { audit, convert, type Expect } from "../helpers/print-audit";

/**
 * Excel→PDF：ページ単位の再現性(ページ数・ページの境目・ページの順・余白の内側に収まること)の検証(22種類のExcel)。
 *
 * テスト用のExcelと期待値は tests/fixtures/static/excel-page-fidelity/(*.xlsx と *.expect.json。架空のデータのみ)。
 * tests/fixtures/excel-page-fidelity/generate_page_fidelity_fixtures.py が、Excelの印刷の決まりに沿って、Mr.Sattoの計算とは別に期待値を作る。
 * 確かめること(tests/helpers/print-audit.ts):
 *  - ページ数・各ページの用紙の大きさ
 *  - セルごとの固有の文字が、期待したページに1回だけ出ること(ページの境目のずれ・欠落・重複・ページの順の違いが無いこと)
 *  - 文字が紙の中・余白の内側にあり、実際に描かれていること
 *  - 印刷範囲の外・非表示の行列・非表示のシートの文字が出ないこと、画像・グラフが期待したページにあること
 * Microsoft Excel本体で印刷した結果とは直接比べていない(期待値はExcelの決まりからの計算。LibreOfficeとの比較は
 * tests/fixtures/excel-page-fidelity/compare_with_libreoffice.py で別に行う)。
 */

const DIR = path.join(__dirname, "..", "fixtures", "static", "excel-page-fidelity");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".xlsx")).sort();

test.describe.configure({ mode: "parallel" });

for (const file of files) {
  const e: Expect = JSON.parse(fs.readFileSync(path.join(DIR, file.replace(".xlsx", ".expect.json")), "utf-8"));
  test(`${file.replace(".xlsx", "")} ${e.title}：ページ数・ページの境目・ページの順・欠落`, async ({ page }) => {
    test.setTimeout(240_000);
    const { pdf, screen } = await convert(page, path.join(DIR, file));
    const problems = await audit(pdf, screen, e);
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
