"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ExcelBlankRemoveProcessor, type BlankRemoveMode } from "@/lib/processors/browser/excel-blank-remove";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MODE_OPTIONS: { value: BlankRemoveMode; label: string }[] = [
  { value: "rows", label: "空白行のみ" },
  { value: "columns", label: "空白列のみ" },
  { value: "both", label: "両方" },
];

export function ExcelBlankRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<BlankRemoveMode>("both");
  const [useRange, setUseRange] = useState(false);
  const [rangeStartRow, setRangeStartRow] = useState(1);
  const [rangeEndRow, setRangeEndRow] = useState(100);
  const [rangeStartCol, setRangeStartCol] = useState(1);
  const [rangeEndCol, setRangeEndCol] = useState(20);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; removedRows: number; removedColumns: number } | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelBlankRemoveProcessor().process({
        file,
        mode,
        ...(useRange
          ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol }
          : {}),
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
    downloadBlob(result.blob, `${stripExtension(file.name)}-cleaned.xlsx`);
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

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap gap-2">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} />
            範囲を指定する（未指定の場合はシート全体が対象）
          </label>

          {useRange && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                開始行
                <input
                  type="number"
                  min={1}
                  value={rangeStartRow}
                  onChange={(e) => setRangeStartRow(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                終了行
                <input
                  type="number"
                  min={1}
                  value={rangeEndRow}
                  onChange={(e) => setRangeEndRow(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                開始列
                <input
                  type="number"
                  min={1}
                  value={rangeStartCol}
                  onChange={(e) => setRangeStartCol(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                終了列
                <input
                  type="number"
                  min={1}
                  value={rangeEndCol}
                  onChange={(e) => setRangeEndCol(Number(e.target.value))}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          空白を削除する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="削除が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除した行: {result.removedRows} ・ 削除した列: {result.removedColumns}
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
