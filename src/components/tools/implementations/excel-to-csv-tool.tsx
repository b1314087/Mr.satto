"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ExcelToCsvProcessor, sheetRowsToCsvBlob, type ExcelSheet } from "@/lib/processors/browser/csv-excel";
import { downloadBlob, sanitizeFileName, stripExtension } from "@/lib/utils/format";

export function ExcelToCsvTool() {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<ExcelSheet[] | null>(null);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setSheets(null);
    setSelectedSheetIndex(0);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setSheets(null);
    try {
      const output = await new ExcelToCsvProcessor().process({ file });
      setSheets(output.sheets);
      setSelectedSheetIndex(0);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const selectedSheet = sheets?.[selectedSheetIndex] ?? null;

  function handleDownload() {
    if (!file || !selectedSheet) return;
    const blob = sheetRowsToCsvBlob(selectedSheet.rows);
    const base = stripExtension(file.name);
    const name =
      sheets && sheets.length > 1
        ? `${base}-${sanitizeFileName(selectedSheet.name)}.csv`
        : `${base}.csv`;
    downloadBlob(blob, name);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        maxSizeMB={50}
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && !sheets && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          CSVに変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {sheets && sheets.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {sheets.length > 1 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                ダウンロードするシートを選択
              </p>
              <div className="flex flex-wrap gap-2">
                {sheets.map((sheet, i) => (
                  <button
                    key={`${sheet.name}-${i}`}
                    type="button"
                    onClick={() => setSelectedSheetIndex(i)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                      i === selectedSheetIndex
                        ? "bg-blue-600 text-white"
                        : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                    }`}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedSheet && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                「{selectedSheet.name}」・{selectedSheet.rows.length}行
              </p>
              <CsvPreviewTable rows={selectedSheet.rows} />
            </div>
          )}

          <RewardedDownloadGate onDownload={handleDownload} label="CSVでダウンロード" />
        </div>
      )}
    </div>
  );
}
