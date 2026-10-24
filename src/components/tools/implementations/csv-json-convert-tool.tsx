"use client";

import { useState } from "react";
import { CsvToJsonTool } from "./csv-to-json-tool";
import { JsonToCsvTool } from "./json-to-csv-tool";
import { CSV_JSON_MODES, getCsvJsonMode, type CsvJsonMode } from "@/lib/tools/csv-json-modes";

/**
 * CSV・JSON変換の総合画面。「CSV → JSON」と「JSON → CSV」を、操作の切り替えで使い分ける。
 *
 * 各操作の中身は、これまでの個別ツールの画面をそのまま使う（処理も表示も変えない）。
 * CSVファイルとJSONテキストでは入力の形もデータ構造も違うため、処理を1つにまとめたり、
 * 入力を操作の間で引き継いだりはしない。この画面が足すのは「操作の切り替え」だけ。
 * - 操作を切り替えると、前の操作の入力・結果・エラーはリセットされる（古い結果をダウンロードさせない）。
 * - 個別URL（/tools/csv-to-json など）で開いたときは、その操作を選んだ状態で表示する（initialMode）。
 * 処理はすべてブラウザ内で行い、CSV・JSONの内容は送信しない。
 */

export interface CsvJsonConvertToolProps {
  /** 最初に選んでおく操作（個別URLのツールごとに違う） */
  initialMode?: CsvJsonMode;
}

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function CsvJsonConvertTool({ initialMode = "csv-to-json" }: CsvJsonConvertToolProps) {
  const [mode, setMode] = useState<CsvJsonMode>(initialMode);
  const info = getCsvJsonMode(mode);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div role="group" aria-label="変換の向き" data-testid="csv-json-modes" className="flex flex-wrap gap-2">
          {CSV_JSON_MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              aria-pressed={mode === m.mode}
              data-testid={`csv-json-mode-${m.mode}`}
              onClick={() => setMode(m.mode)}
              className={activeClass(mode === m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p data-testid="csv-json-mode-description" className="text-xs text-neutral-500 dark:text-neutral-400">
          {info.description}
        </p>
      </div>

      {/* key: 向きを切り替えたら、前の操作の状態（入力・結果・エラー）を必ず捨てて作り直す */}
      <div key={mode}>
        {mode === "csv-to-json" && <CsvToJsonTool />}
        {mode === "json-to-csv" && <JsonToCsvTool />}
      </div>
    </div>
  );
}
