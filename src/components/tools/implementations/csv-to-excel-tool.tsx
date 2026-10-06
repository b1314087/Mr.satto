"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import {
  PreviewGrid,
  PreviewNotice,
  PreviewShell,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRows, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvToExcelProcessor } from "@/lib/processors/browser/csv-excel";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

export function CsvToExcelTool() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; rowCount: number } | null>(null);

  // プレビュー: 変換処理(CsvToExcelProcessor)と同じ読み方(parseCsv + 空行除外)でシートの中身を表示する
  const { data: rows, error: previewError, loading } = useAsyncFileData(file, loadCsvRows);
  const columnCount = rows ? rows.reduce((max, r) => Math.max(max, r.length), 0) : 0;

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
      const output = await new CsvToExcelProcessor().process({ file });
      setResult({ blob: output.blob, rowCount: output.rowCount });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}.xlsx` : "converted.xlsx";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept=".csv,text/csv"
        maxSizeMB={50}
        label="CSVファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (rows || previewError || loading) && (
        <PreviewShell
          title="Excelに変換される内容(プレビュー)"
          loading={loading}
          summary={rows && <span>{rows.length}行 × {columnCount}列のシートが作られます（空行は取り除かれます）</span>}
        >
          {previewError && <PreviewNotice message={previewError} />}
          {rows && (
            <PreviewGrid rows={toGridRows(rows.slice(0, 10))} totalRows={rows.length} maxRows={10} maxCols={8} headerRow={false} />
          )}
        </PreviewShell>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          Excelに変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="Excelへの変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行 ・ {formatBytes(result.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
