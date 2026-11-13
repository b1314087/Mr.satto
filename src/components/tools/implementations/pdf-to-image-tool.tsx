"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PdfToImageProcessor, type PdfToImageOutputItem } from "@/lib/processors/browser/pdf-render";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { useBatchSelection } from "@/components/common/use-batch-selection";
import { BatchNoticeMessage, BatchPlanHint } from "@/components/common/batch-notice";
import { BatchRunResults, packEntries, summarizeBatch, useBatchRun, countFiles } from "@/components/common/use-batch-run";

type OutputFormat = "image/png" | "image/jpeg";

const THUMBNAIL_LIMIT = 12;

export function PdfToImageTool() {
  // 選んだPDF。2つ以上のとき（プレミアムの一括処理）は、同じ形式で1つずつ順番に画像にする
  const [files, setFiles] = useState<File[]>([]);
  const file = files[0] ?? null;
  const isBatch = files.length > 1;
  const batch = useBatchSelection("pdf-to-image");
  const batchRun = useBatchRun();
  const [format, setFormat] = useState<OutputFormat>("image/png");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<PdfToImageOutputItem[] | null>(null);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);
  const [thumbUrls, setThumbUrls] = useState<string[]>([]);

  // アンマウント時に、最後に生成されたサムネイル用Object URLを解放する。
  // 空の依存配列のクロージャはマウント時点の古いthumbUrls（常に空配列）しか
  // 参照できないため、refで常に最新の値を保持し、クリーンアップはそこから読む
  // （pdf-fill-annotate-tool.tsxのobjectsRefと同じパターン、image-layout-tool.tsxの
  // fileUrlsRefも同様）。再実行時の解放は従来通りhandleRun内で行う
  // （handleRunは毎レンダーで新しいクロージャのため、こちらは元々最新値を正しく参照できていた）。
  const thumbUrlsRef = useRef(thumbUrls);
  useEffect(() => {
    thumbUrlsRef.current = thumbUrls;
  }, [thumbUrls]);
  useEffect(() => {
    return () => {
      thumbUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function clearOutputs() {
    setOutputs(null);
    setZipBlob(null);
    batchRun.reset();
    setError(null);
    setStatus("idle");
  }

  function handleSelect(selected: File[]) {
    setFiles(batch.pick(files, selected, "append"));
    clearOutputs();
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    clearOutputs();
  }

  /** 一括処理：選んだ全部のPDFを、同じ形式で1つずつ画像にする */
  async function handleRunBatch() {
    if (!(await batch.confirmBatch(files.length))) return;
    setStatus("processing");
    setError(null);
    setOutputs(null);
    setZipBlob(null);
    const items = await batchRun.run(files, async (target) => {
      const pages = await new PdfToImageProcessor().process({ file: target, mimeType: format });
      const packed = await packEntries(
        pages.map((page) => ({ name: page.suggestedName, blob: page.blob })),
        `${stripExtension(target.name)}-images.zip`
      );
      return { ...packed, detail: `${pages.length}ページ` };
    });
    const summary = summarizeBatch(items, "すべてのPDFで画像化に失敗しました");
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
    setOutputs(null);
    setZipBlob(null);
    thumbUrls.forEach((url) => URL.revokeObjectURL(url));
    setThumbUrls([]);
    try {
      const result = await new PdfToImageProcessor().process({ file, mimeType: format });
      setOutputs(result);
      setThumbUrls(
        result.slice(0, THUMBNAIL_LIMIT).map((item) => URL.createObjectURL(item.blob))
      );
      if (result.length > 1) {
        const zip = await createZip(result.map((r) => ({ name: r.suggestedName, blob: r.blob })));
        setZipBlob(zip);
      }
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!outputs || !file) return;
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].suggestedName);
    } else if (zipBlob) {
      downloadBlob(zipBlob, `${stripExtension(file.name)}-images.zip`);
    }
  }

  return (
    <div className="flex flex-col gap-6">
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

      {file && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            出力する画像形式
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              aria-pressed={format === "image/png"}
              onClick={() => {
                setFormat("image/png");
                batchRun.reset();
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                format === "image/png"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              PNG
            </button>
            <button
              type="button"
              aria-pressed={format === "image/jpeg"}
              onClick={() => {
                setFormat("image/jpeg");
                batchRun.reset();
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                format === "image/jpeg"
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              JPG
            </button>
          </div>
        </div>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isBatch ? `${countFiles(files.length)}のPDFをまとめて画像化する` : "画像化する"}
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={isBatch ? batchRun.progressLabel("画像化しています") : undefined}
        successLabel="画像化が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      <BatchRunResults items={batchRun.items} zipName={`${stripExtension(batchRun.items[0]?.file.name ?? "pdf") || "pdf"}-images.zip`} />

      {outputs && outputs.length > 0 && !isBatch && (
        <ResultPopup size="lg">
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {thumbUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt={`${i + 1}ページ目のプレビュー`}
                className="aspect-[3/4] w-full rounded-md border border-neutral-200 object-cover dark:border-neutral-700"
              />
            ))}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {outputs.length}ページを画像化しました
            {outputs.length > THUMBNAIL_LIMIT && `（プレビューは先頭${THUMBNAIL_LIMIT}件のみ表示）`}
          </p>
          <RewardedDownloadGate
            onDownload={handleDownload}
            disabled={outputs.length > 1 && !zipBlob}
            label={outputs.length === 1 ? "ダウンロード" : "ZIPでダウンロード"}
          />
        </ResultPopup>
      )}
    </div>
  );
}
