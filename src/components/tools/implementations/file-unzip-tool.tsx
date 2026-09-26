"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  FileUnzipProcessor,
  type UnzippedFileEntry,
} from "@/lib/processors/browser/file-unzip";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * ZIP解凍（Phase 8）。
 * 中身の一覧を確認しつつ、1件ずつの個別ダウンロード、またはまとめて再ZIP化
 * してのダウンロードのどちらも行えるようにする。
 * 個別ダウンロードは既存のPDF分割等と違いファイルごとに広告を挟まず、
 * 「まとめてダウンロード」側だけをRewardedDownloadGateの対象にする
 * （多数のファイルを含むZIPで1件ごとに広告が出るのは体験として適切でないため）。
 */
export function FileUnzipTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<UnzippedFileEntry[] | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setEntries(null);
    setSkippedCount(0);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setEntries(null);
    try {
      const output = await new FileUnzipProcessor().process({ file });
      setEntries(output.entries);
      setSkippedCount(output.skippedEntryCount);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  async function handleDownloadAll() {
    if (!entries || !file) return;
    const zip = await createZip(entries.map((e) => ({ name: e.name, blob: e.blob })));
    downloadBlob(zip, `${stripExtension(file.name)}-extracted.zip`);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/zip,.zip,application/x-zip-compressed"
        maxSizeMB={200}
        label="ZIPファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
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
          解凍する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="解凍中..." successLabel="解凍が完了しました" />
      {error && <ErrorMessage message={error} />}

      {entries && entries.length > 0 && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {skippedCount > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              サイズ・件数の上限、または対応していない圧縮方式のため{skippedCount}件のファイルをスキップしました。
            </p>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{entries.length}件のファイルを展開しました</p>
          <ul className="w-full divide-y divide-neutral-200 text-xs text-neutral-600 dark:divide-neutral-800 dark:text-neutral-300">
            {entries.slice(0, 200).map((entry, i) => (
              <li key={`${entry.name}-${i}`} className="flex items-center justify-between gap-2 py-1.5">
                <span className="truncate">{entry.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-neutral-400">{formatBytes(entry.sizeBytes)}</span>
                  <button
                    type="button"
                    onClick={() => downloadBlob(entry.blob, entry.name)}
                    className="rounded-md border border-neutral-300 px-2 py-0.5 text-neutral-600 hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    保存
                  </button>
                </div>
              </li>
            ))}
            {entries.length > 200 && (
              <li className="py-1.5 text-neutral-400">他{entries.length - 200}件…（「まとめてダウンロード」ですべて取得できます）</li>
            )}
          </ul>
          <RewardedDownloadGate onDownload={handleDownloadAll} label="まとめてZIPでダウンロード" />
        </div>
      )}
    </div>
  );
}
