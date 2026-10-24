/**
 * 「CSV・JSON変換」総合ツールの操作（モード）の定義。
 *
 * 総合ツール（csv-json-convert）と、統合済みの旧ツール（個別URLは維持）の対応表。
 * 画面（クライアント）から読むため、重いツール一覧データ（data.ts）には依存させず、
 * ここに軽い定数として持つ。data.ts の `mergedInto: "csv-json-convert"` との一致は
 * tests/tools/csv-json-convert.spec.ts で検証している。
 */

export const CSV_JSON_TOOL_ID = "csv-json-convert";

export type CsvJsonMode = "csv-to-json" | "json-to-csv";

export interface CsvJsonModeInfo {
  mode: CsvJsonMode;
  /** 操作の切り替えボタンの表示名 */
  label: string;
  /** この操作の個別ページ（統合済みの旧ツール）のツールID。URLは /tools/<toolId> のまま維持する */
  toolId: string;
  /** 操作の説明（1文） */
  description: string;
}

export const CSV_JSON_MODES: CsvJsonModeInfo[] = [
  {
    mode: "csv-to-json",
    label: "CSV → JSON",
    toolId: "csv-to-json",
    description: "CSVファイルを、1行目を見出しとしたJSON（オブジェクトの配列）に変換します。",
  },
  {
    mode: "json-to-csv",
    label: "JSON → CSV",
    toolId: "json-to-csv",
    description: "JSON（オブジェクトの配列）を貼り付けて、見出し付きのCSVに変換します。",
  },
];

export function getCsvJsonMode(mode: CsvJsonMode): CsvJsonModeInfo {
  return CSV_JSON_MODES.find((m) => m.mode === mode) ?? CSV_JSON_MODES[0];
}
