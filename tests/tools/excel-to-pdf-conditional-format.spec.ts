import { test as baseTest, expect } from "@playwright/test";
import { test } from "../fixtures/premium-test";
import { evaluateConditionalFormats, type ConditionalRule, type DxfStyle } from "@/lib/excel/conditional-format";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, waitForSuccess, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { getFillColorsUsed } from "../helpers/pdf-inspect";
import { buildMinimalXlsx } from "../fixtures/xlsx-writer";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import fs from "node:fs";
import path from "node:path";

/**
 * Excel→PDF: 条件付き書式（セルの値に応じて背景色・文字色・太字が変わるExcelの設定）の再現テスト。
 *
 * 以前は<conditionalFormatting>を一切読み取らず、Excelでは土日・休業日の行が濃いグレーなのに
 * PDFでは白いままだった。
 *
 * 1. 判定ロジック（純粋関数）のテスト: 常に実行される。
 * 2. 画面のテスト: 条件付き書式を埋め込んだxlsxを変換し、PDFに条件付き書式の色が現れることを確認する。
 */

const DXF: DxfStyle = { fillRgb: "#7f7f7f", fontRgb: "#ffffff", bold: false };

function rule(partial: Partial<ConditionalRule> & Pick<ConditionalRule, "formulas">): ConditionalRule {
  return {
    type: "expression",
    ranges: [{ startRow: 6, startCol: 1, endRow: 8, endCol: 2 }],
    baseRow: 6,
    baseCol: 1,
    operator: null,
    text: null,
    priority: 1,
    stopIfTrue: false,
    dxf: DXF,
    ...partial,
  };
}

/** 実際のファイルと同じ形: 隠し列U(20)・V(21)に曜日と休日フラグがある */
function sheetValue(row: number, col: number): unknown {
  const table: Record<string, unknown> = {
    "6:20": "土",
    "6:21": null,
    "7:20": "月",
    "7:21": 1, // 祝日
    "8:20": "火",
    "8:21": null,
  };
  return table[`${row}:${col}`] ?? null;
}

const BOUNDS = { startRow: 0, endRow: 20, startCol: 0, endCol: 25 };

baseTest.describe("条件付き書式の判定（純粋関数）", () => {
  baseTest("休日フラグ($V7=1)の行だけが対象になり、相対参照が行ごとにずれる", () => {
    const r = evaluateConditionalFormats([rule({ formulas: ["$V7=1"] })], sheetValue, BOUNDS);
    // 7行目(0始まりで6)は$V7=1ではない。8行目(0始まりで7)だけが$V8=1で成立する
    expect(r.fills.has("6:1")).toBe(false);
    expect(r.fills.get("7:1")).toBe("#7f7f7f");
    expect(r.fills.get("7:2")).toBe("#7f7f7f");
    expect(r.fills.has("8:1")).toBe(false);
    expect(r.fontColors.get("7:1")).toBe("#ffffff");
    expect(r.unsupportedCount).toBe(0);
  });

  baseTest('土日の判定(OR($U7="土",$U7="日"))が使える', () => {
    const r = evaluateConditionalFormats([rule({ formulas: ['OR($U7="土",$U7="日")'] })], sheetValue, BOUNDS);
    expect(r.fills.get("6:1")).toBe("#7f7f7f");
    expect(r.fills.has("7:1")).toBe(false);
    expect(r.fills.has("8:1")).toBe(false);
  });

  baseTest("優先度の高い規則の色が勝ち、stopIfTrueで以降の規則は適用されない", () => {
    const high: DxfStyle = { fillRgb: "#ff0000", fontRgb: null, bold: true };
    const r = evaluateConditionalFormats(
      [
        rule({ formulas: ['$U7="土"'], priority: 2 }),
        rule({ formulas: ['$U7="土"'], priority: 1, dxf: high, stopIfTrue: true }),
      ],
      sheetValue,
      BOUNDS
    );
    expect(r.fills.get("6:1")).toBe("#ff0000");
    expect(r.bold.get("6:1")).toBe(true);
    // stopIfTrueにより、優先度の低い規則の文字色(白)は適用されない
    expect(r.fontColors.has("6:1")).toBe(false);
  });

  baseTest("未対応の関数・規則の種類は、色を付けずに「再現できなかった」件数として数える", () => {
    const r = evaluateConditionalFormats(
      [
        rule({ formulas: ["SUMPRODUCT($V7)>0"] }),
        rule({ type: "unsupported", formulas: [] }),
      ],
      sheetValue,
      BOUNDS
    );
    expect(r.fills.size).toBe(0);
    expect(r.unsupportedCount).toBe(2);
  });

  baseTest("セルの値で判定する規則(cellIs)と、空白・エラー値の扱い", () => {
    const equal = evaluateConditionalFormats(
      [rule({ type: "cellIs", operator: "equal", formulas: ['"火"'], ranges: [{ startRow: 8, startCol: 20, endRow: 8, endCol: 20 }], baseRow: 8, baseCol: 20 })],
      sheetValue,
      BOUNDS
    );
    expect(equal.fills.get("8:20")).toBe("#7f7f7f");
    // 文字列を足し算するような#VALUE!になる式は、そのセルだけ成立しない(規則全体は未対応にしない)
    const err = evaluateConditionalFormats([rule({ formulas: ["$U7+1>0"] })], sheetValue, BOUNDS);
    expect(err.fills.size).toBe(0);
    expect(err.unsupportedCount).toBe(0);
  });
});

