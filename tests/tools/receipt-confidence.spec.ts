import { test, expect } from "@playwright/test";
import { extractReceipt } from "../../src/lib/accounting/receipt-extract";
import { AUTOFILL_STOP_CONFIDENCE, LOW_CONFIDENCE_THRESHOLD, type TextLine } from "../../src/lib/accounting/receipt-types";

/**
 * OCRの信頼度の扱い（工程12）の単体テスト。信頼度は、架空の値を直接与える（実際のOCRは使わない）。
 * ・60未満：値は入れるが「要確認」の印（工程9から変更なし）
 * ・40未満：値を自動では入れず、候補として示す（工程12で追加）
 * 信頼度が高いことは、読み取りが正しいことを保証しない（数字の読み違いは、信頼度が高くても起こりうる）。
 */

const L = (text: string, confidence: number | null): TextLine => ({ text, confidence });

test("confidence: しきい値の関係（自動入力を止める値は、要確認の印より低い）", () => {
  expect(AUTOFILL_STOP_CONFIDENCE).toBe(40);
  expect(LOW_CONFIDENCE_THRESHOLD).toBe(60);
  expect(AUTOFILL_STOP_CONFIDENCE).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
});

test("confidence: 40以上なら自動で入れる（40ちょうども入れる）。60未満は要確認の印つき", () => {
  const r = extractReceipt([L("株式会社あ商事", 95), L("2026/09/15", 40), L("合計 ¥1,320", 59)]);
  expect(r.date.value).toBe("2026-09-15");
  expect(r.date.lowConfidence).toBe(true);
  expect(r.total.value).toBe("1320");
  expect(r.total.lowConfidence).toBe(true);
  expect(r.vendor.value).toBe("株式会社あ商事");
  expect(r.vendor.lowConfidence).toBe(false);
});

test("confidence: 40未満の行から読んだ合計金額は、自動で入れず、候補に残して理由を示す", () => {
  const r = extractReceipt([L("株式会社あ商事", 95), L("2026/09/15", 95), L("合計 ¥1,320", 39)]);
  expect(r.total.value).toBeNull();
  expect(r.total.candidates.map((c) => c.value)).toContain("1320");
  expect(r.total.note).toContain("自信がとても低い");
  expect(r.total.lowConfidence).toBe(false);
  // 他の項目には影響しない
  expect(r.date.value).toBe("2026-09-15");
  expect(r.vendor.value).toBe("株式会社あ商事");
});

test("confidence: 40未満の行から読んだ日付・取引先も、自動で入れず候補に残す", () => {
  const r = extractReceipt([L("株式会社あ商事", 10), L("2026/09/15", 0), L("合計 ¥1,320", 95)]);
  expect(r.date.value).toBeNull();
  expect(r.date.candidates.map((c) => c.value)).toEqual(["2026-09-15"]);
  expect(r.date.note).toContain("日付");
  expect(r.vendor.value).toBeNull();
  expect(r.vendor.candidates.map((c) => c.value)).toEqual(["株式会社あ商事"]);
  expect(r.vendor.note).toContain("取引先");
  expect(r.total.value).toBe("1320");
});

test("confidence: 信頼度が無い（文字情報から取り出した行）場合は、止めない", () => {
  const r = extractReceipt([L("株式会社あ商事", null), L("2026/09/15", null), L("合計 ¥1,320", null)]);
  expect(r.date.value).toBe("2026-09-15");
  expect(r.total.value).toBe("1320");
  expect(r.vendor.value).toBe("株式会社あ商事");
  expect(r.total.lowConfidence).toBe(false);
});

test("confidence: 信頼度が高くても、元の値が曖昧なときの従来の挙動（候補が複数なら入れない）は変わらない", () => {
  const r = extractReceipt([L("2026/09/15", 95), L("2026/09/20", 95)]);
  expect(r.date.value).toBeNull();
  expect(r.date.note).toContain("複数");
});
