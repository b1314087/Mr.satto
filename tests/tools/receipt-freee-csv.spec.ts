import { test, expect } from "@playwright/test";
import { buildGenericCsv, buildGenericCsvRows, GENERIC_CSV_HEADER } from "@/lib/accounting/csv-generic";
import {
  EMPTY_FREEE_ROW_OVERRIDE,
  EMPTY_FREEE_SETTINGS,
  FREEE_CSV_HEADER,
  buildFreeeCsv,
  buildFreeeCsvBlob,
  buildFreeeCsvRows,
  resolveFreeeRow,
  validateFreeeSettings,
  type FreeeRecord,
  type FreeeSettings,
} from "@/lib/accounting/csv-freee";
import { parseCsv } from "@/lib/utils/csv";

/**
 * freee会計向けCSV（取引インポート用）の単体テスト（工程10）。ブラウザは使わない。すべて架空のデータ。
 *
 * 基準：freee公式ヘルプ「取引・口座振替のインポート（一括登録）」と、そこに添付の公式サンプル
 * 「【サンプル】取引インポート（UTF-8 BOM付き）.csv」。工程10で、サンプルのバイト列を取得して確かめた事実：
 *   - 1行目は下の21列（同じ順序）
 *   - 先頭3バイトが EF BB BF（UTF-8のBOM）、改行は CRLF、末尾の改行はなし
 *   - 日付はスラッシュ区切り、金額は数字だけ（カンマなし）、決済日・決済口座・決済金額は最後の3列
 * 公式サンプルのファイルそのものは、再配布してよい条件が確認できないため、リポジトリには置いていない。
 * このテストは、その構造（列名・順序・BOM・改行）を、テスト用に書き写した定数と照合する。
 */

/** 公式サンプルの1行目（工程10に取得して確認した列名・順序） */
const OFFICIAL_SAMPLE_HEADER = [
  "収支区分",
  "管理番号",
  "発生日",
  "決済期日",
  "取引先コード",
  "取引先",
  "勘定科目",
  "税区分",
  "金額",
  "税計算区分",
  "税額",
  "備考",
  "品目",
  "部門",
  "メモタグ（複数指定可、カンマ区切り）",
  "セグメント1",
  "セグメント2",
  "セグメント3",
  "決済日",
  "決済口座",
  "決済金額",
];

const PAID: FreeeSettings = { direction: "支出", account: "消耗品費", taxCategory: "課対仕入10%", paymentMode: "paid", paymentAccount: "現金" };
const UNPAID: FreeeSettings = { ...PAID, paymentMode: "unpaid", paymentAccount: "" };

function record(partial: Partial<FreeeRecord> = {}): FreeeRecord {
  return { date: "2026-09-05", vendor: "株式会社テスト商店", total: 1320, account: "消耗品費", taxCategory: "課対仕入10%", ...partial };
}

test("freee-csv: 1行目が公式サンプルと同じ21列・同じ順序", () => {
  expect([...FREEE_CSV_HEADER]).toEqual(OFFICIAL_SAMPLE_HEADER);
  expect(FREEE_CSV_HEADER).toHaveLength(21);
  const rows = buildFreeeCsvRows([record()], PAID);
  expect(rows[0]).toEqual(OFFICIAL_SAMPLE_HEADER);
  for (const row of rows) expect(row).toHaveLength(21);
});

test("freee-csv: 必須項目（収支区分・発生日・取引先・勘定科目・税区分・金額）が正しい列に、正しい形式で出る", () => {
  const rows = buildFreeeCsvRows([record()], UNPAID);
  const row = rows[1];
  const col = (name: string) => row[OFFICIAL_SAMPLE_HEADER.indexOf(name)];
  expect(col("収支区分")).toBe("支出");
  expect(col("発生日")).toBe("2026/09/05"); // YYYY/MM/DD
  expect(col("取引先")).toBe("株式会社テスト商店");
  expect(col("勘定科目")).toBe("消耗品費");
  expect(col("税区分")).toBe("課対仕入10%");
  expect(col("金額")).toBe("1320"); // 数字だけ（カンマなし）・税込の合計金額
  // 使わない列は空欄（税額・税計算区分も推測しない）
  for (const name of ["管理番号", "決済期日", "取引先コード", "税計算区分", "税額", "備考", "品目", "部門", "メモタグ（複数指定可、カンマ区切り）", "セグメント1", "セグメント2", "セグメント3"]) {
    expect(col(name), name).toBe("");
  }
});

test("freee-csv: 支払い済みは決済日・決済口座・決済金額が入り、未決済は3つとも空欄", () => {
  const paid = buildFreeeCsvRows([record()], PAID)[1];
  expect(paid.slice(18)).toEqual(["2026/09/05", "現金", "1320"]);
  const unpaid = buildFreeeCsvRows([record()], UNPAID)[1];
  expect(unpaid.slice(18)).toEqual(["", "", ""]);
  // 未決済のとき、設定に決済口座が残っていても出さない
  const stale = buildFreeeCsvRows([record()], { ...UNPAID, paymentAccount: "現金" })[1];
  expect(stale.slice(18)).toEqual(["", "", ""]);
  const income = buildFreeeCsvRows([record()], { ...PAID, direction: "収入" })[1];
  expect(income[0]).toBe("収入");
});

