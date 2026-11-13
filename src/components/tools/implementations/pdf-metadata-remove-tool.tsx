"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfThumbnails } from "@/components/common/pdf-thumbnails";
import {
  PdfMetadataRemoveProcessor,
  readPdfMetadata,
  type PdfMetadataInfo,
  type PdfMetadataRemoveOutput,
} from "@/lib/processors/browser/pdf";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, summarizeBatch, useBatchRun, countFiles } from "@/components/common/use-batch-run";

const FIELD_LABELS: { key: keyof PdfMetadataInfo; label: string }[] = [
  { key: "title", label: "タイトル" },
  { key: "author", label: "作成者" },
  { key: "subject", label: "件名" },
  { key: "keywords", label: "キーワード" },
  { key: "creator", label: "アプリケーション" },
  { key: "producer", label: "PDF変換ツール" },
];

/**
 * PDFメタデータ削除（Phase 8）。
 * 削除前に現在のメタデータを表示し、削除後は実際に保存済みPDFを再読み込み
 * した結果（remainingMetadata）を表示する。「削除できたことにする」のではなく、
 * 実測値をそのまま見せる（開発指示書■8）。
 */
export function PdfMetadataRemoveTool() {
  // 選んだPDF。2つ以上のとき（プレミアムの一括処理）は、1つずつ順番にメタデータを削除する
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("pdf-metadata-remove");
  const batchRun = useBatchRun();
  const [before, setBefore] = useState<PdfMetadataInfo | null>(null);
  const [beforeError, setBeforeError] = useState<string | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfMetadataRemoveOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBefore(null);
      setBeforeError(null);
      return;
    }
    let cancelled = false;
    setBefore(null);
    setBeforeError(null);
    setResult(null);
    setError(null);
    setStatus("idle");
    readPdfMetadata(file)
      .then((info) => {
        if (!cancelled) setBefore(info);
      })
      .catch((e) => {
        if (!cancelled) setBeforeError(e instanceof Error ? e.message : "PDFの読み込みに失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  function handleSelect(selected: File[]) {
    setFiles(batch.pick(files, selected, "append"));
    batchRun.reset();
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    batchRun.reset();
    setResult(null);
    setStatus("idle");
  }

  /** 一括処理：選んだ全部のファイルを、同じ設定で1つずつ順番に処理する */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    const items = await batchRun.run(files, async (target) => {
      const output = await new PdfMetadataRemoveProcessor().process({ file: target });
      URL.revokeObjectURL(output.url);
      const remaining = FIELD_LABELS.filter((f) => output.remainingMetadata[f.key]).map((f) => f.label);
      return {
        blob: output.blob,
        outputName: `${stripExtension(target.name)}-no-metadata.pdf`,
        detail: remaining.length === 0 ? "標準的なメタデータをすべて削除" : `残った項目：${remaining.join("・")}`,
      };
    });
    const summary = summarizeBatch(items, "すべてのPDFでメタデータの削除に失敗しました");
    setStatus(summary.status);
    setError(summary.error);
  }

  async function handleRun() {
    if (!file) return;
    if (isBatch) {
      await handleRunBatch();
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfMetadataRemoveProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-no-metadata.pdf` : "no-metadata.pdf";
  const hasAnyBeforeValue = before ? FIELD_LABELS.some((f) => before[f.key]) : false;
  const hasAnyRemainingValue = result ? FIELD_LABELS.some((f) => result.remainingMetadata[f.key]) : false;

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">XMPなど一部のメタデータは、削除できない場合があります。</div>

      <FileDropzone
        compact={files.length > 0}
        compactAction={batch.batchAllowed ? "add" : "replace"}
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        multiple
        onFilesSelected={handleSelect}
        onError={setError}
      />

      <BatchPlanHint batchAllowed={batch.batchAllowed} limit={batch.limit} />
      <BatchNoticeMessage notice={batch.notice} onClose={batch.clearNotice} />

      {files.length > 0 && <FileList files={files} onRemove={removeFile} />}
      {isBatch && (
        <p data-testid="batch-note" className="text-xs text-ms-muted">
          表示は1つ目のPDFのメタデータです。ほかのPDFも同じように削除します。
        </p>
      )}

      {beforeError && <ErrorMessage message={beforeError} />}

      {file && (
        <PreviewFullscreenFrame>
        <div data-testid="tool-preview" className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <PdfThumbnails file={file} pages={[1]} maxPages={1} width={140} title="先頭ページ" className="sm:shrink-0" />
          {before && (
            <div className="min-w-0 flex-1 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <p className="mb-2 font-medium text-neutral-700 dark:text-neutral-200">
                {result ? "メタデータの削除前と削除後" : "現在のメタデータ"}
              </p>
              {hasAnyBeforeValue ? (
                <ul className="flex flex-col gap-2 text-neutral-600 dark:text-neutral-300">
                  {FIELD_LABELS.filter((f) => before[f.key]).map((f) => (
                    <li key={f.key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                      <span className="w-32 shrink-0 text-neutral-400">{f.label}</span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className={`break-all ${result ? "line-through decoration-neutral-400" : ""}`}>
                          {before[f.key]}
                        </span>
                        {result &&
                          (result.remainingMetadata[f.key] ? (
                            <span className="break-all text-red-600 dark:text-red-400">
                              削除後も残っています: {result.remainingMetadata[f.key]}
                            </span>
                          ) : (
                            <span className="text-xs text-green-700 dark:text-green-400">削除済み(削除後は空)</span>
                          ))}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-neutral-400">標準的なメタデータは設定されていません。</p>
              )}
            </div>
          )}
        </div>
        </PreviewFullscreenFrame>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${countFiles(files.length)}のPDFのメタデータをまとめて削除する` : "メタデータを削除する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel={isBatch ? batchRun.progressLabel("メタデータを削除しています") : undefined} successLabel="メタデータの削除が完了しました" />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "pdf") || "pdf"}-no-metadata.zip`} />

      {result && !isBatch && (
        <ResultPopup>
          {hasAnyRemainingValue ? (
            <ul className="flex flex-col gap-1 text-sm text-red-600 dark:text-red-400">
              {FIELD_LABELS.filter((f) => result.remainingMetadata[f.key]).map((f) => (
                <li key={f.key}>
                  {f.label}: {result.remainingMetadata[f.key]}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-green-700 dark:text-green-400">
              標準的なメタデータがすべて削除されたことを確認しました。
            </p>
          )}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{formatBytes(result.sizeBytes)}</p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </ResultPopup>
      )}
    </div>
  );
}
