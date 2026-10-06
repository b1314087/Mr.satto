"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageGrayscaleProcessor, applyGrayscale } from "@/lib/processors/browser/image";
import { useDownscaledImage, useObjectUrl } from "@/components/tools/implementations/shared/image-live-preview";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, replaceExtension } from "@/lib/utils/format";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** プレビュー用に縮小する最長辺(px) */
const PREVIEW_MAX_SIDE = 640;

export function ImageGrayscaleTool() {
  const [file, setFile] = useState<File | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // --- ライブプレビュー: 元画像と白黒化後を並べる(計算は書き出しと同じ applyGrayscale) ---
  const originalUrl = useObjectUrl(file);
  const { canvas: scaled, error: previewError } = useDownscaledImage(file, PREVIEW_MAX_SIDE);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = previewCanvasRef.current;
    if (!scaled || !target) return;
    const sourceCtx = scaled.getContext("2d");
    const ctx = target.getContext("2d");
    if (!sourceCtx || !ctx) return;
    const data = sourceCtx.getImageData(0, 0, scaled.width, scaled.height);
    applyGrayscale(data.data);
    target.width = scaled.width;
    target.height = scaled.height;
    ctx.putImageData(data, 0, 0);
  }, [scaled]);

  function handleFile(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImageGrayscaleProcessor().process({ file });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? replaceExtension(file.name, result ? EXT_BY_MIME[result.mimeType] ?? "png" : "png")
    : "grayscale.png";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={handleFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div
          data-testid="tool-preview"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（元の画像と白黒化後）</p>
          {previewError && <ErrorMessage message={previewError} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">元の画像</figcaption>
              {originalUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={originalUrl}
                  alt="元の画像"
                  className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                />
              )}
            </figure>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">グレースケール後</figcaption>
              <canvas
                ref={previewCanvasRef}
                aria-label="グレースケール後のプレビュー"
                className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
              />
            </figure>
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
          グレースケールに変換する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="変換が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.url}
            alt="処理結果のプレビュー"
            className="max-h-64 rounded-lg border border-neutral-200 object-contain dark:border-neutral-700"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
