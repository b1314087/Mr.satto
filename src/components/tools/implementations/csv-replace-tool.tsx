"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvReplaceProcessor } from "@/lib/processors/browser/csv-ops";
import { parseCsv, isBlankRow } from "@/lib/utils/csv";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

export function CsvReplaceTool() {
  const [file, setFile] = useState<File | null>(null);
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    blob: Blob;
    replacedCount: number;
    previewRows: string[][];
  } | null>(null);

  async function handleSelect(files: File[]) {
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setPreviewRows([]);
    try {
      const text = await selected.text();
      setPreviewRows(parseCsv(text).filter((row) => !isBlankRow(row)));
    } catch {
      setError("CSVの内容を読み込めませんでした");
    }
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new CsvReplaceProcessor().process({ file, search, replace });
      const text = await output.blob.text();
      setResult({ ...output, previewRows: parseCsv(text) });
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
        maxSizeMB={50}
        label="CSVファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              検索する文字列
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="置換前の文字列"
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              置換後の文字列
              <input
                type="text"
                value={replace}
                onChange={(e) => setReplace(e.target.value)}
                placeholder="置換後の文字列（空欄可）"
                className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>
        </div>
      )}

      {previewRows.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">内容の確認</p>
          <CsvPreviewTable rows={previewRows} />
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || search === ""}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          置換を実行する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="置換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.replacedCount}件を置換しました ・ {formatBytes(result.blob.size)}
          </p>
          <CsvPreviewTable rows={result.previewRows} />
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result.blob, "replaced.csv")}
            label="CSVでダウンロード"
          />
        </div>
      )}
    </div>
  );
}
