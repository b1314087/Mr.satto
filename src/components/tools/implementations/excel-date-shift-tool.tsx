"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ExcelDateShiftProcessor, type DateShiftMode } from "@/lib/processors/browser/excel-date-shift";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MODE_OPTIONS: { value: DateShiftMode; label: string; valueLabel: string; defaultValue: number }[] = [
  { value: "set-year", label: "年を変更", valueLabel: "新しい年（例: 2027）", defaultValue: new Date().getFullYear() },
  { value: "set-month", label: "月を変更", valueLabel: "新しい月（1〜12）", defaultValue: 1 },
  { value: "set-day", label: "日を変更", valueLabel: "新しい日（1〜31）", defaultValue: 1 },
  { value: "add-days", label: "日数を加算", valueLabel: "加算する日数", defaultValue: 30 },
  { value: "subtract-days", label: "日数を減算", valueLabel: "減算する日数", defaultValue: 30 },
];

export function ExcelDateShiftTool() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<DateShiftMode>("add-days");
  const [value, setValue] = useState(30);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; changedCellCount: number } | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function handleModeChange(next: DateShiftMode) {
    setMode(next);
    setValue(MODE_OPTIONS.find((m) => m.value === next)?.defaultValue ?? 0);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelDateShiftProcessor().process({ file, mode, value });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-date-shifted.xlsx`);
  }

  const currentOption = MODE_OPTIONS.find((m) => m.value === mode)!;

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
                onClick={() => handleModeChange(opt.value)}
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

          <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400 sm:w-64">
            {currentOption.valueLabel}
            <input
              type="number"
              min={mode === "add-days" || mode === "subtract-days" ? 0 : undefined}
              value={value}
              onChange={(e) => setValue(Number(e.target.value))}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <p className="text-xs text-neutral-400">
            シート内の日付として認識できるセルだけを変更します（日付以外のセルは変更されません）
          </p>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          一括変更する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変更が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{result.changedCellCount}件の日付を変更しました</p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </div>
      )}
    </div>
  );
}
