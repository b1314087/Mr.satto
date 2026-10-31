import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { FIELDS, formatRealSummary, judgeFromUi, needsManualFix, parseTruthCsv, summarizeReal, type RealDocResult } from "../helpers/receipt-real-eval";

/**
 * 実物の領収書の評価に使う、正解表の読み込み・判定・集計の単体テスト（工程12）。ブラウザは使わない。値はすべて架空。
 * 実物の評価を行った結果ではない。
 */

test("real-eval: 同梱のひな型（架空の例）を、問題なく読み込める", () => {
  const text = fs.readFileSync(path.join(process.cwd(), "tests/fixtures/real-eval/truth.template.csv"), "utf8");
  const r = parseTruthCsv(text);
  expect(r.errors).toEqual([]);
  expect(r.entries).toHaveLength(3);
  expect(r.entries[0]).toMatchObject({ rowNumber: 2, file: "receipt-001.jpg", date: "2026-09-15", vendor: "株式会社サンプル商店", total: 1320 });
  expect(r.entries[2]).toMatchObject({ date: null, vendor: null, total: null }); // 書類に項目が無い行
});

test("real-eval: 正解表の不備は、行番号つきの理由で知らせる（値は含めない）", () => {
  expect(parseTruthCsv("").errors).toHaveLength(1);
  expect(parseTruthCsv("a,b,c,d\n").errors[0]).toContain("見出し");
  const bad = parseTruthCsv(
    ["file,date,vendor,total", "a.jpg,2026-02-30,店,100", "b.jpg,2026-09-01,店,1,320", "c.jpg,2026-09-01,店,12.5", "../d.jpg,,,", "a.jpg,,,", "ok.jpg,2026-09-01,店,0", "ok2.jpg,2026/09/01,店,100"].join("\n"),
  );
  expect(bad.entries).toEqual([]);
  expect(bad.errors.some((e) => e.startsWith("2行目") && e.includes("date"))).toBe(true); // 実在しない日付
  expect(bad.errors.some((e) => e.startsWith("3行目") && e.includes("列の数"))).toBe(true);
  expect(bad.errors.some((e) => e.startsWith("4行目") && e.includes("total"))).toBe(true);
  expect(bad.errors.some((e) => e.startsWith("5行目") && e.includes("ファイル名だけ"))).toBe(true); // 上位フォルダへ出る指定
  expect(bad.errors.some((e) => e.startsWith("7行目") && e.includes("total"))).toBe(true); // 0円
  expect(bad.errors.some((e) => e.startsWith("8行目") && e.includes("date"))).toBe(true); // スラッシュ区切り
  // 同じファイル名の重複
  const dup = parseTruthCsv(["file,date,vendor,total", "a.jpg,,,", "a.jpg,,,"].join("\n"));
  expect(dup.errors.some((e) => e.includes("2回"))).toBe(true);
  // 引用符・カンマを含む取引先
  const quoted = parseTruthCsv('file,date,vendor,total\na.jpg,2026-09-01,"カンマ,店",100');
  expect(quoted.errors).toEqual([]);
  expect(quoted.entries[0].vendor).toBe("カンマ,店");
});

