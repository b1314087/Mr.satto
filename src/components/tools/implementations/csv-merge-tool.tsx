"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvMergeProcessor } from "@/lib/processors/browser/csv-ops";
import { parseCsv } from "@/lib/utils/csv";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

export function CsvMergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; rowCount: number; previewRows: string[][] } | null>(
    null
  );

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRun() {
    if (files.length < 2) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new CsvMergeProcessor().process({ files });
      const text = await output.blob.text();
      setResult({ blob: output.blob, rowCount: output.rowCount, previewRows: parseCsv(text) });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept=".csv,text/csv"
        multiple
        maxSizeMB={50}
        label="CSVをドラッグ&ドロップ（複数可）"
        hint="またはタップして選択。結合する順序で選択してください"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length > 0 && files.length < 2 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          結合するには、もう1つ以上CSVを追加してください。
        </p>
      )}

      {files.length >= 2 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件のCSVを結合する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="結合が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行に結合しました ・ {formatBytes(result.blob.size)}
          </p>
          <CsvPreviewTable rows={result.previewRows} />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, "merged.csv")}
            label="CSVでダウンロード"
          />
        </div>
      )}
    </div>
  );
}
