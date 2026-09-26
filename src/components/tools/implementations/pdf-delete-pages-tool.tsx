"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfPageCheckList } from "@/components/tools/implementations/shared/pdf-page-list";
import { PdfDeletePagesProcessor, getPdfPageCount } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

export function PdfDeletePagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfProcessorOutput | null>(null);

  // Phase 7: 生成結果のObject URL(result.url)は画面上で使っていないが、
  // 解放しないとページを離れるまでメモリに残り続けるため、明示的に解放する。
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  useEffect(() => {
    if (!file) {
      // ファイル選択が解除された際に関連stateをリセットする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPageCount(null);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    setPageCount(null);
    setSelected(new Set());
    setResult(null);
    setError(null);
    setStatus("idle");
    getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setPageCount(count);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  function togglePage(pageNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageNumber)) next.delete(pageNumber);
      else next.add(pageNumber);
      return next;
    });
  }

  async function handleRun() {
    if (!file || selected.size === 0) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfDeletePagesProcessor().process({
        file,
        pagesToDelete: Array.from(selected),
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-deleted.pdf` : "deleted.pdf";
  const willDeleteAll = pageCount !== null && selected.size >= pageCount;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

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
    </div>
  );
}
