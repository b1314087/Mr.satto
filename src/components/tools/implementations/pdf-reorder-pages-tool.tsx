"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfPageOrderList } from "@/components/tools/implementations/shared/pdf-page-list";
import { PdfReorderPagesProcessor, getPdfPageCount } from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

export function PdfReorderPagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [order, setOrder] = useState<number[] | null>(null);

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
      setOrder(null);
      return;
    }
    let cancelled = false;
    setOrder(null);
    setResult(null);
    setError(null);
    setStatus("idle");
    getPdfPageCount(file)
      .then((count) => {
        if (!cancelled) setOrder(Array.from({ length: count }, (_, i) => i + 1));
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

  const isUnchanged = order?.every((p, i) => p === i + 1) ?? true;

  async function handleRun() {
    if (!file || !order) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfReorderPagesProcessor().process({ file, newOrder: order });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-reordered.pdf` : "reordered.pdf";

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

      {file && order && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ↑↓ ボタンでページの順序を並び替えられます（{order.length}ページ）
          </p>
          <PdfPageOrderList order={order} onReorder={setOrder} />
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
    </div>
  );
}
