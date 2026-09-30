"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { ExcelMergeCenterProcessor } from "@/lib/processors/browser/excel-merge-center";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function ExcelMergeCenterTool() {
  const [file, setFile] = useState<File | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);

  const [startRow, setStartRow] = useState(1);
  const [endRow, setEndRow] = useState(1);
  const [startCol, setStartCol] = useState(1);
  const [endCol, setEndCol] = useState(4);
  const [merge, setMerge] = useState(true);
  const [horizontalCenter, setHorizontalCenter] = useState(true);
  const [verticalCenter, setVerticalCenter] = useState(true);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; processedRowCount: number } | null>(null);

  async function handleSelect(files: File[]) {
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setSheetNames([]);
    try {
      const sheets = await readXlsxSheets(selected);
      setSheetNames(sheets.map((s) => s.name));
      setSheetIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルの読み込みに失敗しました");
    }
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelMergeCenterProcessor().process({
        file,
        sheetIndex,
        startRow,
        endRow,
        startCol,
        endCol,
        merge,
        horizontalCenter,
        verticalCenter,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-merged.xlsx`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={50}
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {sheetNames.length > 1 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">対象シート</p>
          <div className="flex flex-wrap gap-2">
            {sheetNames.map((name, i) => (
              <button
                key={`${name}-${i}`}
                type="button"
                onClick={() => setSheetIndex(i)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                  i === sheetIndex
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {file && sheetNames.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            対象範囲（行番号・列番号は1始まり。複数行を指定すると各行に同じ処理を適用します）
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              開始行
              <input
                type="number"
                min={1}
                value={startRow}
                onChange={(e) => setStartRow(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              終了行
              <input
                type="number"
                min={1}
                value={endRow}
                onChange={(e) => setEndRow(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              開始列
              <input
                type="number"
                min={1}
                value={startCol}
                onChange={(e) => setStartCol(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              終了列
              <input
                type="number"
                min={1}
                value={endCol}
                onChange={(e) => setEndCol(Number(e.target.value))}
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-4 text-sm text-neutral-600 dark:text-neutral-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />
              セルを結合する
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={horizontalCenter}
                onChange={(e) => setHorizontalCenter(e.target.checked)}
              />
              水平方向中央揃え
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={verticalCenter}
                onChange={(e) => setVerticalCenter(e.target.checked)}
              />
              垂直方向中央揃え
            </label>
          </div>
          {!merge && (
            <p className="text-xs text-neutral-400">
              「セルを結合する」をオフにすると、結合せずに中央揃えだけを適用します
            </p>
          )}
        </div>
      )}

      {file && sheetNames.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          実行する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{result.processedRowCount}行を処理しました</p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
