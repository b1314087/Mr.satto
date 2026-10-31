import { toIsoDate } from "./receipt-extract";
import { TOTAL_MAX_YEN, VENDOR_MAX_LENGTH, type ReceiptEditableValues, type RowValidation } from "./receipt-types";

/**
 * 確認画面の入力値（文字）を検証し、CSVに出せる値へ変換する（工程8）。純粋な関数だけ。
 * 画面の入力欄に入っている文字をそのまま渡す。
 */

/** 制御文字・見えない文字（ゼロ幅、左右方向の制御など）。取引先から取り除く */
const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/** 取引先の文字を整える（改行・タブ・制御文字を除き、連続する空白を1つにして、前後の空白を除く） */
export function sanitizeVendor(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(INVISIBLE_OR_CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 金額の入力文字を整数の円にする。全角数字、カンマ、「¥」「円」、前後の空白は許す。
 * 空・数字以外が混じる・小数・0以下・上限超過は null（理由は validateRow が返す）。
 */
export function parseAmountInput(raw: string): number | null {
  const text = raw
    .normalize("NFKC")
    .replace(/[¥\\,\s円]/g, "");
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > TOTAL_MAX_YEN) return null;
  return n;
}

/** 日付の入力文字（YYYY-MM-DD。日付の入力欄の値）を確かめる。実在しない日付・形式違いは null */
export function parseDateInput(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export interface ValidateOptions {
  /** 今日の日付（YYYY-MM-DD）。未来の日付の注意に使う。テストで固定できるように外から渡す */
  today: string;
}

/** 1行の入力値を検証する */
export function validateRow(values: ReceiptEditableValues, options: ValidateOptions): RowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const dateText = values.date.trim();
  const date = parseDateInput(dateText);
  if (dateText === "") errors.push("日付が入力されていません。");
  else if (date === null) errors.push("日付が正しくありません（1989年〜2099年の、実在する日付を入力してください）。");
  else if (date > options.today) warnings.push("日付が今日より先になっています。間違いがないか確認してください。");

  const vendor = sanitizeVendor(values.vendor);
  if (vendor === "") errors.push("取引先が入力されていません。");
  else if (vendor.length > VENDOR_MAX_LENGTH) errors.push(`取引先が長すぎます（${VENDOR_MAX_LENGTH}文字までです）。`);
  else if (/\d{2,4}-\d{2,4}-\d{3,4}|〒|\d{3}-\d{4}/.test(vendor)) {
    warnings.push("取引先が、電話番号や住所のように見えます。店名・会社名になっているか確認してください。");
  }

  const totalText = values.total.trim();
  const total = parseAmountInput(totalText);
  if (totalText === "") errors.push("合計金額が入力されていません。");
  else if (total === null) {
    errors.push(`合計金額が正しくありません（1円以上${TOTAL_MAX_YEN.toLocaleString("ja-JP")}円以下の整数を入力してください）。`);
  } else if (total >= 1_000_000) warnings.push("合計金額が100万円以上です。桁の読み間違いがないか確認してください。");

  if (errors.length > 0 || date === null || total === null) return { errors, warnings, normalized: null };
  return { errors, warnings, normalized: { date, vendor, total } };
}

/** 同じ（日付・取引先・金額）の行が複数あるとき、2つ目以降の行のキーを返す（重複の注意に使う。削除はしない） */
export function duplicateKeys(rows: { id: string; values: ReceiptEditableValues }[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const date = parseDateInput(row.values.date);
    const vendor = sanitizeVendor(row.values.vendor);
    const total = parseAmountInput(row.values.total);
    if (date === null || vendor === "" || total === null) continue;
    const key = `${date}|${vendor}|${total}`;
    if (seen.has(key)) duplicates.add(row.id);
    else seen.add(key);
  }
  return duplicates;
}
