"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { FileRenameProcessor, buildSequentialBaseNames } from "@/lib/processors/browser/file-ops";
import type { NamedFileOutput } from "@/lib/processors/types";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes, getExtension } from "@/lib/utils/format";

/**
 * ファイル連番リネーム。
 * 開始番号・桁数・接頭辞・接尾辞から連番名を生成し、
 * ファイルの並び順（ReorderableFileListで並び替え可能）に沿って
 * 割り当てる。実際のリネーム処理は一括リネームツールと共通の
 * FileRenameProcessor を使う。
 */
export function FileSequentialRenameTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [prefix, setPrefix] = useState("file");
  const [startNumberInput, setStartNumberInput] = useState("1");
  const [digitsInput, setDigitsInput] = useState("3");
  const [suffix, setSuffix] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<NamedFileOutput[] | null>(null);
  const [downloadBlobData, setDownloadBlobData] = useState<{ blob: Blob; name: string } | null>(
    null
  );

  const { previewNames, validationError } = useMemo(() => {
    if (files.length === 0) return { previewNames: [] as string[], validationError: null };
    const startNumber = Number(startNumberInput);
    const digits = Number(digitsInput);
    if (startNumberInput.trim() === "" || !Number.isInteger(startNumber) || startNumber < 0) {
      return { previewNames: [], validationError: "開始番号は0以上の整数で入力してください" };
    }
    if (digitsInput.trim() === "" || !Number.isInteger(digits) || digits < 1 || digits > 10) {
      return { previewNames: [], validationError: "桁数は1〜10の範囲の整数で入力してください" };
    }
    try {
      const bases = buildSequentialBaseNames({
        count: files.length,
        prefix,
        startNumber,
        digits,
        suffix,
      });
      const names = bases.map((base, i) => {
        const ext = getExtension(files[i].name);
        return ext ? `${base}.${ext}` : base;
      });
      return { previewNames: names, validationError: null };
    } catch (e) {
      return {
        previewNames: [],
        validationError: e instanceof Error ? e.message : "入力内容を確認してください",
      };
    }
  }, [files, prefix, startNumberInput, digitsInput, suffix]);

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setResults(null);
    setDownloadBlobData(null);
    setStatus("idle");
    setError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRun() {
    if (files.length === 0 || validationError) return;
    setStatus("processing");
    setError(null);
    setResults(null);
    setDownloadBlobData(null);
    try {
      const startNumber = Number(startNumberInput);
      const digits = Number(digitsInput);
      const newBaseNames = buildSequentialBaseNames({
        count: files.length,
        prefix,
        startNumber,
        digits,
        suffix,
      });
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
        hint="またはタップして選択。連番は表示中の並び順で付与されます"
        onFilesSelected={addFiles}
        onError={setError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">連番の設定</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              接頭辞
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              開始番号
              <input
                type="number"
                value={startNumberInput}
                onChange={(e) => setStartNumberInput(e.target.value)}
                className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              桁数
              <input
                type="number"
                value={digitsInput}
                onChange={(e) => setDigitsInput(e.target.value)}
                className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
              接尾辞（任意）
              <input
                type="text"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                className="rounded-lg border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              />
            </label>
          </div>

          {validationError ? (
            <ErrorMessage message={validationError} />
          ) : (
            previewNames.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  プレビュー
                </p>
                <ul className="flex flex-col gap-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                  {previewNames.slice(0, 5).map((name, i) => (
                    <li key={i} className="truncate">
                      {files[i]?.name} → {name}
                    </li>
                  ))}
                  {previewNames.length > 5 && (
                    <li className="text-neutral-400">他 {previewNames.length - 5} 件…</li>
                  )}
                </ul>
              </div>
            )
          )}
        </div>
      )}

      {files.length > 0 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || !!validationError}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件を連番リネームする
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
