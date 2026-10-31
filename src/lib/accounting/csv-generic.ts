import { serializeCsv } from "@/lib/utils/csv";
import { formatDateSlash } from "./receipt-extract";

/**
 * 確認済みの書類から、汎用CSV（日付・取引先・合計金額）を作る（工程8）。
 *
 * - 特定の会計ソフト専用の形式ではない。会計ソフトへの直接取り込みを保証するものではない。
 * - 文字コードはUTF-8（先頭にBOM付き）。Excelで開いたときに日本語が文字化けしにくくするためで、
 *   特定の会計ソフトへの取り込みを保証する文字コードという意味ではない。
 * - 取引先の先頭が「=」「+」「-」「@」、タブ、改行（復帰）のとき、Excelで数式として実行されないよう先頭に「'」を付ける
 *   （既存の座席表CSVと同じ考え方。引用符・カンマ・改行のエスケープは serializeCsv が行い、これとは別の処理）。
 */

export const GENERIC_CSV_HEADER = ["日付", "取引先", "合計金額"] as const;

/** 出力する1行（検証を通った値） */
export interface CsvRecord {
  /** YYYY-MM-DD */
  date: string;
  vendor: string;
  /** 1円以上の整数 */
  total: number;
}

/**
 * Excelで数式として実行されないようにする。
 * 先頭が「=」「+」「-」「@」、またはタブ・復帰のときだけ、先頭に「'」を付ける。それ以外は変えない。
 */
export function neutralizeFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** 汎用CSVの行（見出しを含む）を作る */
export function buildGenericCsvRows(records: CsvRecord[]): string[][] {
  return [
    [...GENERIC_CSV_HEADER],
    ...records.map((r) => [formatDateSlash(r.date), neutralizeFormula(r.vendor), String(r.total)]),
  ];
}

/** 汎用CSVの文字列（UTF-8のBOM付き、改行はCRLF）を作る。0件のときは作らず null */
export function buildGenericCsv(records: CsvRecord[]): string | null {
  if (records.length === 0) return null;
  return serializeCsv(buildGenericCsvRows(records));
}

/** 汎用CSVのBlobを作る。0件のときは null */
export function buildGenericCsvBlob(records: CsvRecord[]): Blob | null {
  const text = buildGenericCsv(records);
  if (text === null) return null;
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
