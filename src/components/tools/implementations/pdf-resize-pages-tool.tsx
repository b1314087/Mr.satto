"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  PdfResizePagesProcessor,
  type PdfPageSizePreset,
  type PdfPageOrientation,
  type PdfResizeContentMode,
} from "@/lib/processors/browser/pdf";
import type { PdfProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const SIZE_OPTIONS: { value: PdfPageSizePreset; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "a3", label: "A3" },
  { value: "letter", label: "Letter" },
];

/**
 * PDFページサイズ変更（Phase 8）。
 * 「内容も拡大縮小するか」「ページサイズだけ変えるか」を、UI上でも
 * はっきり分けて選ばせる（開発指示書■9：どちらの動作かを曖昧にしない）。
 */
export function PdfResizePagesTool() {
  const [file, setFile] = useState<File | null>(null);
  const [pageSize, setPageSize] = useState<PdfPageSizePreset>("a4");
  const [orientation, setOrientation] = useState<PdfPageOrientation>("portrait");
  const [contentMode, setContentMode] = useState<PdfResizeContentMode>("fit");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfProcessorOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new PdfResizePagesProcessor().process({
        file,
        pageSize,
        orientation,
        contentMode,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-resized.pdf` : "resized.pdf";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => {
          setFile(files[0]);
          setResult(null);
          setError(null);
          setStatus("idle");
        }}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変更後のサイズ</p>
            <div className="flex gap-2">
              {SIZE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPageSize(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    pageSize === opt.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">向き</p>
            <div className="flex gap-2">
              {(
                [
                  { value: "portrait", label: "縦向き" },
                  { value: "landscape", label: "横向き" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setOrientation(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    orientation === opt.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">内容の扱い</p>
            <label className="flex items-start gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input
                type="radio"
                name="content-mode"
                checked={contentMode === "fit"}
                onChange={() => setContentMode("fit")}
                className="mt-0.5"
              />
              <span>
                内容も新しいサイズに合わせて拡大縮小する
                <span className="block text-xs text-neutral-400">
                  縦横比を保ったまま中央に配置します（推奨）
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input
                type="radio"
                name="content-mode"
                checked={contentMode === "keep"}
                onChange={() => setContentMode("keep")}
                className="mt-0.5"
              />
              <span>
                内容の大きさは変えず、ページサイズだけ変更する
                <span className="block text-xs text-neutral-400">
                  拡大時は余白が増え、縮小時は右上側の内容が見切れる場合があります
                </span>
              </span>
            </label>
          </div>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          変更する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="ページサイズの変更が完了しました" />
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
