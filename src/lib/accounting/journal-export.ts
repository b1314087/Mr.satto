import { serializeCsv } from "@/lib/utils/csv";
import { neutralizeFormula, type CsvRecord } from "./csv-generic";
import { formatDateSlash } from "./receipt-extract";
import { parseTaxAmountInput, taxRateLabel, type ReceiptDetailValues } from "./receipt-details";
import { sanitizeVendor } from "./receipt-validate";
import type { SheetData } from "write-excel-file/universal";

/**
 * 明細・仕訳用の出力（工程4）。確認済みの行を、税率・税額・登録番号・品目・摘要・税区分・借方/貸方勘定科目まで含めた
 * CSV と Excel にする。純粋な関数だけ（CSVの文字列・Excelのセルを作る。ダウンロードは画面側）。
 *
 * - 特定の会計ソフト専用の形式ではない（多くの会計ソフトの「仕訳の取り込み」で、列を対応付けて使える一覧の形）。
 *   会計ソフトへの取り込みを保証するものではない。
 * - 不明な項目は空欄で出す（推測で埋めない）。税区分・勘定科目は、利用者が入力した値をそのまま出す。
 * - 「読み取り元」の列に、どのファイル（PDFはページ）から読み取った行かを出す（ファイルと結果の対応を残す）。
 * - CSVは、文字の先頭が「=」「+」「-」「@」などのとき、Excelで数式として実行されないよう先頭に「'」を付ける。
 *   Excelは文字のセルとして書くため、数式にはならない。
 */

export const JOURNAL_HEADER = [
  "日付",
  "取引先",
  "合計金額（税込）",
  "税率",
  "消費税額",
  "登録番号",
  "品目",
  "摘要",
  "税区分",
  "借方勘定科目",
  "貸方勘定科目",
  "読み取り元",
] as const;

export interface JournalRecord extends CsvRecord {
  details: ReceiptDetailValues;
  /** 読み取り元（ファイル名。PDFはページ番号つき） */
  source: string;
}

function clean(text: string): string {
  return sanitizeVendor(text);
}

function taxAmountOf(details: ReceiptDetailValues): number | null {
  const n = parseTaxAmountInput(details.taxAmount);
  return n === null || Number.isNaN(n) ? null : n;
}

function regOf(details: ReceiptDetailValues): string {
  return details.registrationNumber.normalize("NFKC").replace(/[\s\-]/g, "");
}

/** CSVの行（見出しを含む） */
export function buildJournalCsvRows(records: readonly JournalRecord[]): string[][] {
  return [
    [...JOURNAL_HEADER],
    ...records.map((r) => {
      const tax = taxAmountOf(r.details);
      return [
        formatDateSlash(r.date),
        neutralizeFormula(r.vendor),
        String(r.total),
        r.details.taxRate === "" ? "" : taxRateLabel(r.details.taxRate),
        tax === null ? "" : String(tax),
        regOf(r.details),
        neutralizeFormula(clean(r.details.items)),
        neutralizeFormula(clean(r.details.memo)),
        neutralizeFormula(clean(r.details.taxCategory)),
        neutralizeFormula(clean(r.details.debitAccount)),
        neutralizeFormula(clean(r.details.creditAccount)),
        neutralizeFormula(clean(r.source)),
      ];
    }),
  ];
}

export function buildJournalCsvBlob(records: readonly JournalRecord[]): Blob | null {
  if (records.length === 0) return null;
  return new Blob([serializeCsv(buildJournalCsvRows(records))], { type: "text/csv;charset=utf-8" });
}

type XlsxCell =
  | null
  | { value: string; type: StringConstructor; fontWeight?: "bold" }
  | { value: number; type: NumberConstructor; format?: string }
  | { value: Date; type: DateConstructor; format: string };

/** Excelのセル（日付は日付、金額は数値（桁区切り）、文字は文字のセル。数式としては書かない） */
export function buildJournalXlsxRows(records: readonly JournalRecord[]): XlsxCell[][] {
  const text = (v: string): XlsxCell => (v === "" ? null : { value: v, type: String });
  return [
    JOURNAL_HEADER.map((h) => ({ value: h, type: String, fontWeight: "bold" as const })),
    ...records.map((r) => {
      const [y, m, d] = r.date.split("-").map(Number);
      const tax = taxAmountOf(r.details);
      return [
        // write-excel-file はDateをUTC基準でシリアル値にするため、UTCの0時で作る（1日ずれないように）
        { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: "yyyy/mm/dd" },
        text(r.vendor),
        { value: r.total, type: Number, format: "#,##0" },
        text(r.details.taxRate === "" ? "" : taxRateLabel(r.details.taxRate)),
        tax === null ? null : { value: tax, type: Number, format: "#,##0" },
        text(regOf(r.details)),
        text(clean(r.details.items)),
        text(clean(r.details.memo)),
        text(clean(r.details.taxCategory)),
        text(clean(r.details.debitAccount)),
        text(clean(r.details.creditAccount)),
        text(clean(r.source)),
      ] as XlsxCell[];
    }),
  ];
}

export async function buildJournalXlsxBlob(records: readonly JournalRecord[]): Promise<Blob | null> {
  if (records.length === 0) return null;
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  const rows = buildJournalXlsxRows(records);
  return writeXlsxFile(rows as unknown as SheetData, {
    columns: [{ width: 12 }, { width: 24 }, { width: 14 }, { width: 14 }, { width: 10 }, { width: 17 }, { width: 28 }, { width: 24 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 28 }],
    stickyRowsCount: 1,
  }).toBlob();
}
