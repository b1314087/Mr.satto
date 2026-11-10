import { checkMasterText, buildFreeeCsvRows, FREEE_CSV_HEADER, type FreeeRecord, type FreeeSettings } from "./csv-freee";
import type { CsvRecord } from "./csv-generic";
import { serializeCsv } from "@/lib/utils/csv";
import type { SheetData } from "write-excel-file/universal";

/**
 * 領収書・レシートから freee会計向けのデータを作る（新工程1）。純粋な関数だけ。
 *
 * 出力の形式は、これまでと同じ freee会計の「取引インポート」用CSV（公式サンプルと同じ21列・同じ順序。src/lib/accounting/csv-freee.ts）。
 * 画面の「借方勘定科目・貸方勘定科目・課税区分」は、取引インポートの列に次のように対応させる。
 * - 収支区分：「支出」（領収書・レシートは、支払った取引として登録する）
 * - 借方勘定科目 → 「勘定科目」（例：消耗品費。費用の科目）
 * - 貸方勘定科目 → 「決済口座」（例：現金・普通預金。支払いに使った口座）。入力したときは決済済みの取引として、
 *   決済日＝発生日・決済金額＝金額を出す。空欄のときは、決済日・決済口座・決済金額を空欄にし、未決済（未払金）の取引になる
 *   （これで、以前の「支払い状況」の選択は不要になった）
 * - 課税区分 → 「税区分」
 * - 摘要 → 「備考」
 *
 * 課税区分の選択肢は、freee会計の公式ヘルプ・公式の取引インポート用サンプルに出ている、仕入・経費の税区分の名前だけを使う
 * （このツールが名前を作ることはしない）。使える税区分は、freeeの設定（事業者区分・課税方式・取引日）で変わるため、
 * 一覧にない名前は「その他」から、freeeの画面に表示されている名前をそのまま入力する。
 */

/** 課税区分の選択肢（freee会計の公式資料にある、仕入・経費の税区分の名前） */
export const FREEE_TAX_CATEGORY_OPTIONS: { value: string; note: string }[] = [
  { value: "課対仕入10%", note: "10%の課税仕入（登録番号のある請求書・領収書など）" },
  { value: "課対仕入8%（軽）", note: "軽減税率8%の課税仕入（飲食料品など）" },
  { value: "課対仕入（控80）10%", note: "登録番号のない取引先からの10%の仕入（経過措置・控除80%）" },
  { value: "課対仕入（控80）8%（軽）", note: "登録番号のない取引先からの軽減税率8%の仕入（経過措置・控除80%）" },
  { value: "課対仕入（控70）10%", note: "登録番号のない取引先からの10%の仕入（経過措置・控除70%）" },
  { value: "課対仕入（控70）8%（軽）", note: "登録番号のない取引先からの軽減税率8%の仕入（経過措置・控除70%）" },
  { value: "非課仕入", note: "非課税の仕入" },
  { value: "対象外", note: "不課税の取引（消費税の対象外）" },
];

/** プルダウンの「その他」を表す値（選んだときは、名前を入力する欄を出す） */
export const FREEE_TAX_CATEGORY_OTHER = "__other__";

/** 読み取りを始める前に決める初期値（読み取った明細に、最初からこの値を入れる）。保存はしない */
export interface ReceiptJournalDefaults {
  debitAccount: string;
  creditAccount: string;
  taxCategory: string;
}

export const EMPTY_RECEIPT_JOURNAL_DEFAULTS: ReceiptJournalDefaults = { debitAccount: "", creditAccount: "", taxCategory: "" };

/** 明細ごとの仕訳の項目 */
export interface ReceiptJournalFields extends ReceiptJournalDefaults {
  memo: string;
}

const FIX_DEBIT = "freeeに登録されている勘定科目の名前（例：消耗品費）を入力してください。";
const FIX_CREDIT = "freeeに登録されている口座の名前（例：現金）を入力するか、未決済にするときは空欄にしてください。";
const FIX_TAX = "課税区分を選んでください。";

/** 明細の仕訳の項目を確かめる（借方勘定科目・課税区分は必須。貸方勘定科目は空欄＝未決済） */
export function validateJournalFields(fields: ReceiptJournalFields): string[] {
  const errors: string[] = [];
  const debit = checkMasterText(fields.debitAccount, "借方勘定科目", FIX_DEBIT);
  if (debit.error) errors.push(debit.error);
  const tax = checkMasterText(fields.taxCategory, "課税区分", FIX_TAX);
  if (tax.error) errors.push(tax.error);
  if (fields.creditAccount.trim() !== "") {
    const credit = checkMasterText(fields.creditAccount, "貸方勘定科目", FIX_CREDIT);
    if (credit.error) errors.push(credit.error);
  }
  return errors;
}

/** 確認済みの明細を、freee向けの1行（FreeeRecord）にする。項目に不備があるときは null */
export function toFreeeRecord(record: CsvRecord, fields: ReceiptJournalFields): FreeeRecord | null {
  if (validateJournalFields(fields).length > 0) return null;
  return {
    ...record,
    account: checkMasterText(fields.debitAccount, "", "").value!,
    taxCategory: checkMasterText(fields.taxCategory, "", "").value!,
    paymentAccount: fields.creditAccount,
    memo: fields.memo,
  };
}

/** 収支区分は「支出」。決済口座は行ごとに決める（FreeeRecord.paymentAccount） */
const RECEIPT_FREEE_SETTINGS: FreeeSettings = { direction: "支出", account: "", taxCategory: "", paymentMode: "unpaid", paymentAccount: "" };

/** freee向けの行（ヘッダーを含む）。プレビュー・CSV・Excel は、すべてこの行から作る（内容を一致させる） */
export function buildReceiptFreeeRows(records: FreeeRecord[]): string[][] {
  return buildFreeeCsvRows(records, RECEIPT_FREEE_SETTINGS);
}

export function buildReceiptFreeeCsvBlob(records: FreeeRecord[]): Blob | null {
  if (records.length === 0) return null;
  return new Blob([serializeCsv(buildReceiptFreeeRows(records))], { type: "text/csv;charset=utf-8" });
}

/** 金額の列（金額・決済金額）。Excelでは数値のセルにする */
const AMOUNT_COLUMNS = new Set([FREEE_CSV_HEADER.indexOf("金額"), FREEE_CSV_HEADER.indexOf("決済金額")]);

/** Excelのセル：CSVと同じ文字（数式にならないよう、文字のセルとして書く）。金額だけは数値 */
export function receiptFreeeRowsToXlsx(rows: string[][]): unknown[][] {
  return rows.map((row, r) =>
    row.map((text, c) => {
      if (text === "") return null;
      if (r > 0 && AMOUNT_COLUMNS.has(c) && /^\d+$/.test(text)) return { value: Number(text), type: Number, format: "#,##0" };
      return { value: text, type: String, ...(r === 0 ? { fontWeight: "bold" } : {}) };
    }),
  );
}

export async function buildReceiptFreeeXlsxBlob(records: FreeeRecord[]): Promise<Blob | null> {
  if (records.length === 0) return null;
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  return writeXlsxFile(receiptFreeeRowsToXlsx(buildReceiptFreeeRows(records)) as unknown as SheetData, { stickyRowsCount: 1 }).toBlob();
}
