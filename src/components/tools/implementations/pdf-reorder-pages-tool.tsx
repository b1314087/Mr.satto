"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfPageOrderList } from "@/components/tools/implementations/shared/pdf-page-list";
import { fileKey, revokeOutputUrl, useKeyedRun } from "@/components/tools/implementations/shared/use-keyed-run";
import { usePdfPageCount } from "@/components/tools/implementations/shared/use-pdf-page-count";
import { PdfReorderPagesProcessor, pdfOutputName } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

const PREVIEW_MAX_PAGES = 40;

export function PdfReorderPagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [edited, setEdited] = useState<{ file: File; order: number[] } | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const { pageCount, loadError } = usePdfPageCount(file);

  // 並び順は「どのファイルの並び順か」と一緒に持つ。ファイルを選び直すと、元の順序に戻る
  const order: number[] | null =
    pageCount === null
      ? null
      : edited && edited.file === file
        ? edited.order
        : Array.from({ length: pageCount }, (_, i) => i + 1);

  // 結果は「どのファイル・どの並び順の結果か」と一緒に持つ。いまの並び順と違う古い結果は、表示もダウンロードもしない
  const settingKey = file && order ? `${fileKey(file)}|${order.join(",")}` : "";
  const run = useKeyedRun<PdfProcessorOutput>(settingKey, { dispose: revokeOutputUrl });
  const result = run.value;
  const error = loadError ?? run.error ?? inputError;
  const status: ProcessingState = loadError ? "error" : run.status;

  function selectFile(next: File | null) {
    setFile(next);
    setEdited(null);
    setInputError(null);
    run.reset();
  }

  const isUnchanged = order?.every((p, i) => p === i + 1) ?? true;

  function handleRun() {
    if (!file || !order) return;
    const newOrder = order;
    void run.run(() => new PdfReorderPagesProcessor().process({ file, newOrder }));
  }

  const downloadName = file ? pdfOutputName(file.name, "reordered") : "reordered.pdf";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file && order ? (
          <div data-testid="tool-preview" className="flex flex-col gap-2">
            <PdfThumbnails
              file={file}
              maxPages={PREVIEW_MAX_PAGES}
              width={96}
              title="並び替え後のプレビュー"
              // 現在の並び順(先頭から)に並べる。サムネイルを作るのは先頭 PREVIEW_MAX_PAGES ページ(元の番号)まで
              pages={order.filter((p) => p <= PREVIEW_MAX_PAGES)}
              overlay={(page) => (
                <span className="absolute left-1 top-1 rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {order.indexOf(page) + 1}番目
                </span>
              )}
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {isUnchanged
                ? "現在は元の順序です。↑↓で並び替えると、ここに結果が反映されます。"
                : "この順序で出力されます。バッジは新しい位置、サムネイル下の数字は元のページ番号です。"}
              {order.length > PREVIEW_MAX_PAGES && `（サムネイルは元の先頭${PREVIEW_MAX_PAGES}ページ分のみ表示）`}
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

      {file && order && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ↑↓ ボタンでページの順序を並び替えられます（{order.length}ページ）
          </p>
          <PdfPageOrderList order={order} onReorder={(next) => file && setEdited({ file, order: next })} />
        </div>
      )}

      {file && order && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || isUnchanged}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          並び替えを適用する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="並び替えが完了しました" />
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
