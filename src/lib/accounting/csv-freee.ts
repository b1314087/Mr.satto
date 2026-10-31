import { serializeCsv } from "@/lib/utils/csv";
import { neutralizeFormula } from "./csv-generic";
import { formatDateSlash } from "./receipt-extract";
import { sanitizeVendor } from "./receipt-validate";
import type { CsvRecord } from "./csv-generic";

/**
 * 確認済みの書類から、freee会計の「取引インポート」用CSVを作る（工程10）。純粋な関数だけ。
 *
 * 【根拠】freee公式ヘルプ「取引・口座振替のインポート（一括登録）」（更新日 2026年9月10日）と、
 * そのページに添付されている公式サンプル「【サンプル】取引インポート（UTF-8 BOM付き）.csv」（976バイト）。
 * 工程10で、サンプルのバイト列を実際に取得して確認した（詳細は docs/reports/stage10-freee-csv-implementation.md）。
 *
 * 公式資料で確認できていること（この実装が従っていること）:
 * - ヘッダー（1行目）は、サンプルと同じ21列を同じ順序で出す。ヘッダーは削除しない。
 * - 文字コードは UTF-8（BOM付き）、改行は CRLF（サンプルと同じ。末尾の改行はサンプルにないので付けない）。
 * - 必須：収支区分（「収入」「支出」のいずれか）・発生日・勘定科目・税区分・金額。
 * - 発生日は「YYYY/MM/DD」。金額は常に税込の、マイナスでない数字。
 * - 決済日・決済口座・決済金額は、決済済みの取引のとき必須。3つとも空欄にすると、未決済取引として登録される。
 * - 取引先は、freeeに未登録のものを書くと、freee上に新規作成される。
 *
 * この実装が推測していないこと（利用者の入力が必要で、初期値を入れない）:
 * 収支区分・勘定科目・税区分・支払い状況（決済済み/未決済）・決済口座。
 * 税区分・勘定科目の名前は、freeeの設定（事業者区分・課税方式・取引日）によって使えるものが変わるため、
 * このツールは一覧を持たず、利用者がfreeeの画面で確認した名前をそのまま入力する。
 *
 * 公式サンプルでは確認できていないこと（推測で埋めない）:
 * 税計算区分・税額は空欄にする（公式ヘルプに「空欄でも勘定科目と日付から自動で計算される」とある）。
 * 日付は、ヘルプの「YYYY/MM/DD」に従い、月日を2桁にそろえる（サンプルは「2024/2/1」のように0なし。どちらも日付として読めるはずだが、
 * freeeへの実際の取り込みでの確認はしていない）。
 */

/** 公式サンプルの1行目（ヘッダー）。列名・順序をサンプルと完全に一致させる */
export const FREEE_CSV_HEADER = [
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
] as const;

/** 勘定科目・税区分・決済口座の文字数の上限（公式ヘルプの「取引先・勘定科目は255文字」に合わせる） */
export const FREEE_TEXT_MAX_LENGTH = 255;

export type FreeeDirection = "" | "支出" | "収入";
export type FreeePaymentMode = "" | "paid" | "unpaid";

/** CSV全体に共通の設定（利用者が選ぶ・入力する。初期値は空で、推測して入れない） */
export interface FreeeSettings {
  direction: FreeeDirection;
  /** 全行に使う勘定科目（行ごとに上書きできる） */
  account: string;
  /** 全行に使う税区分（行ごとに上書きできる） */
  taxCategory: string;
  paymentMode: FreeePaymentMode;
  /** 支払い済みの場合の決済口座 */
  paymentAccount: string;
}

export const EMPTY_FREEE_SETTINGS: FreeeSettings = {
  direction: "",
  account: "",
  taxCategory: "",
  paymentMode: "",
  paymentAccount: "",
};

/** 行ごとの上書き（空欄なら共通の設定を使う） */
export interface FreeeRowOverride {
  account: string;
  taxCategory: string;
}

export const EMPTY_FREEE_ROW_OVERRIDE: FreeeRowOverride = { account: "", taxCategory: "" };

/** CSVに出せる状態になった1行 */
export interface FreeeRecord extends CsvRecord {
  account: string;
  taxCategory: string;
}

/** Excelで数式として実行されうる先頭の文字（タブ・復帰を含む） */
const FORMULA_START = /^[=+\-@\t\r]/;

function cleanText(raw: string): string {
  return sanitizeVendor(raw);
}

/**
 * 勘定科目・税区分・決済口座の文字を検証する。問題がなければ整えた文字を、問題があれば null と理由を返す。
 * これらはfreeeに登録されている名前と一致する必要があるため、取引先のように「'」を付けて直すことはせず、先頭が数式になりうる文字のときは
 * 入力し直してもらう（数式インジェクション対策を外さず、意味も変えない）。
 */