test("freee-csv: UTF-8のBOM付き・改行CRLF・末尾の改行なし（公式サンプルと同じ）", async () => {
  const blob = buildFreeeCsvBlob([record(), record({ vendor: "B商店", total: 500 })], PAID)!;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder("utf-8").decode(bytes.slice(3));
  expect(text.split("\r\n")).toHaveLength(3); // ヘッダー＋2行
  expect(text.includes("\n")).toBe(true);
  expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false); // CRLF以外の改行がない
  expect(text.endsWith("\n")).toBe(false);
  expect(blob.type).toContain("text/csv");
});

test("freee-csv: 日本語・濁点・記号・カンマ・引用符を含む取引先が壊れない（パースし直して一致する）", () => {
  const vendors = [
    "カンマ,引用\"符\"店",
    "株式会社ガギグゲゴ（濃音）",
    "がぎぐげご゙商店", // 結合文字の濁点
    "①丸数字・㈱略称・髙橋商店・𠮷野家",
    "A&B <C> 'D' ¥100",
    "絵文字🍣寿司",
  ];
  const csv = buildFreeeCsv(vendors.map((v) => record({ vendor: v })), PAID)!;
  const parsed = parseCsv(csv);
  expect(parsed).toHaveLength(vendors.length + 1);
  parsed.slice(1).forEach((cells, i) => {
    expect(cells, vendors[i]).toHaveLength(21);
    expect(cells[5]).toBe(vendors[i]);
    expect(cells[8]).toBe("1320");
  });
});

test("freee-csv: 数式インジェクション対策が維持される（取引先は先頭に「'」、勘定科目・税区分・決済口座は入力し直し）", () => {
  const out = buildFreeeCsvRows(
    ["=SUM(A1:A2)", "+1+1", "-2+3", "@cmd", "\tTAB", "普通の店", "A=B"].map((v) => record({ vendor: v })),
    PAID,
  ).slice(1);
  expect(out.map((r) => r[5])).toEqual(["'=SUM(A1:A2)", "'+1+1", "'-2+3", "'@cmd", "'\tTAB", "普通の店", "A=B"]);

  const bad = ["=1+1", "+x", "-x", "@x"];
  for (const v of bad) {
    const account = resolveFreeeRow({ date: "2026-09-05", vendor: "店", total: 100 }, { account: v, taxCategory: "" }, PAID);
    expect(account.resolved, v).toBeNull();
    expect(account.errors.join("")).toContain("勘定科目の先頭に");
    const tax = resolveFreeeRow({ date: "2026-09-05", vendor: "店", total: 100 }, { account: "", taxCategory: v }, PAID);
    expect(tax.resolved, v).toBeNull();
    expect(tax.errors.join("")).toContain("税区分の先頭に");
    expect(validateFreeeSettings({ ...PAID, paymentAccount: v }).join("")).toContain("決済口座の先頭に");
  }
});

test("freee-csv: 共通の設定が未入力なら、不足項目と直し方を返す。設定に初期値はない", () => {
  expect(EMPTY_FREEE_SETTINGS).toEqual({ direction: "", account: "", taxCategory: "", paymentMode: "", paymentAccount: "" });
  const none = validateFreeeSettings(EMPTY_FREEE_SETTINGS);
  expect(none).toHaveLength(2);
  expect(none[0]).toContain("収支区分を選んでください");
  expect(none[1]).toContain("支払い状況を選んでください");
  // 支払い済みで決済口座が空
  const noAccount = validateFreeeSettings({ ...EMPTY_FREEE_SETTINGS, direction: "収入", paymentMode: "paid" });
  expect(noAccount).toHaveLength(1);
  expect(noAccount[0]).toContain("決済口座が入力されていません");
  expect(noAccount[0]).toContain("freeeに登録されている口座の名前");
  expect(validateFreeeSettings(PAID)).toEqual([]);
  expect(validateFreeeSettings(UNPAID)).toEqual([]);
});

