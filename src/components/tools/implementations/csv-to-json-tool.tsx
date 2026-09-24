"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { CsvToJsonProcessor, type CsvToJsonOutput } from "@/lib/processors/browser/csv-json";
import { downloadBlob, stripExtension } from "@/lib/utils/format";

export function CsvToJsonTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvToJsonOutput | null>(null);

  function handleFile(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new CsvToJsonProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "変換に失敗しました");
      setStatus("error");
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.json);
  }

  const downloadName = file ? `${stripExtension(file.name)}.json` : "output.json";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept=".csv,text/csv"
        label="CSVをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          JSONに変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            変換結果（{result.objectCount}件）
            <textarea
              value={result.json}
              readOnly
              rows={12}
              className="rounded-xl border border-neutral-300 bg-neutral-50 px-4 py-3 font-mono text-xs outline-none dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              コピー
            </button>
            <RewardedDownloadGate
              label=".jsonをダウンロード"
              onDownload={() => downloadBlob(result.blob, downloadName)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
