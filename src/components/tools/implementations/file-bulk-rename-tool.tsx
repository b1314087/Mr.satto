"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { FileRenameProcessor, buildSequentialBaseNames } from "@/lib/processors/browser/file-ops";
import type { NamedFileOutput } from "@/lib/processors/types";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, getExtension, stripExtension } from "@/lib/utils/format";

/**
 * ファイル一括リネーム。
 *
 * 各ファイルの新しい名前を自由入力できるほか、「共通の名前＋連番」を
 * 一括で適用するクイック生成も提供する（開発指示書■1の最低要件）。
 * 実際のリネーム・重複防止・拡張子維持は FileRenameProcessor
 * （連番リネームツールと共通）へ委譲する。
 */
export function FileBulkRenameTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [newBaseNames, setNewBaseNames] = useState<string[]>([]);
  const [commonBase, setCommonBase] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<NamedFileOutput[] | null>(null);
  const [downloadBlobData, setDownloadBlobData] = useState<{ blob: Blob; name: string } | null>(
    null
  );

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setNewBaseNames((prev) => [...prev, ...newFiles.map((f) => stripExtension(f.name))]);
    setResults(null);
    setDownloadBlobData(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setNewBaseNames((prev) => prev.filter((_, i) => i !== index));
  }

  function updateName(index: number, value: string) {
    setNewBaseNames((prev) => prev.map((n, i) => (i === index ? value : n)));
  }

  function applyCommonSequence() {
    if (!commonBase.trim() || files.length === 0) {
      setError("連番生成に使う共通の名前を入力してください");
      return;
    }
    setError(null);
    const generated = buildSequentialBaseNames({
      count: files.length,
      prefix: commonBase,
      startNumber: 1,
      digits: 3,
    });
    setNewBaseNames(generated);
  }

  async function handleRun() {
    if (files.length === 0) return;
    setStatus("processing");
    setError(null);
    setResults(null);
    setDownloadBlobData(null);
    try {
      const output = await new FileRenameProcessor().process({ files, newBaseNames });
      setResults(output);
      if (output.length === 1) {
        setDownloadBlobData({ blob: output[0].blob, name: output[0].suggestedName });
      } else {
        const zipBlob = await createZip(output.map((o) => ({ name: o.suggestedName, blob: o.blob })));
        setDownloadBlobData({ blob: zipBlob, name: "renamed-files.zip" });
      }
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
        maxSizeMB={100}
        label="ファイルをドラッグ&ドロップ（複数可）"
        hint="またはタップして選択"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            共通の名前＋連番で一括生成（任意）
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            例: 「写真」と入力 → 写真_001, 写真_002 ... のように自動生成します
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={commonBase}
              onChange={(e) => setCommonBase(e.target.value)}
              placeholder="例: 写真"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="button"
              onClick={applyCommonSequence}
              className="shrink-0 rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              全ファイルへ適用
            </button>
          </div>
        </div>
      )}

      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((file, index) => {
            const ext = getExtension(file.name);
            return (
              <li
                key={`${file.name}-${index}`}
                className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                  現在の名前: {file.name}
                </p>
                <div className="flex min-w-0 items-center gap-1">
                  <input
                    type="text"
                    value={newBaseNames[index] ?? ""}
                    onChange={(e) => updateName(index, e.target.value)}
                    aria-label={`${file.name} の新しい名前`}
                    className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  {ext && (
                    <span className="shrink-0 text-sm text-neutral-500 dark:text-neutral-400">
                      .{ext}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeFile(index)}
                    aria-label={`${file.name} を削除`}
                    className="shrink-0 rounded-full bg-neutral-100 p-1.5 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件をリネームする
        </button>
      )}

      <ProcessingStatus state={status} successLabel="リネームが完了しました" />
      {error && <ErrorMessage message={error} />}

      {results && downloadBlobData && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {results.length}件をリネームしました ・ {formatBytes(downloadBlobData.blob.size)}
          </p>
          <RewardedDownloadGate
            onDownload={() => downloadBlob(downloadBlobData.blob, downloadBlobData.name)}
            label={results.length === 1 ? "ダウンロード" : "ZIPでダウンロード"}
          />
        </div>
      )}
    </div>
  );
}
