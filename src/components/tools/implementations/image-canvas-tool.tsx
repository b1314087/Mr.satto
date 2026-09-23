"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImageResizeProcessor,
  ImageCompressProcessor,
  ImageCompressToSizeProcessor,
  ImageConvertProcessor,
  ImageRotateProcessor,
} from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, replaceExtension } from "@/lib/utils/format";

type ImageMode = "resize" | "compress" | "compress-to-size" | "convert" | "rotate";

interface ImageToolSpec {
  mode: ImageMode;
  targetFormat?: "image/jpeg" | "image/png" | "image/webp";
  actionLabel: string;
}

const IMAGE_TOOL_CONFIG: Record<string, ImageToolSpec> = {
  "image-resize": { mode: "resize", actionLabel: "リサイズする" },
  "image-compress": { mode: "compress", actionLabel: "圧縮する" },
  "image-compress-to-size": { mode: "compress-to-size", actionLabel: "圧縮する" },
  "image-jpg-convert": { mode: "convert", targetFormat: "image/jpeg", actionLabel: "JPGに変換する" },
  "image-png-convert": { mode: "convert", targetFormat: "image/png", actionLabel: "PNGに変換する" },
  "image-webp-convert": { mode: "convert", targetFormat: "image/webp", actionLabel: "WebPに変換する" },
  "image-rotate": { mode: "rotate", actionLabel: "回転する" },
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function ImageCanvasTool({ toolId }: { toolId: string }) {
  const spec = IMAGE_TOOL_CONFIG[toolId];
  const [file, setFile] = useState<File | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);
  const [lockAspect, setLockAspect] = useState(true);
  const [quality, setQuality] = useState(80);
  const [targetKB, setTargetKB] = useState(300);
  const [rotateDegrees, setRotateDegrees] = useState<90 | 180 | 270>(90);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  useEffect(() => {
    if (!file) {
      // ファイル選択が解除された際に関連state をリセットする
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNaturalSize(null);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      setWidth(img.naturalWidth);
      setHeight(img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.src = url;
    setResult(null);
    setError(null);
    setStatus("idle");
  }, [file]);

  if (!spec) {
    return <ErrorMessage message="このツールの設定が見つかりませんでした" />;
  }

  function handleWidthChange(next: number) {
    setWidth(next);
    if (lockAspect && naturalSize) {
      setHeight(Math.round((next * naturalSize.height) / naturalSize.width));
    }
  }

  function handleHeightChange(next: number) {
    setHeight(next);
    if (lockAspect && naturalSize) {
      setWidth(Math.round((next * naturalSize.width) / naturalSize.height));
    }
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      let output: ImageProcessorOutput;
      switch (spec.mode) {
        case "resize":
          output = await new ImageResizeProcessor().process({ file, width, height });
          break;
        case "compress":
          output = await new ImageCompressProcessor().process({
            file,
            quality: quality / 100,
          });
          break;
        case "compress-to-size":
          output = await new ImageCompressToSizeProcessor().process({ file, targetKB });
          break;
        case "convert":
          output = await new ImageConvertProcessor().process({
            file,
            mimeType: spec.targetFormat!,
          });
          break;
        case "rotate":
          output = await new ImageRotateProcessor().process({ file, degrees: rotateDegrees });
          break;
      }
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? replaceExtension(
        file.name,
        result ? EXT_BY_MIME[result.mimeType] ?? "png" : "png"
      )
    : "output.png";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && spec.mode === "resize" && (
        <div className="flex flex-wrap items-end gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex flex-col gap-1 text-sm">
            幅 (px)
            <input
              type="number"
              min={1}
              value={width}
              onChange={(e) => handleWidthChange(Number(e.target.value))}
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            高さ (px)
            <input
              type="number"
              min={1}
              value={height}
              onChange={(e) => handleHeightChange(Number(e.target.value))}
              className="w-28 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-neutral-600 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={lockAspect}
              onChange={(e) => setLockAspect(e.target.checked)}
            />
            縦横比を固定
          </label>
        </div>
      )}

      {file && spec.mode === "compress" && (
        <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex items-center justify-between text-sm">
            <span>画質: {quality}%</span>
          </label>
          <input
            type="range"
            min={10}
            max={100}
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          />
        </div>
      )}

      {file && spec.mode === "compress-to-size" && (
        <label className="flex flex-col gap-1 rounded-xl border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          目標サイズ (KB)
          <input
            type="number"
            min={1}
            value={targetKB}
            onChange={(e) => setTargetKB(Number(e.target.value))}
            className="w-32 rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
      )}

      {file && spec.mode === "rotate" && (
        <div className="flex gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          {[90, 180, 270].map((deg) => (
            <button
              key={deg}
              type="button"
              onClick={() => setRotateDegrees(deg as 90 | 180 | 270)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                rotateDegrees === deg
                  ? "bg-blue-600 text-white"
                  : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {deg}°
            </button>
          ))}
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {spec.actionLabel}
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
