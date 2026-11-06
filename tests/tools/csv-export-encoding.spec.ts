import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, waitForSuccess } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { csvTextToBlob, encodeShiftJis, findUnencodable } from "@/lib/utils/csv-export-encoding";
import { parseCsv, serializeCsv } from "@/lib/utils/csv";

/**
 * CSVの書き出しの文字コード（UTF-8 BOM付き・UTF-8 BOMなし・Shift_JIS／Windows-31J）。
 * 1. 変換の規則（純粋な関数）：Windows-31J と同じバイト、表せない文字の検出、CSVの形が変わらないこと
 * 2. 画面：初期値はこれまでどおり、Shift_JISで書き出せる、表せない文字は書き出す前に確認する、外部に送信しない
 * テスト用のCSVはすべてテストの中で作る架空のデータ。
 */

const sjisDecode = (b: Uint8Array) => new TextDecoder("shift_jis").decode(b);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

// ---------------------------------------------------------------------------
// 1. 規則
// ---------------------------------------------------------------------------

plainTest("Shift_JIS：漢字・かな・半角カナ・①㈱№・髙﨑を Windows-31J と同じバイトで書き出し、読み戻すと同じ文字になる", () => {
  const text = "漢字ひらがなカタカナ ｶﾀｶﾅ ①㈱№ 髙橋 﨑 ∵≒ ～";
  const bytes = encodeShiftJis(text);
  plainExpect(sjisDecode(bytes)).toBe(text);
  // Windows の変換と同じバイト（同じ文字に複数のバイト列があるときは小さい方。NEC選定IBM拡張は使わない）
  plainExpect(hex(encodeShiftJis("№"))).toBe("87 82");
  plainExpect(hex(encodeShiftJis("①"))).toBe("87 40");
  plainExpect(hex(encodeShiftJis("∵"))).toBe("81 e6");
  plainExpect(hex(encodeShiftJis("髙"))).toBe("fb fc");
  plainExpect(hex(encodeShiftJis("ｱ"))).toBe("b1");
  plainExpect(hex(encodeShiftJis("～"))).toBe("81 60");
  // 表せない文字は「?」。近い文字は、選んだときだけ置き換える
  plainExpect(sjisDecode(encodeShiftJis("A😀〜B"))).toBe("A??B");
  plainExpect(sjisDecode(encodeShiftJis("A😀〜B", { replaceNear: true }))).toBe("A?～B");
});

plainTest("表せない文字の検出：文字・回数・最初の行と列（引用符の中のカンマ・改行も考える）・近い文字を返す", () => {
  const csv = serializeCsv(
    [
      ["名前", "メモ"],
      ["山田", "了解😀"],
      ['"引用,改行\nあり"', "10〜20"],
      ["佐藤", "😀😀"],
    ],
    { includeBom: true }
  );
  const found = findUnencodable(csv);
  const emoji = found.find((f) => f.char === "😀")!;
  plainExpect(emoji).toMatchObject({ count: 3, row: 2, column: 2, replacement: null });
  const wave = found.find((f) => f.char === "〜")!;
  plainExpect(wave).toMatchObject({ count: 1, row: 3, column: 2, replacement: "～" });
  plainExpect(findUnencodable("普通の,文字だけ\r\n①,髙")).toEqual([]);
});

plainTest("書き出し：BOMの有無が正しく、どの文字コードでもCSVの行数・列数・セルの内容（カンマ・引用符・改行・空欄・先頭ゼロ・日付）が変わらない", async () => {
  const rows = [
    ["コード", "名前", "メモ", "日付", "金額"],
    ["007", "株式会社テスト①", "カンマ, あり", "2026/11/06", "1,000"],
    ["010", '"引用"商事', "1行目\r\n2行目", "", "-500"],
    ["", "ｶﾌﾞｼｷｶﾞｲｼｬ", "", "R8.11.6", "0"],
  ];
  const csv = serializeCsv(rows, { includeBom: true });
  const bom = new Uint8Array(await csvTextToBlob(csv, "utf-8-bom").arrayBuffer());
  const noBom = new Uint8Array(await csvTextToBlob(csv, "utf-8").arrayBuffer());
  const sjis = new Uint8Array(await csvTextToBlob(csv, "shift_jis").arrayBuffer());
  plainExpect(hex(bom.slice(0, 3))).toBe("ef bb bf");
  plainExpect(hex(noBom.slice(0, 3))).not.toBe("ef bb bf");
  plainExpect(hex(sjis.slice(0, 3))).not.toBe("ef bb bf");
  const utf = new TextDecoder("utf-8");
  for (const text of [utf.decode(bom).replace(/^﻿/, ""), utf.decode(noBom), sjisDecode(sjis)]) plainExpect(parseCsv(text)).toEqual(rows);
});

