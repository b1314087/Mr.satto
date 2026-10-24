/**
 * 「Excel・CSV変換」総合ツールの操作（モード）の定義。
 *
 * 総合ツール（excel-csv-convert）と、統合済みの旧ツール（個別URLは維持）の対応表。
 * 画面（クライアント）から読むため、重いツール一覧データ（data.ts）には依存させず、
 * ここに軽い定数として持つ。data.ts の `mergedInto: "excel-csv-convert"` との一致は
 * tests/tools/excel-csv-convert.spec.ts で検証している。
 */

export const EXCEL_CSV_TOOL_ID = "excel-csv-convert";

export type ExcelCsvMode = "excel-to-csv" | "csv-to-excel";

export interface ExcelCsvModeInfo {
  mode: ExcelCsvMode;
  /** 操作の切り替えボタンの表示名 */
  label: string;
  /** この操作の個別ページ（統合済みの旧ツール）のツールID。URLは /tools/<toolId> のまま維持する */
  toolId: string;
  /** 操作の説明（1文） */
  description: string;
}

export const EXCEL_CSV_MODES: ExcelCsvModeInfo[] = [
  {
    mode: "excel-to-csv",
    label: "Excel → CSV",
    toolId: "excel-to-csv",
    description: "Excelファイル（.xlsx）のシートを、CSVファイルに変換します。複数のシートがあるときは、書き出すシートを選べます。",
  },
  {
    mode: "csv-to-excel",
    label: "CSV → Excel",
    toolId: "csv-to-excel",
    description: "CSVファイルを、Excelファイル（.xlsx）に変換します。",
  },
];

export function getExcelCsvMode(mode: ExcelCsvMode): ExcelCsvModeInfo {
  return EXCEL_CSV_MODES.find((m) => m.mode === mode) ?? EXCEL_CSV_MODES[0];
}
