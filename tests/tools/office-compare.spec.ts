import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { buildCompareXlsx, type CmpSheet } from "../fixtures/office-compare-writer";
import { buildMinimalDocx, type DocxParagraphSpec } from "../fixtures/docx-writer";
import { assertDownloadedFile, clickAndDownload } from "../helpers/tool-runner";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";

/**
 * Excel・Word比較（office-compare）の画面テスト（工程4）。値はすべて架空。
 * 機能A：ファイルの差分（Excel同士・Word同士）、機能B：文書間の不一致（項目と値の照合）、Excel・Word出力、入力の確認、通信。
 */

const MARKER = "架空株式会社ヒカクケンショウ";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "office-compare-"));
}

function writeXlsx(dir: string, name: string, sheets: CmpSheet[], macro = false): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buildCompareXlsx(sheets, { macro }));
  return p;
}

function writeDocx(dir: string, name: string, blocks: DocxParagraphSpec[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buildMinimalDocx({ blocks }));
  return p;
}

const para = (text: string, heading?: 1 | 2 | 3): DocxParagraphSpec => ({ kind: "paragraph", runs: [{ text }], heading });

async function openTool(page: Page) {
  await page.goto("/tools/office-compare");
  await expect(page.getByTestId("cmp-run")).toBeVisible({ timeout: 60_000 });
  // 入力の準備（hydration）が終わるまで待つ
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="cmp-slot-a"] input[type=file]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
}

async function choose(page: Page, slot: "a" | "b", file: string) {
  await page.getByTestId(`cmp-slot-${slot}`).locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByTestId(`cmp-file-${slot}`)).toHaveText(path.basename(file));
}

async function compare(page: Page, a: string, b: string, mode: "diff" | "match" = "diff") {
  if (mode === "match") await page.getByTestId("cmp-mode-match").click();
  await choose(page, "a", a);
  await choose(page, "b", b);
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toBeVisible({ timeout: 30_000 });
}

