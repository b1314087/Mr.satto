import { execFileSync } from "node:child_process";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, uploadFixture } from "../helpers/tool-runner";
import { DEFAULT_SPACE_CLEAN, cleanSpaces, spaceCleanOptionError } from "@/lib/excel/xlsx-space-clean";

/**
 * Excelスペース削除（総合改修 18）。
 * - 判定：半角・全角、先頭・末尾、文字と文字の間（1つにする・すべて消す・消さない）。セル内の改行は残す
 * - 画面：プレビューの件数、書き出したファイルで「文字のセルだけが変わり、数式・数値・日付・書式・列幅・結合セルが残る」こと、対象シートの指定
 */

function py(script: string, args: string[] = []): string {
  return execFileSync("python3", ["-c", script, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

plainTest.describe("判定", () => {
  const o = DEFAULT_SPACE_CLEAN;
  plainTest("既定：先頭・末尾の半角・全角を消し、続いた空白は1つにする（名前の間の1つは残す）", () => {
    plainExpect(cleanSpaces("　 山田　太郎  ", o)).toBe("山田　太郎");
    plainExpect(cleanSpaces("山田　　太郎", o)).toBe("山田　太郎");
    plainExpect(cleanSpaces("a  b", o)).toBe("a b");
  });
  plainTest("文字と文字の間：すべて消す・消さない", () => {
    plainExpect(cleanSpaces(" 山田　太郎 ", { ...o, middle: "remove" })).toBe("山田太郎");
    plainExpect(cleanSpaces(" 山田　　太郎 ", { ...o, middle: "keep" })).toBe("山田　　太郎");
  });
  plainTest("種類：半角だけ・全角だけ", () => {
    plainExpect(cleanSpaces("　 東京 　", { ...o, fullWidth: false })).toBe("　 東京 　");
    plainExpect(cleanSpaces(" 東京 ", { ...o, fullWidth: false })).toBe("東京");
    plainExpect(cleanSpaces("　東京　", { ...o, halfWidth: false })).toBe("東京");
    plainExpect(cleanSpaces(" 東京 ", { ...o, halfWidth: false })).toBe(" 東京 ");
  });
  plainTest("先頭だけ・末尾だけ。セル内の改行は残し、行ごとに整える", () => {
    plainExpect(cleanSpaces("  東京  ", { ...o, trailing: false, middle: "keep" })).toBe("東京  ");
    plainExpect(cleanSpaces("  東京  ", { ...o, leading: false, middle: "keep" })).toBe("  東京");
    plainExpect(cleanSpaces(" 1行目 \n 2行目 ", o)).toBe("1行目\n2行目");
  });
  plainTest("何も選ばないときは理由を返す", () => {
    plainExpect(spaceCleanOptionError({ ...o, halfWidth: false, fullWidth: false })).toContain("種類");
    plainExpect(spaceCleanOptionError({ ...o, leading: false, trailing: false, middle: "keep" })).toContain("場所");
    plainExpect(spaceCleanOptionError(o)).toBeNull();
  });
});

const MAKE = `
import sys, datetime
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook()
ws = wb.active
ws.title = "名簿"
ws.append(["氏名", "住所", "金額", "合計"])
ws.append(["　山田　　太郎 ", " 東京都 千代田区", 100, "=C2*2"])
ws.append(["佐藤", "大阪府", 200, '=" 空白 "&C3'])
ws["A2"].font = Font(bold=True)
ws.column_dimensions["B"].width = 28
ws["E2"] = datetime.date(2024, 4, 1)
ws["E2"].number_format = "yyyy/mm/dd"
ws["A5"] = "  結合  "
ws.merge_cells("A5:B5")
other = wb.create_sheet("別シート")
other["A1"] = "  そのまま  "
wb.save(sys.argv[1])
`;

const READ = `
import sys, json, datetime
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
ws = wb["名簿"]
def v(x):
    return x.isoformat()[:10] if isinstance(x, (datetime.date, datetime.datetime)) else x
print(json.dumps({
  "a2": ws["A2"].value, "b2": ws["B2"].value, "c2": ws["C2"].value, "d2": ws["D2"].value, "d3": ws["D3"].value,
  "e2": v(ws["E2"].value), "fmtE2": ws["E2"].number_format, "boldA2": bool(ws["A2"].font.b),
  "widthB": ws.column_dimensions["B"].width, "a5": ws["A5"].value,
  "merged": [str(r) for r in ws.merged_cells.ranges],
  "other": wb["別シート"]["A1"].value,
}, ensure_ascii=False))
`;

test.describe("Excelスペース削除の画面", () => {
  test("文字のセルだけ空白を整える。数式・数値・日付・書式・列幅・結合セルは保つ", async ({ page }) => {
    test.setTimeout(120_000);
    const src = test.info().outputPath("meibo.xlsx");
    py(MAKE, [src]);
    await page.goto("/tools/excel-space-remove");
    await uploadFixture(page, src);
    // 名簿：A2, B2, A5 ／ 別シート：A1 の4個
    await expect(page.getByTestId("space-count")).toHaveText("4個のセルの空白を整えます。");
    await expect(page.getByTestId("space-samples")).toContainText("□山田□□太郎␣");
    await expect(page.getByTestId("space-samples")).toContainText("山田□太郎");
    await page.getByTestId("space-run").click();
    await expect(page.getByTestId("space-result")).toContainText("4個のセルの空白を整えました");
    const out = test.info().outputPath("out.xlsx");
    const dl = await clickAndDownload(page, "Excelファイルをダウンロード");
    expect(dl.suggestedFilename()).toBe("meibo-空白削除.xlsx");
    await dl.saveAs(out);
    const r = JSON.parse(py(READ, [out]));
    expect(r.a2).toBe("山田　太郎");
    expect(r.b2).toBe("東京都 千代田区");
    expect(r.c2).toBe(100);
    expect(r.d2).toBe("=C2*2");
    expect(r.d3).toBe('=" 空白 "&C3'); // 数式の中の文字は変えない
    expect(r.e2).toBe("2024-04-01");
    expect(r.fmtE2).toBe("yyyy/mm/dd");
    expect(r.boldA2).toBe(true);
    expect(r.widthB).toBe(28);
    expect(r.a5).toBe("結合");
    expect(r.merged).toEqual(["A5:B5"]);
    expect(r.other).toBe("そのまま");
  });

  test("対象のシートを選ぶと、ほかのシートは変えない。種類・場所を外すと理由を出して保存できない", async ({ page }) => {
    test.setTimeout(120_000);
    const src = test.info().outputPath("meibo2.xlsx");
    py(MAKE, [src]);
    await page.goto("/tools/excel-space-remove");
    await uploadFixture(page, src);
    await expect(page.getByTestId("space-count")).toHaveText("4個のセルの空白を整えます。");
    await page.getByTestId("space-sheet-one").check();
    await page.getByTestId("space-sheet-select").selectOption({ label: "別シート" });
    await expect(page.getByTestId("space-count")).toHaveText("1個のセルの空白を整えます。");
    await page.getByTestId("space-half").uncheck();
    await page.getByTestId("space-full").uncheck();
    await expect(page.getByTestId("tool-preview")).toContainText("消す空白の種類（半角・全角）を1つ以上選んでください。");
    await expect(page.getByTestId("space-run")).toBeDisabled();
    await page.getByTestId("space-half").check();
    await page.getByTestId("space-run").click();
    await expect(page.getByTestId("space-result")).toContainText("1個のセルの空白を整えました");
    const out = test.info().outputPath("out2.xlsx");
    await (await clickAndDownload(page, "Excelファイルをダウンロード")).saveAs(out);
    const r = JSON.parse(py(READ, [out]));
    expect(r.other).toBe("そのまま");
    expect(r.a2).toBe("　山田　　太郎 "); // 名簿は変えない
    expect(r.a5).toBe("  結合  ");
  });
});
