"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import {
  FileInspectorProcessor,
  type FileInspectorOutput,
} from "@/lib/processors/browser/file-inspector";
import { formatBytes } from "@/lib/utils/format";

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString("ja-JP");
  } catch {
    return "-";
  }
}

/**
 * ファイル情報確認（Phase 8）。
 * ファイルを選択するだけで、名前・種類・サイズ・更新日時に加え、
 * 画像なら幅×高さ、PDFならページ数、CSV/TXTなら行数（CSVは列数も）を表示する。
 */
export function FileInspectorTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FileInspectorOutput | null>(null);

  async function handleSelect(files: File[]) {
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setError(null);
    setStatus("processing");
    try {
      const output = await new FileInspectorProcessor().process({ file: selected });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイル情報の取得に失敗しました");
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        maxSizeMB={200}
        label="ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（形式は問いません）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => { setFile(null); setResult(null); setStatus("idle"); }} />}

      <ProcessingStatus state={status} processingLabel="情報を確認中..." successLabel="確認が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <dl className="grid grid-cols-1 gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm sm:grid-cols-2 dark:border-neutral-800 dark:bg-neutral-900">
          <div>
            <dt className="text-xs text-neutral-500 dark:text-neutral-400">ファイル名</dt>
            <dd className="break-all font-medium text-neutral-800 dark:text-neutral-100">{result.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500 dark:text-neutral-400">種類（MIME）</dt>
            <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.mimeType}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500 dark:text-neutral-400">拡張子</dt>
            <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.extension || "(なし)"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500 dark:text-neutral-400">サイズ</dt>
            <dd className="font-medium text-neutral-800 dark:text-neutral-100">{formatBytes(result.sizeBytes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500 dark:text-neutral-400">最終更新日時</dt>
            <dd className="font-medium text-neutral-800 dark:text-neutral-100">
              {formatDate(result.lastModifiedMs)}
            </dd>
          </div>

          {result.imageDimensions && (
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">画像サイズ</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                {result.imageDimensions.width} × {result.imageDimensions.height}px
              </dd>
            </div>
          )}

          {result.pdfPageCount !== null && (
            <div>
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">ページ数</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">{result.pdfPageCount}ページ</dd>
            </div>
          )}

          {result.textInfo && (
            <div className="sm:col-span-2">
              <dt className="text-xs text-neutral-500 dark:text-neutral-400">内容の集計</dt>
              <dd className="font-medium text-neutral-800 dark:text-neutral-100">
                {result.textInfo.skippedLargeFile
                  ? "ファイルサイズが大きいため、行数・列数の集計はスキップしました。"
                  : result.textInfo.columns !== null
                    ? `${result.textInfo.lines}行 ・ ${result.textInfo.columns}列`
                    : `${result.textInfo.lines}行`}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