function diffRow(page: Page, location: string) {
  return page.locator('[data-testid="cmp-diff-row"]').filter({ has: page.locator("td.font-mono", { hasText: new RegExp(`^${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
}

const SALES_A: CmpSheet[] = [
  {
    name: "売上",
    rows: [
      ["項目", "金額", "状態"],
      ["A商品", 5000, "完了"],
      ["B商品", 3000, "完了"],
      ["合計", 10000, null],
      [null, null, null],
      [null, null, null],
      [null, null, null],
      ["メモ", null, null],
    ],
  },
  { name: "旧シート", rows: [["古いデータ"]] },
];

// ---------------------------------------------------------------------------
// 機能A：Excel
// ---------------------------------------------------------------------------

test("office-compare: 同じ内容のExcelは「違いはありませんでした」になり、不要な差分が出ない", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "same-a.xlsx", SALES_A);
  const b = writeXlsx(dir, "same-b.xlsx", SALES_A);
  await openTool(page);
  await compare(page, a, b);
  await expect(page.getByTestId("cmp-summary")).toContainText("違いはありませんでした");
  await expect(page.getByTestId("cmp-diff-row")).toHaveCount(0);
});

test("office-compare: Excelのセルの値の変更・追加と、シートの追加・削除を、シート名・セル・前後の値つきで出す", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "sales-v1.xlsx", SALES_A);
  const bSheets: CmpSheet[] = [
    {
      name: "売上",
      rows: [
        ["項目", "金額", "状態"],
        ["A商品", 5000, "完了"],
        ["B商品", 3000, "完了"],
        ["合計", 12000, null],
        [null, null, null],
        [null, null, null],
        [null, null, null],
        ["メモ", null, "完了"],
      ],
    },
    { name: "新シート", rows: [["新しいデータ"]] },
  ];
  const b = writeXlsx(dir, "sales-v2.xlsx", bSheets);
  await openTool(page);
  // 行の対応づけを外し、同じ番地どうしで比べる（表示例のとおり B4・C8 で出る）
  await choose(page, "a", a);
  await choose(page, "b", b);
  await page.getByTestId("cmp-align").uncheck();
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toContainText("違いが 4件");
  const b4 = diffRow(page, "B4");
  await expect(b4).toContainText("売上");
  await expect(b4.getByTestId("cmp-before")).toHaveText("10000");
  await expect(b4.getByTestId("cmp-after")).toHaveText("12000");
  await expect(b4).toContainText("値が変更");
  const c8 = diffRow(page, "C8");
  await expect(c8.getByTestId("cmp-before")).toHaveText("（空欄）");
  await expect(c8.getByTestId("cmp-after")).toHaveText("完了");
  await expect(c8).toContainText("値が追加");
  await expect(page.locator('[data-kind="sheet-removed"]')).toContainText("旧シート");
  await expect(page.locator('[data-kind="sheet-added"]')).toContainText("新シート");
});

test("office-compare: 行を挿入しても、挿入した行だけが「行が追加」として出る（行の対応づけを外すと、下のセルが違いとして出る）", async ({ page }) => {
  const dir = tmpDir();
  const rows = Array.from({ length: 8 }, (_, i) => [`社員${i + 1}`, 100 + i]);
  const a = writeXlsx(dir, "roster-a.xlsx", [{ name: "名簿", rows }]);
  const inserted = [...rows.slice(0, 3), ["新人", 999], ...rows.slice(3)];
  const b = writeXlsx(dir, "roster-b.xlsx", [{ name: "名簿", rows: inserted }]);
  await openTool(page);
  await compare(page, a, b);
  await expect(page.getByTestId("cmp-diff-row")).toHaveCount(1);
  const added = page.locator('[data-kind="row-added"]');
  await expect(added).toContainText("4行目");
  await expect(added).toContainText("新人");
  await expect(added).toContainText("999");
  // 行の対応づけを外すと、4行目より下がすべてずれて違いになる
  await page.getByTestId("cmp-align").uncheck();
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toContainText("違いが");
  expect(await page.getByTestId("cmp-diff-row").count()).toBeGreaterThan(5);
});

test("office-compare: 行の挿入と、近くの行の値の変更が重なっても、行の先頭の値で対応づける（ずれた行どうしを比べない）", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "items-a.xlsx", [{ name: "売上", rows: [["項目", "金額"], ["A商品", 5000], ["B商品", 3000], ["合計", { formula: "SUM(B2:B3)", result: 8000 }]] }]);
  const b = writeXlsx(dir, "items-b.xlsx", [{ name: "売上", rows: [["項目", "金額"], ["A商品", 5000], ["C商品", 2500], ["B商品", 3500], ["合計", { formula: "SUM(B2:B4)", result: 11000 }]] }]);
  await openTool(page);
  await compare(page, a, b);
  await expect(page.locator('[data-kind="row-added"]')).toContainText("C商品");
  const moved = diffRow(page, "B3 → B4");
  await expect(moved.getByTestId("cmp-before")).toHaveText("3000");
  await expect(moved.getByTestId("cmp-after")).toHaveText("3500");
  await expect(diffRow(page, "B4 → B5")).toContainText("数式が変更");
  await expect(page.getByTestId("cmp-diff-row")).toHaveCount(3);
});

test("office-compare: 数式と計算結果を区別して出す。数式を比べない設定では値だけを比べる。数値の1と文字の「1」は同じにしない。日付は日付で出す", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "formula-a.xlsx", [
    {
      name: "計算",
      rows: [
        [10, 20, { formula: "A1+B1", result: 30 }],
        [{ formula: "SUM(A1:B1)", result: 30 }, 1, { date: "2026-10-01" }],
        [{ formula: "A1*2", result: 20 }, null, null],
      ],
    },
  ]);
  const b = writeXlsx(dir, "formula-b.xlsx", [
    {
      name: "計算",
      rows: [
        [10, 20, { formula: "A1*B1", result: 200 }],
        [{ formula: "SUM(A1:B1)", result: 31 }, { text: "1" }, { date: "2026-10-05" }],
        [20, null, null],
      ],
    },
  ]);
  await openTool(page);
  await compare(page, a, b);
  const c1 = diffRow(page, "C1");
  await expect(c1).toContainText("数式が変更");
  await expect(c1.getByTestId("cmp-before")).toHaveText("=A1+B1（結果：30）");
  await expect(c1.getByTestId("cmp-after")).toHaveText("=A1*B1（結果：200）");
  await expect(diffRow(page, "A2")).toContainText("計算結果が変更");
  const b2 = diffRow(page, "B2");
  await expect(b2).toContainText("値の種類が変更");
  await expect(b2).toContainText("数値 → 文字");
  const c2 = diffRow(page, "C2");
  await expect(c2.getByTestId("cmp-before")).toHaveText("2026/10/01");
  await expect(c2.getByTestId("cmp-after")).toHaveText("2026/10/05");
  const a3 = diffRow(page, "A3");
  await expect(a3).toContainText("数式が値に変わりました");

  // 数式を比べない：C1 は計算結果（30→200）の変更、A3 は値が同じ（20）なので違いにならない
  await page.getByTestId("cmp-formulas").uncheck();
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toContainText("違いが");
  await expect(diffRow(page, "C1").getByTestId("cmp-before")).toHaveText("30");
  await expect(diffRow(page, "C1")).toContainText("値が変更");
  await expect(diffRow(page, "A3")).toHaveCount(0);
  await page.getByTestId("cmp-notes").locator("summary").click();
  await expect(page.getByTestId("cmp-notes")).toContainText("数式の違いは見ていません");
});

test("office-compare: 非表示シートとマクロ有効ブック（.xlsm）は、その旨を表示して比べる", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "book-a.xlsm", [{ name: "表", rows: [["a", 1]] }, { name: "裏", rows: [["x"]], hidden: true }], true);
  const b = writeXlsx(dir, "book-b.xlsm", [{ name: "表", rows: [["a", 1]] }, { name: "裏", rows: [["y"]], hidden: true }], true);
  await openTool(page);
  await choose(page, "a", a);
  await expect(page.getByTestId("cmp-slot-a")).toContainText("マクロ有効");
  await choose(page, "b", b);
  await expect(page.getByTestId("tool-preview")).toContainText("マクロは比べません");
  await page.getByTestId("cmp-run").click();
  await expect(diffRow(page, "A1")).toContainText("裏（非表示）");
  await page.getByTestId("cmp-notes").locator("summary").click();
  await expect(page.getByTestId("cmp-notes")).toContainText("マクロ（VBA）は比べていません");
  await expect(page.getByTestId("cmp-notes")).toContainText("非表示のシートも比べました");
});

// ---------------------------------------------------------------------------
// 機能A：Word
// ---------------------------------------------------------------------------

test("office-compare: Wordの文章の追加・削除・変更と、表の行の変更を、場所つきで出す。変わった文字に印を付ける", async ({ page }) => {
  const dir = tmpDir();
  const a = writeDocx(dir, "notice-v1.docx", [
    para("提出のご案内", 1),
    para("本書は架空の案内です。"),
    para("提出期限：10月1日"),
    para("旧担当者：佐藤"),
    { kind: "table", rows: [["役割", "氏名"], ["窓口", "山田"]] },
  ]);
  const b = writeDocx(dir, "notice-v2.docx", [
    para("提出のご案内", 1),
    para("本書は架空の案内です。"),
    para("提出期限：10月5日"),
    { kind: "table", rows: [["役割", "氏名"], ["窓口", "鈴木"], ["新担当者", "高橋"]] },
    para("本書は  架空の案内です。"),
  ]);
  await openTool(page);
  await compare(page, a, b);
  const changed = page.locator('[data-kind="text-changed"]').filter({ hasText: "提出期限" });
  await expect(changed).toContainText("第3段落");
  await expect(changed).toContainText("見出し「提出のご案内」の下");
  await expect(changed.getByTestId("cmp-before").locator("del")).toHaveText("1");
  await expect(changed.getByTestId("cmp-after").locator("ins")).toHaveText("5");
  await expect(page.locator('[data-kind="text-removed"]')).toContainText("旧担当者：佐藤");
  await expect(page.locator('[data-kind="text-changed"]').filter({ hasText: "表1・2行目" })).toContainText("窓口 | 鈴木");
  await expect(page.locator('[data-kind="text-added"]').filter({ hasText: "表1・3行目" })).toContainText("新担当者 | 高橋");
  // 空白だけの違いは、隠さずに「空白・改行だけが変更」として出す
  await expect(page.locator('[data-kind="text-added"], [data-kind="space-changed"]').filter({ hasText: "本書は  架空の案内です。" })).toHaveCount(1);
  await page.getByTestId("cmp-notes").locator("summary").click();
  await expect(page.getByTestId("cmp-notes")).toContainText("書式の違いは比べません");
});

test("office-compare: 差分の調べ方で、ExcelとWordを選ぶと、比べられない理由を出して「比べる」を押せない", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "mix.xlsx", SALES_A);
  const b = writeDocx(dir, "mix.docx", [para("本文")]);
  await openTool(page);
  await choose(page, "a", a);
  await choose(page, "b", b);
  await expect(page.getByTestId("cmp-kind-mismatch")).toContainText("Excel同士・Word同士");
  await expect(page.getByTestId("cmp-run")).toBeDisabled();
  // 文書間の不一致に切り替えると、比べられる（ファイルは選んだまま）
  await page.getByTestId("cmp-mode-match").click();
  await expect(page.getByTestId("cmp-kind-mismatch")).toHaveCount(0);
  await expect(page.getByTestId("cmp-run")).toBeEnabled();
});

// ---------------------------------------------------------------------------
// 機能B：文書間の不一致
// ---------------------------------------------------------------------------

function quoteXlsx(dir: string): string {
  return writeXlsx(dir, "estimate.xlsx", [
    {
      name: "見積書",
      rows: [
        ["会社名", MARKER],
        ["合計金額", "100,000円"],
        ["提出期限", { date: "2026-10-01" }],
        ["担当者", "山田太郎"],
        ["送料", "5千円"],
        ["納品日", "10月1日"],
        ["お見積金額", 50000],
        [null, null],
        ["品名", "数量", "単価"],
        ["りんご", 3, 120],
        ["みかん", 10, 50],
      ],
    },
  ]);
}

function orderDocx(dir: string): string {
  return writeDocx(dir, "order.docx", [
    para("注文書", 1),
    para(`会社名：${MARKER.replace("架空株式会社", "")}`),
    para("合計金額：100000"),
    para("提出期限：2026年10月5日"),
    para("送料：5000円"),
    para("納品日：2026/10/01"),
    para("お支払金額：50,000円"),
    { kind: "table", rows: [["品名", "数量", "単価"], ["りんご", "3", "120"], ["みかん", "12", "50"]] },
  ]);
}

test("office-compare: 見積書（Excel）と注文書（Word）を照合し、一致・不一致・片方に記載なし・要確認を、元の表記と理由つきで出す", async ({ page }) => {
  const dir = tmpDir();
  await openTool(page);
  await compare(page, quoteXlsx(dir), orderDocx(dir), "match");
  const row = (label: string) => page.locator(`[data-testid="cmp-match-row"][data-label="${label}"]`);

  // 数値：「100,000円」と「100000」は、桁区切り・単位をそろえて一致。元の表記も残る
  await expect(row("合計金額").getByTestId("cmp-status")).toHaveText("一致");
  await expect(row("合計金額").getByTestId("cmp-value-a")).toContainText("100,000円");
  await expect(row("合計金額").getByTestId("cmp-value-b")).toContainText("100000");
  await expect(row("合計金額").getByTestId("cmp-reason")).toContainText("数値として一致");
  // 日付：Excelの日付（2026/10/01）と「2026年10月5日」は不一致
  await expect(row("提出期限").getByTestId("cmp-status")).toHaveText("不一致");
  await expect(row("提出期限").getByTestId("cmp-reason")).toContainText("2026-10-01 / 2026-10-05");
  // 片方にしかない項目
  await expect(row("担当者").getByTestId("cmp-status")).toHaveText("片方に記載なし");
  await expect(row("担当者").getByTestId("cmp-value-b")).toContainText("記載なし");
  // 会社名：片方がもう片方の一部（略称の可能性）→ 同じと断定しない
  await expect(row("会社名").getByTestId("cmp-status")).toHaveText("要確認");
  // 単位が違う（千円と円）→ 要確認
  await expect(row("送料").getByTestId("cmp-status")).toHaveText("要確認");
  await expect(row("送料").getByTestId("cmp-reason")).toContainText("単位が違う");
  // 年のない日付 → 要確認
  await expect(row("納品日").getByTestId("cmp-status")).toHaveText("要確認");
  await expect(row("納品日").getByTestId("cmp-reason")).toContainText("年が書かれていない");
  // 見出しの行がある表：「行の先頭／列の見出し」で照合
  await expect(row("りんご／数量").getByTestId("cmp-status")).toHaveText("一致");
  await expect(row("みかん／数量").getByTestId("cmp-status")).toHaveText("不一致");
  await expect(row("みかん／数量").getByTestId("cmp-value-a")).toContainText("見積書!B11");
  // 名前が違う項目は、自動では組にしない
  await expect(row("お見積金額").getByTestId("cmp-status")).toHaveText("片方に記載なし");
  await expect(row("お支払金額").getByTestId("cmp-status")).toHaveText("片方に記載なし");
});

test("office-compare: 名前が違う項目を手動で組にでき、比べない項目は件数から外せる", async ({ page }) => {
  const dir = tmpDir();
  await openTool(page);
  await compare(page, quoteXlsx(dir), orderDocx(dir), "match");
  const summary = page.getByTestId("cmp-summary");
  const before = await summary.textContent();
  await page.getByTestId("cmp-manual").locator("summary").click();
  const select = page.getByLabel("「お見積金額」に対応するファイルBの項目");
  await select.selectOption({ label: "お支払金額（50,000円）" });
  const paired = page.locator('[data-testid="cmp-match-row"][data-label="お見積金額"]');
  await expect(paired).toContainText("お見積金額 ⇔ お支払金額");
  await expect(paired.getByTestId("cmp-status")).toHaveText("一致");
  await expect(paired.getByTestId("cmp-reason")).toContainText("手動で対応づけ");
  await expect(page.locator('[data-testid="cmp-match-row"][data-label="お支払金額"]')).toHaveCount(0);
  expect(await summary.textContent()).not.toBe(before);

  // 「比べる」を外すと、件数から外れる
  const total = async () => Number(/^(\d+)項目/.exec((await summary.textContent()) ?? "")?.[1]);
  const n = await total();
  await page.locator('[data-testid="cmp-match-row"][data-label="担当者"]').getByTestId("cmp-include").uncheck();
  await expect.poll(total).toBe(n - 1);
});

test("office-compare: 同じ項目が1つのファイルに複数あり値が違うときは「要確認」にする。項目を取り出せないときは理由を案内する", async ({ page }) => {
  const dir = tmpDir();
  const a = writeDocx(dir, "dup-a.docx", [para("金額：1,000円"), para("金額：2,000円"), para("氏名：山田 太郎")]);
  const b = writeDocx(dir, "dup-b.docx", [para("金額：1000"), para("氏名：山田太郎")]);
  await openTool(page);
  await compare(page, a, b, "match");
  const amount = page.locator('[data-testid="cmp-match-row"][data-label="金額"]');
  await expect(amount.getByTestId("cmp-status")).toHaveText("要確認");
  await expect(amount.getByTestId("cmp-reason")).toContainText("同じ項目が複数あり");
  // 空白の位置だけが違う名前は、同じ人と断定しない
  await expect(page.locator('[data-testid="cmp-match-row"][data-label="氏名"]').getByTestId("cmp-status")).toHaveText("要確認");

  const c = writeDocx(dir, "prose.docx", [para("これは項目の形になっていない、ただの文章です。")]);
  await page.getByTestId("cmp-clear-a").click();
  await choose(page, "a", c);
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toContainText("ファイルAから、照合できる「項目と値」を取り出せませんでした");
});

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

function xlsxStrings(file: string): string {
  const z = unzipSync(fs.readFileSync(file));
  return Object.keys(z)
    .filter((k) => /sharedStrings|worksheets\/sheet|workbook\.xml$/.test(k))
    .map((k) => strFromU8(z[k]))
    .join("\n");
}

function docxXml(file: string): string {
  return strFromU8(unzipSync(fs.readFileSync(file))["word/document.xml"]);
}

test("office-compare: 差分の結果を、Excel・Wordで保存でき、画面と同じ件数・値が入る（ファイル名は半角英数字）", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "export-a.xlsx", SALES_A);
  const b = writeXlsx(dir, "export-b.xlsx", [{ ...SALES_A[0], rows: SALES_A[0].rows.map((r, i) => (i === 3 ? ["合計", 12000, null] : r)) }]);
  await openTool(page);
  await compare(page, a, b);
  const count = await page.getByTestId("cmp-diff-row").count();
  expect(count).toBe(2);

  const xl = await clickAndDownload(page, "Excelでダウンロード");
  expect(xl.suggestedFilename()).toMatch(/^file-diff-\d{8}-\d{4}\.xlsx$/);
  const xlFile = await assertDownloadedFile(xl, { format: "zip", minBytes: 500 });
  const strings = xlsxStrings(xlFile.path);
  for (const v of ["比較結果", "概要", "export-a.xlsx", "export-b.xlsx", "値が変更", "シートが削除", "旧シート", "10000", "12000", "差分の件数", "2件"]) expect(strings).toContain(v);

  await page.getByTestId("cmp-export-docx").click();
  const wd = await clickAndDownload(page, "Wordでダウンロード");
  expect(wd.suggestedFilename()).toMatch(/^file-diff-\d{8}-\d{4}\.docx$/);
  const wdFile = await assertDownloadedFile(wd, { format: "zip", minBytes: 500 });
  const xml = docxXml(wdFile.path);
  for (const v of ["比較レポート", "ファイルの差分を調べる（Excel同士）", "export-a.xlsx", "差分の件数", "値が変更", "シートが削除", "12000"]) expect(xml).toContain(v);
  // A4横・表は固定幅（はみ出さない）
  expect(xml).toMatch(/w:orient="landscape"/);
  expect(xml).toMatch(/<w:tblLayout w:type="fixed"\/>/);
  // 表の行数（見出し＋差分2件）
  expect((xml.match(/<w:tr>|<w:tr /g) ?? []).length).toBe(3);
});

test("office-compare: 違いがない場合も、正常に完了したレポートを保存できる。照合の結果もExcelで保存できる", async ({ page }) => {
  const dir = tmpDir();
  const a = writeDocx(dir, "same1.docx", [para("同じ文章")]);
  const b = writeDocx(dir, "same2.docx", [para("同じ文章")]);
  await openTool(page);
  await compare(page, a, b);
  await expect(page.getByTestId("cmp-summary")).toContainText("違いはありませんでした");
  await page.getByTestId("cmp-export-docx").click();
  const wd = await clickAndDownload(page, "Wordでダウンロード");
  const xml = docxXml((await assertDownloadedFile(wd, { format: "zip" })).path);
  expect(xml).toContain("違いはありませんでした");

  await page.getByTestId("cmp-mode-match").click();
  await page.getByTestId("cmp-clear-a").click();
  await page.getByTestId("cmp-clear-b").click();
  await choose(page, "a", quoteXlsx(dir));
  await choose(page, "b", orderDocx(dir));
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toContainText("項目を照合しました");
  const rows = await page.getByTestId("cmp-match-row").count();
  await page.getByTestId("cmp-export-xlsx").click();
  const xl = await clickAndDownload(page, "Excelでダウンロード");
  expect(xl.suggestedFilename()).toMatch(/^document-match-\d{8}-\d{4}\.xlsx$/);
  const strings = xlsxStrings((await assertDownloadedFile(xl, { format: "zip" })).path);
  for (const v of ["項目（ファイルA）", "判定の理由", "一致", "不一致", "片方に記載なし", "要確認", "100,000円", "照合のルール", `照合した項目`, `${rows}件`]) expect(strings).toContain(v);
});

// ---------------------------------------------------------------------------
// 入力の確認・安全性・大量の差分
// ---------------------------------------------------------------------------

test("office-compare: 未選択では押せず、古い形式・パスワード付き・壊れたファイル・対応外の形式は、理由を出して受け付けない", async ({ page }) => {
  const dir = tmpDir();
  await openTool(page);
  await expect(page.getByTestId("cmp-run")).toBeDisabled();
  await expect(page.getByText("2つのファイルを選ぶと、「比べる」を押せます。")).toBeVisible();

  const xls = path.join(dir, "old.xls");
  fs.writeFileSync(xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  await page.getByTestId("cmp-slot-a").locator('input[type="file"]').setInputFiles(xls);
  // 画面の移動を読み上げる要素（Next.js）も role="alert" を持つため、文で絞る
  const alert = { toContainText: (t: string) => expect(page.getByRole("alert").filter({ hasText: t })).toBeVisible() };
  await alert.toContainText("古い形式（.xls）は読み込めません");

  const locked = path.join(dir, "locked.xlsx");
  fs.writeFileSync(locked, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
  await page.getByTestId("cmp-slot-a").locator('input[type="file"]').setInputFiles(locked);
  await alert.toContainText("パスワードで保護されたファイル");

  const broken = path.join(dir, "broken.docx");
  fs.writeFileSync(broken, "これはWordではありません");
  await page.getByTestId("cmp-slot-a").locator('input[type="file"]').setInputFiles(broken);
  await alert.toContainText("ファイルが壊れているか");
  await expect(page.getByTestId("cmp-file-a")).toHaveCount(0);

  // ZIPだが中身がWordでない（壊れた）ファイルは、比べるときに理由を出す
  const fake = path.join(dir, "fake.docx");
  fs.writeFileSync(fake, buildCompareXlsx([{ name: "x", rows: [["a"]] }]));
  const ok = writeDocx(dir, "ok.docx", [para("本文")]);
  await choose(page, "a", fake);
  await choose(page, "b", ok);
  await page.getByTestId("cmp-run").click();
  await alert.toContainText("Wordの文書として読み取れませんでした");
});

test("office-compare: 入れ替えると、AとBが入れ替わる。元のファイルは変更されず、ファイルの中身は外部へ送信されない", async ({ page, baseURL }) => {
  const dir = tmpDir();
  const a = quoteXlsx(dir);
  const b = orderDocx(dir);
  const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const before = [hash(a), hash(b)];
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  await page.getByTestId("cmp-mode-match").click();
  await choose(page, "a", a);
  await choose(page, "b", b);
  await page.getByTestId("cmp-swap").click();
  await expect(page.getByTestId("cmp-file-a")).toHaveText("order.docx");
  await expect(page.getByTestId("cmp-file-b")).toHaveText("estimate.xlsx");
  await page.getByTestId("cmp-run").click();
  await expect(page.getByTestId("cmp-summary")).toContainText("項目を照合しました");
  await clickAndDownload(page, "Excelでダウンロード");
  expect([hash(a), hash(b)]).toEqual(before);
  expect(findLeakedRequests(recorder, MARKER)).toEqual([]);
  expect(findLeakedRequests(recorder, encodeURIComponent(MARKER))).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("office-compare: 差分が大量でも、先頭の300件を表示し「さらに表示」で続きが見られる。件数で絞り込める", async ({ page }) => {
  const dir = tmpDir();
  const a = writeXlsx(dir, "big-a.xlsx", [{ name: "大量", rows: Array.from({ length: 2000 }, (_, i) => [`行${i}`, i]) }]);
  const b = writeXlsx(dir, "big-b.xlsx", [{ name: "大量", rows: Array.from({ length: 2000 }, (_, i) => [`行${i}`, i + 1]) }]);
  await openTool(page);
  await compare(page, a, b);
  await expect(page.getByTestId("cmp-summary")).toContainText("違いが 2,000件");
  await expect(page.getByTestId("cmp-diff-row")).toHaveCount(300);
  await page.getByTestId("cmp-more").click();
  await expect(page.getByTestId("cmp-diff-row")).toHaveCount(600);
  await page.getByRole("button", { name: /^値が変更（2000）$/ }).click();
  await expect(page.getByTestId("cmp-diff-row")).toHaveCount(300);
});

test.describe("スマートフォンの幅", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("office-compare: 選ぶ・比べる・結果の確認ができ、ページが横にはみ出さない", async ({ page }) => {
    const dir = tmpDir();
    await openTool(page);
    await compare(page, quoteXlsx(dir), orderDocx(dir), "match");
    await expect(page.getByTestId("cmp-match-row").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
