import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { assertDownloadedFile, clickAndDownload, waitForSuccess } from "../helpers/tool-runner";
import { waitForFileInputHydrated } from "../helpers/tool-ready";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { decodeCsvWith, detectAndDecodeCsv } from "@/lib/utils/csv-encoding";
import { parseCsv } from "@/lib/utils/csv";

/**
 * CSVの文字コード対応（UTF-8・UTF-8 BOM付き・Shift_JIS／Windows-31J）。
 * 1. 判定と読み込みの規則（純粋な関数）
 * 2. 画面：自動判定の表示、判定が不確実なときの注意、選び直すとプレビュー・変換が変わること、外部に送信しないこと
 * テスト用のCSVはすべてテストの中で作る架空のデータ。
 */

// ---------------------------------------------------------------------------
// Shift_JIS（Windows-31J）のバイト列を作る（Node の TextDecoder("shift_jis") の対応表を逆に引く）
// ---------------------------------------------------------------------------
let sjisTable: Map<string, number[]> | null = null;
function encodeSjis(text: string): Uint8Array {
  if (!sjisTable) {
    sjisTable = new Map();
    const dec = new TextDecoder("shift_jis");
    for (let b = 0; b < 0x80; b++) sjisTable.set(String.fromCharCode(b), [b]);
    for (let b = 0xa1; b <= 0xdf; b++) sjisTable.set(dec.decode(new Uint8Array([b])), [b]);
    for (let hi = 0x81; hi <= 0xfc; hi++) {
      if (hi >= 0xa0 && hi <= 0xdf) continue;
      for (let lo = 0x40; lo <= 0xfc; lo++) {
        if (lo === 0x7f) continue;
        const ch = dec.decode(new Uint8Array([hi, lo]));
        if (ch.length === 1 && ch !== "�" && !sjisTable.has(ch)) sjisTable.set(ch, [hi, lo]);
      }
    }
  }
  const out: number[] = [];
  for (const ch of Array.from(text)) {
    const code = sjisTable.get(ch);
    if (!code) throw new Error(`Shift_JISにない文字: ${ch}`);
    out.push(...code);
  }
  return new Uint8Array(out);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const withBom = (b: Uint8Array) => new Uint8Array([0xef, 0xbb, 0xbf, ...b]);

/** 日本語・機種依存文字・半角カナ・カンマ・改行・ダブルクォートを含むCSV */
const RICH_CSV = '氏名,会社,メモ\r\n髙橋 﨑子,㈱テスト①,"東京都, 千代田区"\r\nﾔﾏﾀﾞ ﾀﾛｳ,№12 株式会社,"1行目\r\n2行目"\r\n佐藤,"""引用""商事",普通\r\n';

// ---------------------------------------------------------------------------
// 1. 規則
// ---------------------------------------------------------------------------

plainTest("文字コード：UTF-8・UTF-8 BOM付き・Shift_JIS・Windows-31J（機種依存文字・半角カナ）を自動で判定して正しく読む", () => {
  const u = detectAndDecodeCsv(utf8(RICH_CSV));
  plainExpect(u).toMatchObject({ encoding: "utf-8", uncertain: false, hasUnreadable: false, text: RICH_CSV });

  const b = detectAndDecodeCsv(withBom(utf8(RICH_CSV)));
  plainExpect(b).toMatchObject({ encoding: "utf-8-bom", uncertain: false, text: RICH_CSV });

  // Windows-31J（NEC特殊文字・IBM拡張文字・半角カナを含む）
  const s = detectAndDecodeCsv(encodeSjis(RICH_CSV));
  plainExpect(s).toMatchObject({ encoding: "shift_jis", uncertain: false, hasUnreadable: false, text: RICH_CSV });

  // 読んだ後のCSVの区切り（カンマ・改行・ダブルクォートを含むセル）が、どの文字コードでも同じになる
  const expected = [
    ["氏名", "会社", "メモ"],
    ["髙橋 﨑子", "㈱テスト①", "東京都, 千代田区"],
    ["ﾔﾏﾀﾞ ﾀﾛｳ", "№12 株式会社", "1行目\r\n2行目"],
    ["佐藤", '"引用"商事', "普通"],
  ];
  for (const r of [u, b, s]) plainExpect(parseCsv(r.text).filter((row) => row.some((c) => c !== ""))).toEqual(expected);
});

plainTest("文字コード：英数字だけ・空のファイルは確認不要。UTF-16（BOM付き）も読む", () => {
  plainExpect(detectAndDecodeCsv(utf8("id,name\n1,abc\n"))).toMatchObject({ encoding: "ascii", uncertain: false, text: "id,name\n1,abc\n" });
  plainExpect(detectAndDecodeCsv(new Uint8Array())).toMatchObject({ encoding: "ascii", uncertain: false, text: "" });
  const le = new Uint8Array([0xff, 0xfe, ...Array.from("日付,予定").flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
  plainExpect(detectAndDecodeCsv(le)).toMatchObject({ encoding: "utf-16le", text: "日付,予定" });
});

/** UTF-8としてもShift_JISとしても読める、短いデータ（漢字1文字） */
function ambiguousChar(): string {
  const dec = new TextDecoder("shift_jis");
  for (let cp = 0x4e00; cp < 0x9fff; cp++) {
    const ch = String.fromCodePoint(cp);
    if (!dec.decode(utf8(ch)).includes("�")) return ch;
  }
  throw new Error("見つかりません");
}

plainTest("文字コード：判定が不確実なとき（短くてどちらでも読める・どちらでも読めない）は「確認が必要」にし、黙って確定しない", () => {
  const ch = ambiguousChar();
  const amb = detectAndDecodeCsv(utf8(`a,${ch}\n`));
  plainExpect(amb.encoding).toBe("utf-8");
  plainExpect(amb.uncertain).toBe(true);

  // UTF-8でもShift_JISでも読めないバイト列（壊れたファイル・別の文字コード）
  const broken = detectAndDecodeCsv(new Uint8Array([0x61, 0x2c, 0xff, 0xff, 0x80, 0x0a]));
  plainExpect(broken).toMatchObject({ encoding: "shift_jis", uncertain: true, hasUnreadable: true });
});

plainTest("文字コード：手で選んだ文字コードが自動判定より優先される。合わない文字コードを選ぶと、読めない文字として知らせる", () => {
  const sjis = encodeSjis("氏名,住所\n山田,大阪\n");
  plainExpect(decodeCsvWith(sjis, "shift_jis")).toMatchObject({ encoding: "shift_jis", choice: "shift_jis", text: "氏名,住所\n山田,大阪\n", hasUnreadable: false });
  const wrong = decodeCsvWith(sjis, "utf-8");
  plainExpect(wrong.choice).toBe("utf-8");
  plainExpect(wrong.hasUnreadable).toBe(true);
  plainExpect(wrong.text).not.toContain("氏名");
  // UTF-8（BOM付き）を選んだときも、BOMは取り除く
  plainExpect(decodeCsvWith(withBom(utf8("a,b")), "utf-8-bom").text).toBe("a,b");
  plainExpect(decodeCsvWith(withBom(utf8("a,b")), "utf-8").text).toBe("a,b");
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------

function writeTemp(name: string, bytes: Uint8Array): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-enc-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

async function upload(page: Page, files: string | string[]) {
  await waitForFileInputHydrated(page);
  await page.locator('input[type="file"]').first().setInputFiles(files);
}

const MARKER = "文字コード秘密太郎";

test("CSV→Excel：Shift_JISのCSVをそのまま読み、自動判定を表示し、日本語が正しいExcelになる。外部に送信しない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await page.goto("/tools/csv-to-excel");
  await upload(page, writeTemp("銀行明細.csv", encodeSjis(`日付,摘要,金額\n2026/11/01,${MARKER},1000\n2026/11/02,㈱テスト①,-500\n`)));
  const enc = page.getByTestId("csv-encoding");
  await expect(enc).toHaveAttribute("data-encoding", "shift_jis");
  await expect(enc).not.toHaveAttribute("data-warning", "true");
  await expect(page.getByTestId("csv-encoding-used")).toHaveText("Shift_JIS／Windows-31J");
  await expect(page.getByText(MARKER).first()).toBeVisible();

  await page.getByRole("button", { name: "Excelに変換する" }).click();
  await waitForSuccess(page, "完了");
  const dl = await clickAndDownload(page, "ダウンロード");
  const file = await assertDownloadedFile(dl, { format: "zip", minBytes: 10 });
  const sheet = await readXlsxSheet(file.path);
  const cells = sheet.rows.flat().map((c) => String(c ?? ""));
  plainExpect(cells).toContain(MARKER);
  plainExpect(cells).toContain("㈱テスト①");

  expect(findLeakedRequests(recorder, MARKER)).toEqual([]);
  expect(findLeakedRequests(recorder, encodeURIComponent(MARKER))).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("重複削除：判定が不確実なCSVは注意を出し、文字コードを選び直すとプレビューと結果がその文字コードで作り直される", async ({ page }) => {
  await page.goto("/tools/csv-dedupe");
  // Shift_JISで保存した短いCSV（UTF-8としても読める）＝自動判定では確かでない
  const ch = ambiguousChar();
  const sjisText = new TextDecoder("shift_jis").decode(utf8(ch));
  await upload(page, writeTemp("短い.csv", utf8(`h,v\nx,${ch}\nx,y\nx,y\n`)));
  const enc = page.getByTestId("csv-encoding");
  await expect(enc).toHaveAttribute("data-warning", "true");
  await expect(page.getByTestId("csv-encoding-warning")).toContainText("はっきり判定できませんでした");
  await expect(page.getByText(ch).first()).toBeVisible();

  // Shift_JISを選ぶと、プレビューがShift_JISで読んだ文字に変わり、注意は消える
  await page.getByTestId("csv-encoding-select").selectOption("shift_jis");
  await expect(enc).toHaveAttribute("data-choice", "shift_jis");
  await expect(enc).not.toHaveAttribute("data-warning", "true");
  await expect(page.getByText(sjisText).first()).toBeVisible();

  // 処理の結果も、選んだ文字コードで読んだ内容になる
  await page.getByRole("button", { name: "重複を削除する" }).click();
  await waitForSuccess(page, "完了");
  const dl = await clickAndDownload(page, "ダウンロード");
  const out = fs.readFileSync((await assertDownloadedFile(dl, { minBytes: 1 })).path, "utf8");
  plainExpect(out).toContain(sjisText);
  // 重複していた「x,y」は1行になる
  plainExpect(out.split("x,y").length - 1).toBe(1);
});

test("文字列置換：文字コードを合わない方に選ぶと「文字化けの可能性」を知らせ、自動判定に戻すと正しく読める", async ({ page }) => {
  await page.goto("/tools/csv-replace");
  await upload(page, writeTemp("名簿.csv", encodeSjis("氏名,所属\n山田,営業部\n")));
  const enc = page.getByTestId("csv-encoding");
  await expect(enc).toHaveAttribute("data-encoding", "shift_jis");
  await page.getByTestId("csv-encoding-select").selectOption("utf-8");
  await expect(enc).toHaveAttribute("data-warning", "true");
  await expect(page.getByTestId("csv-encoding-warning")).toContainText("文字化けしている可能性があります");
  await page.getByTestId("csv-encoding-select").selectOption("auto");
  await expect(enc).not.toHaveAttribute("data-warning", "true");
  await expect(page.getByText("営業部").first()).toBeVisible();
});

test("CSV結合：UTF-8（BOM付き）とShift_JISのCSVを、それぞれの文字コードで読んで結合できる", async ({ page }) => {
  await page.goto("/tools/csv-merge");
  await upload(page, [writeTemp("a.csv", withBom(utf8("氏名,点数\n山田,80\n"))), writeTemp("b.csv", encodeSjis("氏名,点数\n髙橋,90\n"))]);
  await expect(page.getByTestId("csv-encoding")).toHaveCount(2);
  await expect(page.locator('[data-testid="csv-encoding"][data-file-name="a.csv"]')).toHaveAttribute("data-encoding", "utf-8-bom");
  await expect(page.locator('[data-testid="csv-encoding"][data-file-name="b.csv"]')).toHaveAttribute("data-encoding", "shift_jis");
  await page.getByRole("button", { name: /結合/ }).first().click();
  await waitForSuccess(page, "完了");
  const dl = await clickAndDownload(page, "ダウンロード");
  const out = fs.readFileSync((await assertDownloadedFile(dl, { minBytes: 1 })).path, "utf8");
  plainExpect(out).toContain("山田");
  plainExpect(out).toContain("髙橋");
});

test("座席表：Shift_JISの名簿CSVを読み込める（Excel以外の画面でも、同じ文字コードの判定を使う）", async ({ page }) => {
  await page.goto("/tools/seating-chart");
  // 画面の準備（hydration）が終わってから用途を選ぶ（準備前の操作は無視されることがあるため）
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="seat-purpose-meeting"]');
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  });
  await page.getByTestId("seat-purpose-meeting").click();
  await expect(page.getByTestId("seat-names")).toBeVisible();
  await page.getByTestId("seat-import-input").setInputFiles(writeTemp("名簿.csv", encodeSjis("氏名\n髙橋一郎\nﾔﾏﾀﾞ\n")));
  await expect(page.getByTestId("seat-names")).toHaveValue(/髙橋一郎/);
  await expect(page.getByTestId("csv-encoding")).toHaveAttribute("data-encoding", "shift_jis");
});
