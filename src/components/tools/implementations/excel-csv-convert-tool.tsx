"use client";

import { useState } from "react";
import { ExcelToCsvTool } from "./excel-to-csv-tool";
import { CsvToExcelTool } from "./csv-to-excel-tool";
import { EXCEL_CSV_MODES, getExcelCsvMode, type ExcelCsvMode } from "@/lib/tools/excel-csv-modes";

/**
 * Excel・CSV変換の総合画面。「Excel → CSV」と「CSV → Excel」を、操作の切り替えで使い分ける。
 *
 * 各操作の中身は、これまでの個別ツールの画面をそのまま使う（処理も表示も変えない）。
 * Excel（.xlsx）とCSVでは扱うファイルもデータ構造も違うため、処理を1つにまとめたり、
 * 選んだファイルを操作の間で引き継いだりはしない。この画面が足すのは「操作の切り替え」だけ。
 * - 操作を切り替えると、前の操作のファイル・結果・エラーはリセットされる（古い結果をダウンロードさせない）。
 * - 個別URL（/tools/excel-to-csv など）で開いたときは、その操作を選んだ状態で表示する（initialMode）。
 * 処理はすべてブラウザ内で行い、ファイルは送信しない。
 */

export interface ExcelCsvConvertToolProps {
  /** 最初に選んでおく操作（個別URLのツールごとに違う） */
  initialMode?: ExcelCsvMode;
}

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function ExcelCsvConvertTool({ initialMode = "excel-to-csv" }: ExcelCsvConvertToolProps) {
  const [mode, setMode] = useState<ExcelCsvMode>(initialMode);
  const info = getExcelCsvMode(mode);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="変換の向き" data-testid="excel-csv-modes" className="flex flex-wrap gap-2">
          {EXCEL_CSV_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`excel-csv-mode-${m.mode}`}
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="excel-csv-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
      </div>

      {/* key: 向きを切り替えたら、前の操作の状態（ファイル・結果・エラー）を必ず捨てて作り直す */}
      <div key={mode}>
        {mode === "excel-to-csv" && <ExcelToCsvTool />}
        {mode === "csv-to-excel" && <CsvToExcelTool />}
      </div>
    </div>
  );
}
