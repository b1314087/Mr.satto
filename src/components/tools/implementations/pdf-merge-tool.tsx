"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { ReorderableFileList } from "@/components/tools/implementations/shared/reorderable-file-list";
import { ProcessingStatus } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { OpenInPdfFixButton } from "@/components/tools/implementations/shared/open-in-pdf-fix-button";
import { fileKey as fileIdentity, revokeOutputUrl, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { PdfMergeProcessor, pdfOutputName } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

// 並べ替えてもサムネイルを作り直さないよう、Fileごとに固定のキーを割り当てる
const fileKeys = new WeakMap<File, number>();
let nextFileKey = 1;
function fileKey(file: File): number {
  let key = fileKeys.get(file);
  if (key === undefined) {
    key = nextFileKey++;
    fileKeys.set(file, key);
  }
  return key;
}

export function PdfMergeTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);

  // 結果は「どのファイルを・どの順序で結合したか」と一緒に持つ。いまのファイル・順序と違う古い結果は、
  // 表示もダウンロードもしない（ファイルの追加・削除・並べ替えのたびに、前の結合結果は使えなくなる）
  const settingKey = files.length > 0 ? files.map((f) => `${fileKey(f)}:${fileIdentity(f)}`).join("|") : "";
  const run = useKeyedRun<PdfProcessorOutput>(settingKey, { dispose: revokeOutputUrl });
  const result = run.value;
  const error = run.error ?? inputError;
  const status = run.status;

  function addFiles(newFiles: File[]) {
    setFiles((prev) => [...prev, ...newFiles]);
    setInputError(null);
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleRun() {
    if (files.length < 2) return;
    const targets = files;
    void run.run(() => new PdfMergeProcessor().process({ files: targets }));
  }

  const downloadName = files[0] ? pdfOutputName(files[0].name, "merged") : "merged.pdf";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        files.length > 0 ? (
        <div data-testid="tool-preview" className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">結合のプレビュー（上から順に結合）</p>
          <ol className="flex flex-wrap gap-3">
            {files.map((file, index) => (
              <li key={fileKey(file)} className="flex w-[calc(140px+2rem+2px)] max-w-full flex-col gap-1">
                <p className="truncate text-xs text-neutral-600 dark:text-neutral-300" title={file.name}>
                  <span className="mr-1 inline-block rounded-full bg-blue-600 px-1.5 text-[10px] font-semibold text-white">
                    {index + 1}
                  </span>
                  {file.name}
                </p>
                <PdfThumbnails file={file} maxPages={1} title="先頭ページ" />
              </li>
            ))}
          </ol>
        </div>
        ) : (
          <div className="hidden rounded-xl border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-400 lg:block dark:border-neutral-700">
            PDFを選ぶと、ここにプレビューが表示されます
          </div>
        )
      }
    >
      <FileDropzone
        accept="application/pdf,.pdf"
        multiple
        maxSizeMB={100}
        label="PDFをドラッグ&ドロップ（複数可）"
        hint="またはタップして選択"
        onFilesSelected={addFiles}
        onError={setInputError}
      />

      {files.length > 0 && (
        <ReorderableFileList files={files} onReorder={setFiles} onRemove={removeFile} />
      )}

      {files.length > 0 && files.length < 2 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          結合するには、もう1つ以上PDFを追加してください。
        </p>
      )}

      {files.length >= 2 && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {files.length}件のPDFを結合する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="結合が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
          <OpenInPdfFixButton blob={result.blob} fileName={downloadName} />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