function checkMasterText(raw: string, label: string, fix: string): { value: string | null; error: string | null } {
  const value = cleanText(raw);
  if (value === "") return { value: null, error: `${label}が入力されていません。${fix}` };
  if (value.length > FREEE_TEXT_MAX_LENGTH) return { value: null, error: `${label}が長すぎます（${FREEE_TEXT_MAX_LENGTH}文字までです）。` };
  if (FORMULA_START.test(value)) {
    return { value: null, error: `${label}の先頭に「=」「+」「-」「@」は使えません（Excelで数式として実行される危険があるため）。freeeに登録されている名前を確かめて、入力し直してください。` };
  }
  return { value, error: null };
}

const FIX_ACCOUNT = "freeeに登録されている勘定科目の名前を、そのまま入力してください。";
const FIX_TAX = "freeeの取引の登録画面などで使える税区分の名前を確かめて、そのまま入力してください。";

/** 共通の設定の不足・不備（利用者が直す項目と、直し方）。空なら共通の設定はそろっている。勘定科目・税区分は行ごとの上書きでも埋められるため、ここでは見ない */
export function validateFreeeSettings(settings: FreeeSettings): string[] {
  const problems: string[] = [];
  if (settings.direction !== "支出" && settings.direction !== "収入") {
    problems.push("収支区分を選んでください（領収書・レシートの支払いは「支出」、自分が受け取った代金の領収書は「収入」です）。");
  }
  if (settings.paymentMode === "") {
    problems.push("支払い状況を選んでください（「支払い済み」か「未決済」）。");
  } else if (settings.paymentMode === "paid") {
    const { error } = checkMasterText(settings.paymentAccount, "決済口座", "freeeに登録されている口座の名前を、そのまま入力してください。");
    if (error) problems.push(error);
  }
  return problems;
}

/**
 * 1行ぶんの勘定科目・税区分を決める。行の上書きがあればそれを、なければ共通の設定を使う。
 * 決まらない・不備があるときは、理由と直し方を errors に入れ、resolved は null。
 */
export function resolveFreeeRow(
  record: CsvRecord,
  override: FreeeRowOverride,
  settings: FreeeSettings,
): { errors: string[]; resolved: FreeeRecord | null } {
  const errors: string[] = [];
  const accountRaw = cleanText(override.account) !== "" ? override.account : settings.account;
  const taxRaw = cleanText(override.taxCategory) !== "" ? override.taxCategory : settings.taxCategory;
  const account = checkMasterText(accountRaw, "勘定科目", `${FIX_ACCOUNT}（共通の設定か、この行の入力欄に入力できます）`);
  const tax = checkMasterText(taxRaw, "税区分", `${FIX_TAX}（共通の設定か、この行の入力欄に入力できます）`);
  if (account.error) errors.push(account.error);
  if (tax.error) errors.push(tax.error);
  if (errors.length > 0 || account.value === null || tax.value === null) return { errors, resolved: null };
  return { errors, resolved: { ...record, account: account.value, taxCategory: tax.value } };
}

/** freee向けCSVの行（ヘッダーを含む）を作る。設定が不備のときは呼ばないこと（呼び出し側で validateFreeeSettings を確認する） */
export function buildFreeeCsvRows(records: FreeeRecord[], settings: FreeeSettings): string[][] {
  const paid = settings.paymentMode === "paid";
  const paymentAccount = paid ? cleanText(settings.paymentAccount) : "";
  const rows: string[][] = [[...FREEE_CSV_HEADER]];
  for (const r of records) {
    const date = formatDateSlash(r.date);
    const cells = new Array<string>(FREEE_CSV_HEADER.length).fill("");
    cells[0] = settings.direction;
    cells[2] = date;
    cells[5] = neutralizeFormula(r.vendor);
    cells[6] = r.account;
    cells[7] = r.taxCategory;
    cells[8] = String(r.total);
    if (paid) {
      cells[18] = date;
      cells[19] = paymentAccount;
      cells[20] = String(r.total);
    }
    rows.push(cells);
  }
  return rows;
}

/** freee向けCSVの文字列（UTF-8のBOM付き、改行はCRLF）。0件のときは作らず null */
export function buildFreeeCsv(records: FreeeRecord[], settings: FreeeSettings): string | null {
  if (records.length === 0) return null;
  return serializeCsv(buildFreeeCsvRows(records, settings));
}

export function buildFreeeCsvBlob(records: FreeeRecord[], settings: FreeeSettings): Blob | null {
  const text = buildFreeeCsv(records, settings);
  if (text === null) return null;
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
