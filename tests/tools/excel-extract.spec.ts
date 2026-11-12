import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { cellMatches, findExtractTargets, foldWidth } from "@/lib/processors/browser/excel-extract";

/**
 * Excel行・列抽出（次期機能追加 2）。
 * - 判定（部分一致・日本語・大文字小文字・見出し）
 * - 画面：プレビューの件数・行の抽出・列の抽出・複数シート・書式と数式の保持・出力の読み直し
 */

function py(script: string, args: string[] = []): string {
  return execFileSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

plainTest.describe("判定（プレビューと書き出しで共通）", () => {
  const rows = [
    ["氏名", "住所", "メモ"],
    ["山田", "東京都千代田区", "ABC"],
    ["佐藤", "大阪府", "abc"],
    ["鈴木", "東京都港区", ""],
  ];

  plainTest("部分一致・日本語：「東京」を含む行を残す（見出しを残す・残さない）", () => {
    plainExpect(findExtractTargets({ rows, query: "東京", axis: "rows", caseSensitive: false, keepHeader: true }).kept).toEqual([0, 1, 3]);
    plainExpect(findExtractTargets({ rows, query: "東京", axis: "rows", caseSensitive: false, keepHeader: false }).kept).toEqual([1, 3]);
  });

  plainTest("大文字・小文字：既定は区別しない。区別するを選ぶと区別する", () => {
    plainExpect(findExtractTargets({ rows, query: "abc", axis: "rows", caseSensitive: false, keepHeader: false }).kept).toEqual([1, 2]);
    plainExpect(findExtractTargets({ rows, query: "abc", axis: "rows", caseSensitive: true, keepHeader: false }).kept).toEqual([2]);
    plainExpect(cellMatches("ABC", "abc", false)).toBe(true);
    plainExpect(cellMatches("ABC", "abc", true)).toBe(false);
  });

  plainTest("列の抽出：文字を含む列だけ（見出しの列は、選んだときだけ）", () => {
    plainExpect(findExtractTargets({ rows, query: "東京", axis: "columns", caseSensitive: false, keepHeader: false }).kept).toEqual([1]);
    plainExpect(findExtractTargets({ rows, query: "東京", axis: "columns", caseSensitive: false, keepHeader: true }).kept).toEqual([0, 1]);
  });

  plainTest("一致が無いときは、見出しも含めて何も残さない（空のファイルを作らない）", () => {
    const r = findExtractTargets({ rows, query: "福岡", axis: "rows", caseSensitive: false, keepHeader: true });
    plainExpect(r.kept).toEqual([]);
    plainExpect(r.matchedCount).toBe(0);
  });
});

const MAKE = `
import sys, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
wb = Workbook()
ws = wb.active
ws.title = "名簿"
ws.append(["氏名", "住所", "金額", "2倍"])
ws.append(["山田", "東京都千代田区", 100, "=C2*2"])
ws.append(["佐藤", "大阪府大阪市", 200, "=C3*2"])
ws.append(["鈴木", "東京都港区", 300, "=C4*2"])
ws.append(["田中", "福岡県", 400, "=C5*2"])
ws["A1"].font = Font(bold=True)
ws["B4"].fill = PatternFill("solid", fgColor="FFFF00")
ws.column_dimensions["B"].width = 30
ws["E2"] = datetime.date(2024, 4, 1)
ws["E2"].number_format = "yyyy/mm/dd"
other = wb.create_sheet("別シート")
other["A1"] = "東京"
other["A2"] = "そのまま"
wb.save(sys.argv[1])
`;

const READ = `
import sys, json, datetime
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
ws = wb["名簿"]
def v(x):
    return x.isoformat()[:10] if isinstance(x, (datetime.date, datetime.datetime)) else x
rows = [[v(c.value) for c in r] for r in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=ws.max_column)]
fill = ws["B3"].fill.fgColor.rgb if ws["B3"].fill and ws["B3"].fill.fill_type else None
print(json.dumps({
  "sheets": wb.sheetnames,
  "rows": rows,
  "boldA1": bool(ws["A1"].font.b),
  "fillB3": fill,
  "widthB": ws.column_dimensions["B"].width,
  "fmtE2": ws["E2"].number_format,
  "other": [wb["別シート"]["A1"].value, wb["別シート"]["A2"].value],
}, ensure_ascii=False))
`;

test.describe("Excel行・列抽出の画面", () => {
  test("行を抽出：「東京」を含む行（と見出し）だけを書き出す。値・書式・数式（参照の調整）・列の幅・ほかのシートを保つ", async ({ page }) => {
    test.setTimeout(120_000);
    const src = test.info().outputPath("meibo.xlsx");
    py(MAKE, [src]);
    await page.goto("/tools/excel-extract");
    await uploadFixture(page, src);
    await expect(page.getByTestId("excel-extract-settings")).toBeVisible();
    await page.getByTestId("excel-extract-query").fill("東京");
    await expect(page.getByTestId("excel-extract-count")).toContainText("全5行のうち、2行が「東京」を含みます");
    await expect(page.getByTestId("excel-extract-count")).toContainText("見出しを含めて3行を書き出します");
    // プレビュー：残る行だけ（元の行番号つき）。文字を含むセルに色
    const preview = page.getByTestId("tool-preview");
    await expect(preview).toContainText("東京都千代田区");
    await expect(preview).toContainText("東京都港区");
    await expect(preview).not.toContainText("大阪府大阪市");
    await expect(preview.locator("td.bg-blue-100")).toHaveCount(2);
    await page.getByTestId("excel-extract-run").click();
    await waitForSuccess(page, "抽出が完了しました");
    await expect(page.getByTestId("excel-extract-result")).toContainText("シート「名簿」から2行を抽出しました（3行 × 5列）");
    const out = test.info().outputPath("out.xlsx");
    await (await clickAndDownload(page, "Excelファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ, [out]));
    expect(r.sheets).toEqual(["名簿", "別シート"]);
    expect(r.rows).toEqual([
      ["氏名", "住所", "金額", "2倍", null],
      ["山田", "東京都千代田区", 100, "=C2*2", "2024-04-01"],
      ["鈴木", "東京都港区", 300, "=C3*2", null], // 4行目→3行目。数式の参照も3行目に
    ]);
    expect(r.boldA1).toBe(true);
    expect(r.fillB3).toBe("00FFFF00"); // 4行目の塗りつぶしが、移った先（3行目）に残る
    expect(r.widthB).toBe(30);
    expect(r.fmtE2).toBe("yyyy/mm/dd");
    expect(r.other).toEqual(["東京", "そのまま"]); // ほかのシートは変更しない
  });

  test("列を抽出：「東京」を含む列だけを書き出す（見出しの列を残さない設定）", async ({ page }) => {
    test.setTimeout(120_000);
    const src = test.info().outputPath("meibo-col.xlsx");
    py(MAKE, [src]);
    await page.goto("/tools/excel-extract");
    await uploadFixture(page, src);
    await page.getByTestId("excel-extract-axis-columns").click();
    await expect(page.getByTestId("excel-extract-keep-header").locator("xpath=..")).toContainText("A列（見出し）も残す");
    await page.getByTestId("excel-extract-keep-header").uncheck();
    await page.getByTestId("excel-extract-query").fill("東京");
    await expect(page.getByTestId("excel-extract-count")).toContainText("全5列のうち、1列が「東京」を含みます");
    await page.getByTestId("excel-extract-run").click();
    await waitForSuccess(page, "抽出が完了しました");
    const out = test.info().outputPath("out-col.xlsx");
    await (await clickAndDownload(page, "Excelファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ.replace('fill = ws["B3"]', 'fill = ws["A3"]').replace('"widthB": ws.column_dimensions["B"].width', '"widthB": ws.column_dimensions["A"].width').replace('"fmtE2": ws["E2"].number_format', '"fmtE2": None'), [out]));
    expect(r.rows).toEqual([["住所"], ["東京都千代田区"], ["大阪府大阪市"], ["東京都港区"], ["福岡県"]]);
    expect(r.widthB).toBe(30); // B列の幅が、A列（移った先）に残る
  });

  test("複数シート：選んだシートだけを抽出する。一致が無いときは実行できず、理由を出す", async ({ page }) => {
    test.setTimeout(120_000);
    const src = test.info().outputPath("meibo-sheets.xlsx");
    py(MAKE, [src]);
    await page.goto("/tools/excel-extract");
    await uploadFixture(page, src);
    await page.getByTestId("excel-extract-query").fill("福岡");
    await expect(page.getByTestId("excel-extract-count")).toContainText("1行が「福岡」を含みます");
    await page.getByRole("tab", { name: "別シート" }).click();
    await expect(page.getByTestId("excel-extract-count")).toContainText("「福岡」を含む行はありません（シート「別シート」）");
    await expect(page.getByTestId("excel-extract-run")).toBeDisabled();
    await expect(page.getByTestId("tool-preview")).toContainText("ほかのシートは変更せずに、そのまま書き出します");
  });
});

plainTest.describe("全角・半角と結合セル（総合改修 29）", () => {
  plainTest("全角・半角：既定は区別しない（Ａ＝A、１＝1、ｱ＝ア、全角の空白＝半角の空白）。区別するを選ぶと区別する", () => {
    plainExpect(foldWidth("ＡＢＣ１２３　ｱｲｳﾊﾞ")).toBe("ABC123 アイウバ");
    plainExpect(cellMatches("ＡＢＣ商事", "abc", false)).toBe(true);
    plainExpect(cellMatches("ABC商事", "ＡＢＣ", false)).toBe(true);
    plainExpect(cellMatches("ｶﾞｽ代", "ガス", false)).toBe(true);
    plainExpect(cellMatches("ＡＢＣ商事", "ABC", false, true)).toBe(false);
    plainExpect(cellMatches("ＡＢＣ商事", "ＡＢＣ", false, true)).toBe(true);
    // 大文字・小文字の区別と組み合わせる
    plainExpect(cellMatches("ａｂｃ", "ABC", true)).toBe(false);
    plainExpect(cellMatches("ａｂｃ", "abc", true)).toBe(true);
  });

  plainTest("結合セル：一致したセルが結合の中にあれば、結合している範囲の行（列）をまとめて残す。空のセル・空の行は一致しない", () => {
    const rows = [
      ["部署", "氏名"],
      ["営業部", "山田"],
      ["", "佐藤"], // A2:A3 が結合（営業部）
      ["", ""], // 空の行
      ["総務部", "鈴木"],
    ];
    const merges = [{ r1: 1, c1: 0, r2: 2, c2: 0 }];
    plainExpect(findExtractTargets({ rows, query: "営業", axis: "rows", caseSensitive: false, keepHeader: true, merges }).kept).toEqual([0, 1, 2]);
    // 結合を考えないと、結合の途中で切れてしまう
    plainExpect(findExtractTargets({ rows, query: "営業", axis: "rows", caseSensitive: false, keepHeader: true }).kept).toEqual([0, 1]);
    // 空の行は一致しない
    plainExpect(findExtractTargets({ rows, query: "", axis: "rows", caseSensitive: false, keepHeader: false, merges }).kept).toEqual([]);
  });
});

const MAKE_MERGED = `
import sys
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "名簿"
ws.append(["部署", "氏名"])
ws.append(["営業部", "山田"])
ws.append([None, "佐藤"])
ws.append([None, None])
ws.append(["総務部", "鈴木"])
ws.append(["ＥＩＧＹＯ", "田中"])
ws.merge_cells("A2:A3")
wb.save(sys.argv[1])
`;

test("結合セルが一致したときは、結合している行をまとめて書き出し、結合も保つ。全角の英字も、既定では半角で探せる", async ({ page }) => {
  test.setTimeout(120_000);
  const src = test.info().outputPath("merged.xlsx");
  py(MAKE_MERGED, [src]);
  await page.goto("/tools/excel-extract");
  await uploadFixture(page, src);
  await page.getByTestId("excel-extract-query").fill("営業");
  await expect(page.getByTestId("excel-extract-count")).toContainText("見出しを含めて3行を書き出します");
  await expect(page.getByTestId("excel-extract-match-note")).toContainText("全角と半角は同じ文字として探します");
  await page.getByTestId("excel-extract-run").click();
  await waitForSuccess(page, "抽出が完了しました");
  const out = test.info().outputPath("merged-out.xlsx");
  await (await clickAndDownload(page, "Excelファイルをダウンロード")).saveAs(out);
  const r = JSON.parse(
    py(
      `
import sys, json
from openpyxl import load_workbook
ws = load_workbook(sys.argv[1])["名簿"]
print(json.dumps({"rows": [[c.value for c in r] for r in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=2)], "merged": [str(m) for m in ws.merged_cells.ranges]}, ensure_ascii=False))
`,
      [out]
    )
  );
  expect(r.rows).toEqual([
    ["部署", "氏名"],
    ["営業部", "山田"],
    [null, "佐藤"],
  ]);
  expect(r.merged).toEqual(["A2:A3"]);

  // 全角の英字（ＥＩＧＹＯ）も、半角の「eigyo」で見つかる。区別するを選ぶと見つからない
  await page.keyboard.press("Escape");
  await page.getByTestId("excel-extract-query").fill("eigyo");
  await expect(page.getByTestId("excel-extract-count")).toContainText("1行が「eigyo」を含みます");
  await page.getByTestId("excel-extract-width").check();
  await expect(page.getByTestId("excel-extract-count")).toContainText("ありません");
});