test("real-eval: 画面の表示からの判定（自動入力・正解／自動入力・誤り／候補に正解／候補にも無し／正しく空）", () => {
  // 日付
  expect(judgeFromUi("date", "2026-09-15", [], "2026-09-15")).toBe("auto-correct");
  expect(judgeFromUi("date", "2026-09-16", [], "2026-09-15")).toBe("auto-wrong");
  expect(judgeFromUi("date", "", ["2026/09/15"], "2026-09-15")).toBe("blank-hit"); // 候補は表示形式（スラッシュ）
  expect(judgeFromUi("date", "", ["2026/09/14"], "2026-09-15")).toBe("blank-miss");
  expect(judgeFromUi("date", "", [], null)).toBe("blank-absent");
  expect(judgeFromUi("date", "2026-09-15", [], null)).toBe("auto-wrong"); // 書類に無い項目を入れた
  // 合計金額（候補は「1,320円」の表示）
  expect(judgeFromUi("total", "1320", [], "1320")).toBe("auto-correct");
  expect(judgeFromUi("total", "320", [], "1320")).toBe("auto-wrong");
  expect(judgeFromUi("total", "", ["1,320円", "1,500円"], "1320")).toBe("blank-hit");
  expect(judgeFromUi("total", "", ["1,500円"], "1320")).toBe("blank-miss");
  // 取引先（空白・全角半角・大文字小文字の違いは同じとみなす）
  expect(judgeFromUi("vendor", "ＡＢＣ　商店", [], "abc商店")).toBe("auto-correct");
  expect(judgeFromUi("vendor", "ABC商事", [], "ABC商店")).toBe("auto-wrong");
  expect(judgeFromUi("vendor", "", ["ABC商店"], "ABC商店")).toBe("blank-hit");
  expect(needsManualFix("auto-correct")).toBe(false);
  expect(needsManualFix("blank-absent")).toBe(false);
  expect(needsManualFix("auto-wrong")).toBe(true);
  expect(needsManualFix("blank-hit")).toBe(true);
  expect(needsManualFix("blank-miss")).toBe(true);
});

test("real-eval: 集計（自動入力の正解率・手直し・誤入力・低信頼表示との関係・失敗・対象外）と、個人情報を含まない出力", () => {
  const ok = { date: "auto-correct", vendor: "auto-correct", total: "auto-correct" } as const;
  const results: RealDocResult[] = [
    { rowNumber: 2, failed: false, rows: 1, outcomes: { ...ok }, lowConfidence: { date: false, vendor: false, total: false }, ms: 1000 },
    { rowNumber: 3, failed: false, rows: 1, outcomes: { ...ok, total: "auto-wrong" }, lowConfidence: { date: false, vendor: true, total: true }, ms: 2000 },
    { rowNumber: 4, failed: false, rows: 1, outcomes: { date: "blank-hit", vendor: "blank-miss", total: "blank-absent" }, lowConfidence: { date: false, vendor: false, total: false }, ms: 3000 },
    { rowNumber: 5, failed: true, rows: 0, ms: 4000 },
    { rowNumber: 6, failed: false, rows: 3, ms: 6000 },
  ];
  const s = summarizeReal(results);
  expect(s).toMatchObject({ documents: 5, failed: 1, excludedMultiRow: 1, evaluated: 3, docsWithAnyWrongAuto: 1, docsFullyClean: 1, averageMs: 3200 });
  expect(s.perField.total).toEqual({ "auto-correct": 1, "auto-wrong": 1, "blank-hit": 0, "blank-miss": 0, "blank-absent": 1 });
  expect(s.manualFix).toEqual({ date: 1, vendor: 1, total: 1 });
  expect(s.lowConfidenceAuto.total).toEqual({ correct: 0, wrong: 1 });
  expect(s.normalConfidenceAuto.total).toEqual({ correct: 1, wrong: 0 });
  expect(s.lowConfidenceAuto.vendor).toEqual({ correct: 1, wrong: 0 });
  for (const f of FIELDS) {
    const o = s.perField[f];
    expect(Object.values(o).reduce((a, b) => a + b, 0)).toBe(s.evaluated); // 各項目の合計が、評価した書類の数と一致
  }
  const md = formatRealSummary(s);
  expect(md).toContain("評価した書類：3");
  expect(md).toContain("読み取り失敗：1");
  expect(md).toContain("個人情報は含みません");
  expect(md).toContain("ほかの書類の精度を保証するものではありません");
  // 空の結果でも例外を出さない
  expect(summarizeReal([]).evaluated).toBe(0);
  expect(formatRealSummary(summarizeReal([]))).toContain("ファイル数：0");
});