const CF_XLSX = path.join(fixtures.dir.generated, "excel-conditional-format.xlsx");

test.beforeAll(() => {
  // A列が「x」の行だけ、条件付き書式で青い背景(#0000ff)＋白文字になるxlsx。
  // 条件付き書式はテスト用のxlsx生成関数では書けないため、生成したxlsxのXMLへ直接埋め込む。
  const base = buildMinimalXlsx([
    {
      name: "Sheet1",
      rows: [[{ value: "x" }, { value: "a" }], [{ value: "y" }, { value: "b" }], [{ value: "x" }, { value: "c" }]],
    },
  ]);
  const files = unzipSync(base);
  const sheetPath = "xl/worksheets/sheet1.xml";
  const stylesPath = "xl/styles.xml";
  const sheetXml = strFromU8(files[sheetPath]).replace(
    "</sheetData>",
    '</sheetData><conditionalFormatting sqref="A1:B3"><cfRule type="expression" dxfId="0" priority="1"><formula>$A1="x"</formula></cfRule></conditionalFormatting>'
  );
  const stylesXml = strFromU8(files[stylesPath]).replace(
    "</styleSheet>",
    '<dxfs count="1"><dxf><font><color rgb="FFFFFFFF"/></font><fill><patternFill><bgColor rgb="FF0000FF"/></patternFill></fill></dxf></dxfs></styleSheet>'
  );
  files[sheetPath] = strToU8(sheetXml);
  files[stylesPath] = strToU8(stylesXml);
  fs.mkdirSync(fixtures.dir.generated, { recursive: true });
  fs.writeFileSync(CF_XLSX, zipSync(files));
});

test("Excelの条件付き書式の背景色がPDFへ反映される", async ({ page }) => {
  await page.goto("/tools/excel-to-pdf");
  await uploadFixture(page, CF_XLSX);
  const ready = await page
    .getByRole("button", { name: "PDFに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await page.reload();
    await uploadFixture(page, CF_XLSX);
    await expect(page.getByRole("button", { name: "PDFに変換する" })).toBeVisible({ timeout: 20_000 });
  }
  await page.getByRole("button", { name: "PDFに変換する" }).click();
  await waitForSuccess(page, "完了");
  const download = await clickAndDownload(page, "PDFをダウンロード");
  const { path: pdfPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1 });

  const colors = await getFillColorsUsed(pdfPath, 1);
  expect(Array.from(colors), "条件付き書式の背景色(#0000ff)がPDFへ反映されていません").toContain("#0000ff");
});
