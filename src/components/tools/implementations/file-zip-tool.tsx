"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { FileZipProcessor } from "@/lib/processors/browser/file-ops";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/**
 * ファイルZIP化。
 * ZIP生成そのものはPhase 2-Aのcreate Zip()をそのまま使う
 * FileZipProcessor（src/lib/processors/browser/file-ops.ts）に委譲し、
 * 新しいZIPロジックはここでは実装しない。
 */
export function FileZipTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setZipBlob(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRun() {
    if (files.length === 0) return;
    setStatus("processing");
    setError(null);
    setZipBlob(null);
    try {
      const output = await new FileZipProcessor().process({ files });
      setZipBlob(output.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        multiple
        maxSizeMB={200}
        label="ファイルをドラッグ&ドロップ（複数可）"
        hint="またはタップして選択"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件をZIP化する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="ZIPの作成が完了しました" />
      {error && <ErrorMessage message={error} />}

      {zipBlob && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {files.length}件をまとめました ・ {formatBytes(zipBlob.size)}
          </p>
          <RewardedDownloadGate
            onDownload={() => downloadBlob(zipBlob, "files.zip")}
            label="ZIPでダウンロード"
          />
        </div>
      )}
    </div>
  );
}
