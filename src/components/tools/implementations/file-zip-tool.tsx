"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { FileZipProcessor, planZipEntryNames } from "@/lib/processors/browser/file-ops";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

/** この合計サイズ以下なら、プレビューでも実際にZIPを作ってサイズを出す */
const EXACT_ESTIMATE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_ROWS = 200;

/** すでに圧縮されている形式（ZIPでほとんど小さくならない） */
const ALREADY_COMPRESSED_EXT = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "zip", "gz", "7z", "rar",
  "mp3", "m4a", "aac", "ogg", "mp4", "mov", "webm", "mkv", "pdf", "docx", "xlsx", "pptx",
]);
const TEXT_LIKE_EXT = new Set(["txt", "csv", "tsv", "json", "xml", "html", "css", "js", "md", "log", "svg"]);

/** 大きなファイル用の、拡張子からのざっくりした圧縮後サイズ見積もり */
function roughZipEstimate(files: File[]): number {
  let total = 0;
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    const ratio = ALREADY_COMPRESSED_EXT.has(ext) ? 0.98 : TEXT_LIKE_EXT.has(ext) ? 0.3 : 0.7;
    total += f.size * ratio;
  }
  return Math.round(total);
}

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

  // ZIPのおおよそのサイズ。小さい場合は実際の FileZipProcessor で作った結果、
  // 大きい場合は拡張子ごとの目安。ファイル配列ごとに結果を紐づけて導出する。
  const [measured, setMeasured] = useState<{ files: File[]; size: number } | null>(null);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const canMeasure = files.length > 0 && totalBytes <= EXACT_ESTIMATE_MAX_BYTES;

  useEffect(() => {
    if (!canMeasure) return;
    let cancelled = false;
    new FileZipProcessor()
      .process({ files })
      .then((out) => {
        if (!cancelled) setMeasured({ files, size: out.sizeBytes });
      })
      .catch(() => {
        if (!cancelled) setMeasured(null);
      });
    return () => {
      cancelled = true;
    };
  }, [files, canMeasure]);

  const exactSize = canMeasure && measured && measured.files === files ? measured.size : null;
  const zipEntryNames = planZipEntryNames(files);

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
        <div
          data-testid="tool-preview"
          className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            ZIPに入るファイル（{files.length}件）
          </p>
          <ul className="flex flex-col divide-y divide-neutral-200 text-xs text-neutral-600 dark:divide-neutral-800 dark:text-neutral-300">
            {files.slice(0, MAX_PREVIEW_ROWS).map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 break-all">{zipEntryNames[i]}</span>
                <span className="shrink-0 text-neutral-400">{formatBytes(f.size)}</span>
              </li>
            ))}
            {files.length > MAX_PREVIEW_ROWS && (
              <li className="py-1.5 text-neutral-400">他 {files.length - MAX_PREVIEW_ROWS} 件…</li>
            )}
          </ul>
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-neutral-200 pt-2 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
            <span>合計: {formatBytes(totalBytes)}</span>
            <span>
              ZIPのサイズ:{" "}
              {exactSize !== null
                ? formatBytes(exactSize)
                : canMeasure
                  ? "計算中..."
                  : `約 ${formatBytes(roughZipEstimate(files))}（目安）`}
            </span>
          </div>
        </div>
      )}

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
