"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfPageCheckList } from "@/components/tools/implementations/shared/pdf-page-list";
import { fileKey, revokeOutputUrl, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { usePdfPageCount } from "@/components/tools/implementations/shared/use-pdf-page-count";
import { PdfDeletePagesProcessor, pdfOutputName } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

const PREVIEW_MAX_PAGES = 40;

export function PdfDeletePagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [inputError, setInputError] = useState<string | null>(null);
  const { pageCount, loadError } = usePdfPageCount(file);

  // 結果は「どのファイル・どのページを削除したか」と一緒に持つ。いまの選択と違う古い結果は、表示もダウンロードもしない
  const settingKey = file ? `${fileKey(file)}|${Array.from(selected).sort((x, y) => x - y).join(",")}` : "";
  const run = useKeyedRun<PdfProcessorOutput>(settingKey, { dispose: revokeOutputUrl });
  const result = run.value;
  const error = loadError ?? run.error ?? inputError;
  const status: ProcessingState = loadError ? "error" : run.status;

  function selectFile(next: File | null) {
    setFile(next);
    setSelected(new Set());
    setInputError(null);
    run.reset();
  }

  function togglePage(pageNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageNumber)) next.delete(pageNumber);
      else next.add(pageNumber);
      return next;
    });
  }

  function handleRun() {
    if (!file || selected.size === 0) return;
    const pagesToDelete = Array.from(selected);
    void run.run(() => new PdfDeletePagesProcessor().process({ file, pagesToDelete }));
  }

  const downloadName = file ? pdfOutputName(file.name, "deleted") : "deleted.pdf";
  const willDeleteAll = pageCount !== null && selected.size >= pageCount;

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file && pageCount !== null ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <PdfThumbnails
              file={file}
              maxPages={PREVIEW_MAX_PAGES}
              width={96}
              title="削除のプレビュー"
              onPageClick={togglePage}
              pageStyle={(page) => (selected.has(page) ? { opacity: 0.35 } : undefined)}
              overlay={(page) =>
                selected.has(page) ? (
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 border-2 border-red-500 bg-red-500/30 text-red-700 dark:text-red-200">
                    <span aria-hidden className="text-3xl font-bold leading-none">×</span>
                    <span className="rounded bg-red-600 px-1.5 text-[10px] font-semibold text-white">削除</span>
                  </span>
                ) : null
              }
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {selected.size === 0
                ? "サムネイルをタップしても削除するページを選べます。"
                : `赤く表示されたページが削除され、${Math.max(pageCount - selected.size, 0)}ページが残ります。`}
            </p>
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
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => selectFile(files[0])}
        onError={setInputError}
      />

      {file && <FileList files={[file]} onRemove={() => selectFile(null)} />}

      {file && pageCount !== null && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除するページをタップして選択してください（{pageCount}ページ中{selected.size}ページを選択）
          </p>
          <PdfPageCheckList pageCount={pageCount} selected={selected} onToggle={togglePage} />
          {willDeleteAll && (
            <p className="text-xs text-red-600 dark:text-red-400">
              すべてのページを削除することはできません。少なくとも1ページは残してください。
            </p>
          )}
        </div>
      )}

      {file && pageCount !== null && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || selected.size === 0 || willDeleteAll}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {selected.size}ページを削除する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="削除が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.pageCount}ページ ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </PreviewSplitLayout>
  );
}