plainTest("書き出し：大きなCSV（5万行）もShift_JISにでき、行数が変わらない", () => {
  const rows = [["番号", "氏名", "住所"], ...Array.from({ length: 50_000 }, (_, i) => [String(i).padStart(6, "0"), `山田${i}`, "東京都千代田区千代田1-1"])];
  const csv = serializeCsv(rows);
  const start = Date.now();
  const bytes = encodeShiftJis(csv);
  plainExpect(Date.now() - start).toBeLessThan(5000);
  plainExpect(parseCsv(sjisDecode(bytes)).length).toBe(rows.length);
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------

function writeTemp(name: string, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-out-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

async function dedupe(page: Page, csv: string) {
  await page.goto("/tools/csv-dedupe");
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(writeTemp("名簿.csv", csv));
  await page.getByRole("button", { name: "重複を削除する" }).click();
  await waitForSuccess(page, "完了");
}

const MARKER = "書き出し秘密花子";

test("重複削除：初期値はこれまでどおりUTF-8（BOM付き）。Shift_JIS／Windows-31Jを選ぶと、その文字コードで書き出す。外部に送信しない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await dedupe(page, `氏名,会社\n${MARKER},㈱テスト①\n${MARKER},㈱テスト①\nﾔﾏﾀﾞ,髙橋商事\n`);
  await expect(page.getByTestId("csv-export-encoding-select")).toHaveValue("utf-8-bom");

  const def = fs.readFileSync(await (await clickAndDownload(page, "CSVでダウンロード")).path());
  plainExpect(hex(new Uint8Array(def.subarray(0, 3)))).toBe("ef bb bf");

  await page.getByTestId("csv-export-encoding-select").selectOption("shift_jis");
  const dl = await clickAndDownload(page, "CSVでダウンロード");
  plainExpect(dl.suggestedFilename()).toBe("deduped.csv");
  const bytes = new Uint8Array(fs.readFileSync((await dl.path())!));
  plainExpect(hex(bytes.slice(0, 3))).not.toBe("ef bb bf");
  const rows = parseCsv(sjisDecode(bytes));
  plainExpect(rows).toEqual([
    ["氏名", "会社"],
    [MARKER, "㈱テスト①"],
    ["ﾔﾏﾀﾞ", "髙橋商事"],
  ]);

  expect(findLeakedRequests(recorder, MARKER)).toEqual([]);
  expect(findLeakedRequests(recorder, encodeURIComponent(MARKER))).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("重複削除：Shift_JISで表せない文字があると、書き出す前に文字と場所を出して確認する（キャンセル・近い文字に置き換え・そのまま）", async ({ page }) => {
  await dedupe(page, "氏名,メモ\n山田,了解😀\n佐藤,10〜20\n");
  await page.getByTestId("csv-export-encoding-select").selectOption("shift_jis");

  // ボタンを押すと、まず確認が出る（まだダウンロードしない）
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.getByRole("button", { name: "CSVでダウンロード" }).click();
  const box = page.getByTestId("csv-export-unencodable");
  await expect(box).toBeVisible();
  await expect(box).toContainText("Shift_JISで表現できない文字が含まれています");
  await expect(page.locator('[data-testid="csv-export-unencodable-item"][data-char="😀"]')).toContainText("2行目・2列目");
  await expect(page.locator('[data-testid="csv-export-unencodable-item"][data-char="〜"]')).toContainText("近い文字「～」");
  plainExpect(downloads).toBe(0);

  // キャンセル：何も書き出さない
  await page.getByTestId("csv-export-cancel").click();
  await expect(box).toBeHidden();
  plainExpect(downloads).toBe(0);

  // 近い文字に置き換えて書き出す：〜は～に、😀は?になる
  await page.getByRole("button", { name: "CSVでダウンロード" }).click();
  const p1 = page.waitForEvent("download");
  await page.getByTestId("csv-export-replace-near").click();
  const near = sjisDecode(new Uint8Array(fs.readFileSync((await (await p1).path())!)));
  plainExpect(parseCsv(near)).toEqual([
    ["氏名", "メモ"],
    ["山田", "了解?"],
    ["佐藤", "10～20"],
  ]);

  // そのまま書き出す：どちらも?になる（行数・列数は変わらない）
  await page.getByRole("button", { name: "CSVでダウンロード" }).click();
  const p2 = page.waitForEvent("download");
  await page.getByTestId("csv-export-as-is").click();
  const asIs = sjisDecode(new Uint8Array(fs.readFileSync((await (await p2).path())!)));
  plainExpect(parseCsv(asIs)).toEqual([
    ["氏名", "メモ"],
    ["山田", "了解?"],
    ["佐藤", "10?20"],
  ]);
});

test("CSV整形：これまでBOMなしだった書き出しは、初期値もUTF-8（BOMなし）のまま。Shift_JISも選べる", async ({ page }) => {
  await page.goto("/tools/csv-format");
  await page.locator("textarea").first().fill("氏名,会社\n山田,㈱テスト\n");
  await page.getByRole("button", { name: "整形する" }).click();
  await waitForSuccess(page, "完了");
  await expect(page.getByTestId("csv-export-encoding-select")).toHaveValue("utf-8");
  const def = new Uint8Array(fs.readFileSync((await (await clickAndDownload(page, "CSVとしてダウンロード")).path())!));
  plainExpect(hex(def.slice(0, 3))).not.toBe("ef bb bf");
  plainExpect(new TextDecoder().decode(def)).toContain("㈱テスト");
  await page.getByTestId("csv-export-encoding-select").selectOption("shift_jis");
  const sj = new Uint8Array(fs.readFileSync((await (await clickAndDownload(page, "CSVとしてダウンロード")).path())!));
  plainExpect(sjisDecode(sj)).toContain("㈱テスト");
});