test("freee-csv: 勘定科目・税区分は、行の入力があればそれを、なければ共通の入力を使う。どちらも空なら理由つきのエラー", () => {
  const base = { date: "2026-09-05", vendor: "店", total: 100 };
  const shared = { ...PAID, account: "旅費交通費", taxCategory: "課対仕入10%" };
  expect(resolveFreeeRow(base, EMPTY_FREEE_ROW_OVERRIDE, shared).resolved).toMatchObject({ account: "旅費交通費", taxCategory: "課対仕入10%" });
  expect(resolveFreeeRow(base, { account: "会議費", taxCategory: "" }, shared).resolved).toMatchObject({ account: "会議費", taxCategory: "課対仕入10%" });
  expect(resolveFreeeRow(base, { account: "  ", taxCategory: "対象外" }, shared).resolved).toMatchObject({ account: "旅費交通費", taxCategory: "対象外" });

  const missing = resolveFreeeRow(base, EMPTY_FREEE_ROW_OVERRIDE, EMPTY_FREEE_SETTINGS);
  expect(missing.resolved).toBeNull();
  expect(missing.errors).toHaveLength(2);
  expect(missing.errors[0]).toContain("勘定科目が入力されていません");
  expect(missing.errors[1]).toContain("税区分が入力されていません");
  expect(missing.errors.join("")).toContain("この行の入力欄に入力できます");

  const tooLong = resolveFreeeRow(base, { account: "あ".repeat(256), taxCategory: "い".repeat(255) }, shared);
  expect(tooLong.errors).toHaveLength(1);
  expect(tooLong.errors[0]).toContain("勘定科目が長すぎます");
});

test("freee-csv: 確認済みが0件ならCSVを作らない", () => {
  expect(buildFreeeCsv([], PAID)).toBeNull();
  expect(buildFreeeCsvBlob([], PAID)).toBeNull();
});

test("freee-csv: 汎用CSVの出力は、freee対応を足しても変わらない", () => {
  expect([...GENERIC_CSV_HEADER]).toEqual(["日付", "取引先", "合計金額"]);
  const records = [
    { date: "2026-09-15", vendor: "株式会社テスト商店", total: 1320 },
    { date: "2026-09-16", vendor: "=SUM(A1:A2)", total: 500 },
  ];
  expect(buildGenericCsvRows(records)).toEqual([
    ["日付", "取引先", "合計金額"],
    ["2026/09/15", "株式会社テスト商店", "1320"],
    ["2026/09/16", "'=SUM(A1:A2)", "500"],
  ]);
  expect(buildGenericCsv(records)).toBe("﻿日付,取引先,合計金額\r\n2026/09/15,株式会社テスト商店,1320\r\n2026/09/16,'=SUM(A1:A2),500");
  expect(buildGenericCsv([])).toBeNull();
});

test("freee-csv: 数式対策の「'」は1回だけ付き、CSVの引用符と二重にならない（パースし直すと「'」が1つ）", () => {
  const vendors = ["=1,2", '+A"B"', "-カンマ,店", "@SUM(1)", "'=すでに引用符", "=普通"];
  const csv = buildFreeeCsv(vendors.map((v) => record({ vendor: v })), UNPAID)!;
  const parsed = parseCsv(csv).slice(1).map((cells) => cells[5]);
  expect(parsed).toEqual(["'=1,2", "'+A\"B\"", "'-カンマ,店", "'@SUM(1)", "'=すでに引用符", "'=普通"]);
  // CSVの書式としては、カンマ・引用符を含む場合だけ全体を囲む
  expect(csv).toContain(',"\'=1,2",');
  expect(csv).toContain(',"\'+A""B""",');
  // 数式対策は、パースした値の先頭が「'」になっていること（「=」「+」「-」「@」で始まるセルが残らない）で確認する
  for (const cells of parseCsv(csv).slice(1)) {
    for (const cell of cells) expect(/^[=+\-@\t\r]/.test(cell), cell).toBe(false);
  }
});

test("freee-csv: 公式ヘルプのファイルサイズ上限（5MB）に、画面の上限（60件）の最悪ケースでも収まる", async () => {
  const worst = record({ vendor: "あ".repeat(255), account: "い".repeat(255), taxCategory: "う".repeat(255), total: 999_999_999 });
  const settings: FreeeSettings = { ...PAID, paymentAccount: "え".repeat(255) };
  const blob = buildFreeeCsvBlob(Array.from({ length: 60 }, () => worst), settings)!;
  expect(blob.size).toBeLessThan(5 * 1024 * 1024);
  expect(blob.size).toBeGreaterThan(60 * 255 * 3 * 3); // 日本語は1文字3バイト。巨大な値でも切り捨てず出していること
});

test("freee-csv: 空欄・前後の空白・制御文字の扱い（取引先は整えた値、勘定科目・税区分も前後の空白は除く）", () => {
  const out = resolveFreeeRow({ date: "2026-09-05", vendor: "店", total: 100 }, { account: "  消耗品費  ", taxCategory: "\t課対仕入10%\u200b" }, UNPAID);
  expect(out.resolved).toMatchObject({ account: "消耗品費", taxCategory: "課対仕入10%" });
  // 空白・制御文字だけの入力は、未入力として扱う
  const blank = resolveFreeeRow({ date: "2026-09-05", vendor: "店", total: 100 }, { account: "\u200b", taxCategory: " " }, EMPTY_FREEE_SETTINGS);
  expect(blank.resolved).toBeNull();
  expect(blank.errors).toHaveLength(2);
});
