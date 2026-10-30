import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { buildMinimalXlsx, type XlsxCellSpec } from "../fixtures/xlsx-writer";
import { assertDownloadedFile, clickAndDownload, uploadFixture, waitForSuccess } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import {
  MERGE_MAX_ROWS,
  MERGE_MAX_SOURCES,
  MERGE_SOURCE_COLUMN_NAME,
  MergeError,
  headerKey,
  mergeTables,
  type MergeOptions,
  type MergeSource,
} from "@/lib/excel/merge-tables";
import { classifyMergeFile } from "@/lib/processors/browser/excel-merge";
import type { XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

/**
 * Excelファイル結合（excel-merge）のテスト。
 * 1. 結合の規則（純粋な関数）の単体テスト
 * 2. 実際にファイルを選んで、結合・ダウンロードまで行う画面テスト（内容まで確認する）
 * 3. 異常系と、ファイルの内容が外部へ送信されないことの確認
 */

const NONE: MergeOptions = { addSourceColumn: false, removeDuplicates: false };
const src = (label: string, rows: XlsxCellValue[][]): MergeSource => ({ label, rows });

// ---------------------------------------------------------------------------
// 1. 結合の規則
// ---------------------------------------------------------------------------
plainTest.describe("excel-merge: 結合の規則（mergeTables）", () => {
  plainTest("見出しの名前で列を揃え、他のファイルに無い列は右に足して空にする", () => {
    const r = mergeTables(
      [
        src("a", [["氏名", "部署", "年齢"], ["山田", "営業", 30], ["佐藤", "総務", 41]]),
        src("b", [["部署", "氏名", "メール"], ["開発", "鈴木", "s@example.test"]]),
      ],
      NONE
    );
    plainExpect(r.header).toEqual(["氏名", "部署", "年齢", "メール"]);
    plainExpect(r.rows).toEqual([
      ["山田", "営業", 30, null],
      ["佐藤", "総務", 41, null],
      ["鈴木", "開発", null, "s@example.test"],
    ]);
    plainExpect(r.rowSourceIndex).toEqual([0, 0, 1]);
    plainExpect(r.columns.map((c) => c.presentIn)).toEqual([
      [true, true],
      [true, true],
      [true, false],
      [false, true],
    ]);
    plainExpect(r.stats.inputRows).toEqual([2, 1]);
    plainExpect(r.stats.addedColumns).toBe(1);
  });

  plainTest("全角・半角、前後や途中の空白の違いは同じ列として扱い、結合後の表記は最初のファイルのもの", () => {
    plainExpect(headerKey(" ＡＢＣ　１２３ ")).toBe(headerKey("ABC 123"));
    const r = mergeTables(
      [src("a", [["ＩＤ", "名前"], [1, "x"]]), src("b", [["ID ", " 名前"], [2, "y"]])],
      NONE
    );
    plainExpect(r.header).toEqual(["ＩＤ", "名前"]);
    plainExpect(r.rows).toEqual([[1, "x"], [2, "y"]]);
  });

  plainTest("見出しが空の列は列記号で名前を付け、同じ表の中で重なる見出しには番号を付ける。見出しより右のデータも失わない", () => {
    const r = mergeTables(
      [
        src("a", [["氏名", "", "氏名"], ["山田", "x", "y", "はみ出し"]]),
        src("b", [["氏名"], ["佐藤"]]),
      ],
      NONE
    );
    plainExpect(r.header).toEqual(["氏名", "列B", "氏名(2)", "列D"]);
    plainExpect(r.rows[0]).toEqual(["山田", "x", "y", "はみ出し"]);
    plainExpect(r.rows[1]).toEqual(["佐藤", null, null, null]);
  });

  plainTest("完全に空の行は取り除き、見出しの前にある空行は読み飛ばす。取り除いた数を数える", () => {
    const r = mergeTables(
      [
        src("a", [[null, null], ["氏名", "年齢"], ["山田", 30], [null, ""], [" ", null], ["佐藤", 41]]),
        src("b", [["氏名", "年齢"], ["鈴木", 25]]),
      ],
      NONE
    );
    plainExpect(r.rows.map((x) => x[0])).toEqual(["山田", "佐藤", "鈴木"]);
    plainExpect(r.stats.blankRowsSkipped).toBe(2);
    plainExpect(r.stats.inputRows).toEqual([2, 1]);
  });

  plainTest("結合元の列は右端に足す。同じ名前の列が既にあるときは番号を付けて重ならない", () => {
    const r = mergeTables([src("a.xlsx", [["氏名"], ["山田"]]), src("b.csv", [["氏名"], ["佐藤"]])], {
      ...NONE,
      addSourceColumn: true,
    });
    plainExpect(r.header).toEqual(["氏名", MERGE_SOURCE_COLUMN_NAME]);
    plainExpect(r.rows).toEqual([["山田", "a.xlsx"], ["佐藤", "b.csv"]]);
    plainExpect(r.columns[1].isSource).toBe(true);

    const clash = mergeTables([src("a", [["氏名", "結合元"], ["山田", "x"]]), src("b", [["氏名", "結合元"], ["佐藤", "y"]])], {
      ...NONE,
      addSourceColumn: true,
    });
    plainExpect(clash.header).toEqual(["氏名", "結合元", "結合元(2)"]);
    plainExpect(clash.rows[0]).toEqual(["山田", "x", "a"]);
  });

  plainTest("同じ行を除く: 見た目の値が同じ行の2行目以降を除き、最初の行を残す。結合元の列は比べない", () => {
    const r = mergeTables(
      [
        src("a", [["コード", "名前"], [123, "山田"], ["456", "佐藤"]]),
        src("b", [["コード", "名前"], ["123", " 山田 "], [456, "佐藤"], [789, "鈴木"]]),
      ],
      { addSourceColumn: true, removeDuplicates: true }
    );
    // 数値の123と文字の"123"、前後の空白の違いは、同じ値として扱う
    plainExpect(r.rows).toEqual([[123, "山田", "a"], ["456", "佐藤", "a"], [789, "鈴木", "b"]]);
    plainExpect(r.stats.duplicatesRemoved).toBe(2);
    // 除かないときは全行が残る
    plainExpect(mergeTables([src("a", [["x"], [1]]), src("b", [["x"], [1]])], NONE).rows).toHaveLength(2);
  });

  plainTest("日付は値を保ち、重複の判定では年-月-日の見た目で比べる", () => {
    const d1 = new Date(2026, 3, 1);
    const d2 = new Date(2026, 3, 1, 9, 30);
    const r = mergeTables([src("a", [["日付"], [d1]]), src("b", [["日付"], [d2], [new Date(2026, 3, 2)]])], {
      ...NONE,
      removeDuplicates: true,
    });
    plainExpect(r.rows).toHaveLength(2);
    plainExpect(r.rows[0][0]).toBe(d1);
  });

  plainTest("入力の表は書き換えない（読み取り専用にしても処理できる）", () => {
    const a = Object.freeze([Object.freeze(["氏名", "年齢"]), Object.freeze(["山田", 30])]) as unknown as XlsxCellValue[][];
    const b = Object.freeze([Object.freeze(["氏名"]), Object.freeze(["佐藤"])]) as unknown as XlsxCellValue[][];
    const r = mergeTables([src("a", a), src("b", b)], { addSourceColumn: true, removeDuplicates: true });
    plainExpect(r.rows).toHaveLength(2);
    plainExpect(a[1]).toEqual(["山田", 30]);
  });

  plainTest("異常系: 件数が足りない・多すぎる、表が空、結合後の行数が上限を超える", () => {
    plainExpect(() => mergeTables([src("a", [["x"], [1]])], NONE)).toThrow(MergeError);
    const many = Array.from({ length: MERGE_MAX_SOURCES + 1 }, (_, i) => src(`f${i}`, [["x"], [i]]));
    plainExpect(() => mergeTables(many, NONE)).toThrow(`${MERGE_MAX_SOURCES}件まで`);
    plainExpect(() => mergeTables([src("空.xlsx", [[null], []]), src("b", [["x"], [1]])], NONE)).toThrow("「空.xlsx」に表のデータがありません");
    plainExpect(() => mergeTables([src("空.xlsx", []), src("b", [["x"], [1]])], NONE)).toThrow(MergeError);
  });

  plainTest("見出しだけの表は、列だけを持つ結果になる（データ行は0行）", () => {
    const r = mergeTables([src("a", [["氏名", "年齢"]]), src("b", [["氏名", "年齢"]])], NONE);
    plainExpect(r.header).toEqual(["氏名", "年齢"]);
    plainExpect(r.rows).toHaveLength(0);
  });

  plainTest("行数の上限（Excelの1シートの行数）を超えると、結合できない理由を示す", () => {
    plainTest.setTimeout(120_000);
    const big: XlsxCellValue[][] = [["x"]];
    for (let i = 0; i < MERGE_MAX_ROWS; i++) big.push([i]);
    plainExpect(() => mergeTables([src("big", big), src("one", [["x"], [1]])], NONE)).toThrow("結合後の行数が多すぎます");
  });

  plainTest("ファイルの種類の判定: .xlsx・.csvは対象、.xlsは案内、それ以外は対象外", () => {
    plainExpect(classifyMergeFile({ name: "a.xlsx", type: "" })).toBe("excel");
    plainExpect(classifyMergeFile({ name: "A.CSV", type: "" })).toBe("csv");
    plainExpect(classifyMergeFile({ name: "a", type: "text/csv" })).toBe("csv");
    plainExpect(classifyMergeFile({ name: "old.xls", type: "" })).toBe("legacy-excel");
    plainExpect(classifyMergeFile({ name: "a.pdf", type: "application/pdf" })).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// 2. 画面（実際にファイルを選んで、結合・ダウンロードまで）
// ---------------------------------------------------------------------------
const cell = (value: string | number): XlsxCellSpec => ({ value });

let dir: string;
const files: Record<string, string> = {};

function writeXlsx(name: string, sheets: { name: string; rows: (string | number | null)[][] }[]): string {
  const bytes = buildMinimalXlsx(
    sheets.map((s) => ({ name: s.name, rows: s.rows.map((r) => r.map((v) => (v === null ? null : cell(v)))) }))
  );
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "excel-merge-"));
  files.a = writeXlsx("list-a.xlsx", [
    { name: "名簿", rows: [["氏名", "部署", "年齢"], ["山田太郎", "営業", 30], ["佐藤花子", "総務", 41]] },
  ]);
  files.b = writeXlsx("list-b.xlsx", [
    { name: "名簿", rows: [["部署", "氏名", "メール"], ["開発", "鈴木一郎", "suzuki@example.test"]] },
  ]);
  files.c = path.join(dir, "list-c.csv");
  fs.writeFileSync(files.c, "氏名,年齢\n高橋次郎,28\n", "utf8");
  files.multi = writeXlsx("multi.xlsx", [
    { name: "1月", rows: [["氏名", "金額"], ["山田太郎", 100]] },
    { name: "2月", rows: [["氏名", "金額"], ["佐藤花子", 200]] },
  ]);
  files.empty = writeXlsx("empty.xlsx", [{ name: "空", rows: [[null, null]] }]);
  files.legacy = path.join(dir, "old.xls");
  fs.writeFileSync(files.legacy, "dummy");
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function uploadAndWaitPreview(page: import("@playwright/test").Page, paths: string[]) {
  await page.goto("/tools/excel-merge");
  const preview = page.getByTestId("tool-preview");
  await uploadWhenReady(page, paths, preview, { readyTimeoutMs: 30_000 });
  return preview;
}

test("excel-merge: ExcelとCSVを、見出しの名前で列を揃えて結合し、内容どおりのExcelをダウンロードできる", async ({ page }) => {
  const preview = await uploadAndWaitPreview(page, [files.a, files.b, files.c]);
  await expect(page.getByRole("table", { name: "列の対応" })).toContainText("メール");
  await expect(preview).toContainText("結合後: 4行 × 4列");
  await expect(preview).toContainText("1つ目のファイルに無い列が1列あります");

  await page.getByLabel(/結合元」の列を足す/).check();
  await page.getByRole("button", { name: "3件を結合する" }).click();
  await waitForSuccess(page, "結合が完了しました");

  const download = await clickAndDownload(page, "Excelでダウンロード");
  expect(download.suggestedFilename()).toBe("merged.xlsx");
  const { path: out } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });
  const sheet = await readXlsxSheet(out);
  expect(sheet.headers).toEqual(["氏名", "部署", "年齢", "メール", "結合元"]);
  const norm = sheet.rows.map((r) => r.map((v) => (v == null ? "" : String(v))));
  expect(norm).toEqual([
    ["山田太郎", "営業", "30", "", "list-a.xlsx"],
    ["佐藤花子", "総務", "41", "", "list-a.xlsx"],
    ["鈴木一郎", "開発", "", "suzuki@example.test", "list-b.xlsx"],
    ["高橋次郎", "", "28", "", "list-c.csv"],
  ]);
});

test("excel-merge: CSVで出力でき、Shift_JISのCSVも文字化けせず結合できる", async ({ page }) => {
  await uploadAndWaitPreview(page, [files.c, fixtures.csvForMerge, path.join(fixtures.dir.static, "syukujitsu-format-sample-sjis.csv")]);
  await page.getByRole("radio", { name: "CSV" }).click();
  await page.getByRole("button", { name: "3件を結合する" }).click();
  await waitForSuccess(page, "結合が完了しました");

  const download = await clickAndDownload(page, "CSVでダウンロード");
  expect(download.suggestedFilename()).toBe("merged.csv");
  const { path: out } = await assertDownloadedFile(download, { minBytes: 100 });
  const text = fs.readFileSync(out, "utf8").replace(/^﻿/, "");
  const lines = text.trim().split(/\r?\n/);
  expect(lines[0]).toBe("氏名,年齢,id,name,quantity,price,国民の祝日・休日月日,国民の祝日・休日名称");
  expect(lines[1]).toBe("高橋次郎,28,,,,,,");
  expect(text).toContain("1955/1/1,元日");
});

test("excel-merge: シートが複数あるExcelは、結合するシートを選べる（結合元にシート名が付く）", async ({ page }) => {
  await uploadAndWaitPreview(page, [files.multi, files.a]);
  await page.getByLabel("multi.xlsx の結合するシート").selectOption({ label: "2月" });
  await page.getByLabel(/結合元」の列を足す/).check();
  await expect(page.getByTestId("tool-preview")).toContainText("結合後: 3行 × 5列");
  await page.getByRole("button", { name: "2件を結合する" }).click();
  await waitForSuccess(page, "結合が完了しました");

  const download = await clickAndDownload(page, "Excelでダウンロード");
  const { path: out } = await assertDownloadedFile(download, { format: "zip" });
  const sheet = await readXlsxSheet(out);
  const norm = sheet.rows.map((r) => r.map((v) => (v == null ? "" : String(v))));
  expect(norm[0]).toEqual(["佐藤花子", "200", "", "", "multi.xlsx（2月）"]);
  expect(norm).toHaveLength(3);
  // 選ばなかった「1月」シートの値（100）は入らない
  expect(norm.flat()).not.toContain("100");
});

test("excel-merge: 「値がすべて同じ行を除く」で重複行が除かれ、件数が表示される", async ({ page }) => {
  await uploadAndWaitPreview(page, [files.a, files.a]);
  await expect(page.getByTestId("tool-preview")).toContainText("結合後: 4行 × 3列");
  await page.getByLabel(/値がすべて同じ行は、2行目以降を除く/).check();
  await expect(page.getByTestId("tool-preview")).toContainText("同じ行を2行除きます");
  await page.getByRole("button", { name: "2件を結合する" }).click();
  await waitForSuccess(page, "結合が完了しました");
  const download = await clickAndDownload(page, "Excelでダウンロード");
  const { path: out } = await assertDownloadedFile(download, { format: "zip" });
  const sheet = await readXlsxSheet(out);
  expect(sheet.rows).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// 3. 異常系・プライバシー
// ---------------------------------------------------------------------------
test("excel-merge: 1件だけでは結合できず、追加を案内する。結合ボタンは出ない", async ({ page }) => {
  await page.goto("/tools/excel-merge");
  const hint = page.getByText("もう1つ以上、ファイルを追加してください。");
  await uploadWhenReady(page, [files.a], hint, { readyTimeoutMs: 30_000 });
  await expect(page.getByRole("button", { name: /件を結合する$/ })).toHaveCount(0);
});

test("excel-merge: 表のデータが無いファイルは、理由を表示して結合を止める", async ({ page }) => {
  const preview = await uploadAndWaitPreview(page, [files.a, files.empty]);
  await expect(preview).toContainText("empty.xlsx");
  await expect(preview).toContainText("表のデータがありません");
  await expect(page.getByRole("button", { name: "2件を結合する" })).toBeDisabled();
});

test("excel-merge: 古い形式（.xls）は対象外として、保存し直す方法を案内する", async ({ page }) => {
  await page.goto("/tools/excel-merge");
  await uploadWhenReady(page, [files.a, files.legacy], page.getByText("古い形式（.xls）は読み込めません"), { readyTimeoutMs: 20_000 });
  // .xls は一覧に入らない（.xlsx の1件だけが残るので、結合ボタンは出ない）
  await expect(page.getByRole("button", { name: /件を結合する$/ })).toHaveCount(0);
  await expect(page.getByText("もう1つ以上、ファイルを追加してください。")).toBeVisible();

  // Excel・CSV以外（PDFなど）は、一覧に入らず、対応していない旨が出る
  await uploadFixture(page, fixtures.singlePagePdf);
  await expect(page.getByText("対応していません")).toBeVisible();
  await expect(page.getByRole("button", { name: /件を結合する$/ })).toHaveCount(0);
});

test("excel-merge: 結合中、ファイルの内容が自社API・外部へ送信されない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await uploadAndWaitPreview(page, [files.a, files.b]);
  await page.getByRole("button", { name: "2件を結合する" }).click();
  await waitForSuccess(page, "結合が完了しました");
  await clickAndDownload(page, "Excelでダウンロード");

  const marker = "suzuki@example.test";
  const origin = new URL(baseURL!).origin;
  expect(findLeakedRequests(recorder, marker)).toEqual([]);
  expect(findLeakedRequests(recorder, "鈴木一郎")).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
});

test("excel-merge: 元のファイルは変更されない", async ({ page }) => {
  const before = fs.readFileSync(files.a);
  await uploadAndWaitPreview(page, [files.a, files.b]);
  await page.getByRole("button", { name: "2件を結合する" }).click();
  await waitForSuccess(page, "結合が完了しました");
  expect(fs.readFileSync(files.a).equals(before)).toBe(true);
});
