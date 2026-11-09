"use client";

import { useEffect, useState } from "react";
import { ExcelMergeTool } from "./excel-merge-tool";
import { CsvMergeTool } from "./csv-merge-tool";

/**
 * Excel・CSV結合（工程2で、CSV結合をExcelファイル結合に統合した画面）。
 * 「Excelファイルを結合」と「CSVファイルを結合」を、画面上の切り替えで使い分ける。
 *
 * 各操作の中身は、これまでのツールの画面をそのまま使う（処理・入力・出力は変えない）。
 * - Excelファイルを結合：旧「Excelファイル結合」。Excel（.xlsx）を、見出しの名前で列を揃えて1つの表にする
 *   （これまでどおりCSVも一緒に選べる。出力はExcelまたはCSV）。
 * - CSVファイルを結合：旧「CSV結合」。CSVを選んだ順に縦につなぐ。文字コードはMr.Sattoの共通処理
 *   （UTF-8・BOM付き・Shift_JIS・UTF-16の判別、書き出しの文字コードの選択）をそのまま使う。
 * ExcelとCSVでは結合の仕方が違うため、処理を1つにまとめたり、選んだファイルを操作の間で引き継いだりはしない。
 * - 操作を切り替えると、前の操作のファイル・結果・エラーはリセットされる（古い結果をダウンロードさせない）。
 * - 旧「CSV結合」のアドレス（/tools/csv-merge）からの転送（?mode=csv）では、「CSVファイルを結合」を選んだ状態で開く。
 * 処理はすべてブラウザ内で行い、ファイルは送信しない。
 */

export type ExcelCsvMergeMode = "excel" | "csv";

export const EXCEL_CSV_MERGE_MODES: { mode: ExcelCsvMergeMode; label: string; description: string }[] = [
  {
    mode: "excel",
    label: "Excelファイルを結合",
    description:
      "Excel（.xlsx）を、見出しの名前で列を揃えて1つの表にまとめます（列の順番や数が違っても結合できます。CSVも一緒に選べます）。出力はExcelまたはCSVです。",
  },
  {
    mode: "csv",
    label: "CSVファイルを結合",
    description:
      "CSVファイルを、選んだ順に縦につないで1つのCSVにします。2つ目以降の見出し行は重ねません。文字コード（UTF-8・Shift_JISなど）は自動で判別します。",
  },
];

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function ExcelCsvMergeTool() {
  const [mode, setMode] = useState<ExcelCsvMergeMode>("excel");
  const info = EXCEL_CSV_MERGE_MODES.find((m) => m.mode === mode) ?? EXCEL_CSV_MERGE_MODES[0];

  // 旧「CSV結合」のアドレスから転送されてきたとき（?mode=csv）は、「CSVファイルを結合」を最初から選んでおく
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "csv") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode("csv");
    }
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="結合するファイルの種類" data-testid="excel-csv-merge-modes" className="flex flex-wrap gap-2">
          {EXCEL_CSV_MERGE_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`excel-csv-merge-mode-${m.mode}`}
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="excel-csv-merge-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
      </div>

      {/* key: 操作を切り替えたら、前の操作の状態（ファイル・結果・エラー）を必ず捨てて作り直す */}
      <div key={mode}>
        {mode === "excel" && <ExcelMergeTool />}
        {mode === "csv" && <CsvMergeTool />}
      </div>
    </div>
  );
}
