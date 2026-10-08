"use client";

import { useEffect, useMemo, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
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

interface ImageRunSettings {
  width: number;
  height: number;
  quality: number;
  targetKB: number;
  rotateDegrees: 90 | 180 | 270;
}

/**
 * 実行ボタンとライブプレビューで共通に使う処理。
 * プレビューも実際のProcessorで同じ設定を処理するため、プレビューどおりの結果が書き出される。
 */
async function runImageProcessor(
  spec: ImageToolSpec,
  file: File,
  s: ImageRunSettings
): Promise<ImageProcessorOutput> {
  switch (spec.mode) {
    case "resize":
      return new ImageResizeProcessor().process({ file, width: s.width, height: s.height });
    case "compress":
      return new ImageCompressProcessor().process({ file, quality: s.quality / 100 });
    case "compress-to-size":
      return new ImageCompressToSizeProcessor().process({ file, targetKB: s.targetKB });
    case "convert":
      return new ImageConvertProcessor().process({ file, mimeType: spec.targetFormat! });
    case "rotate":
      return new ImageRotateProcessor().process({ file, degrees: s.rotateDegrees });
  }
}

/** プレビューで処理する最大ピクセル数(これを超えるリサイズ指定はプレビューを省略する) */
const PREVIEW_MAX_PIXELS = 40_000_000;
/** 設定変更後、プレビューを再計算するまでの待ち時間(ms) */
const PREVIEW_DEBOUNCE_MS = 250;

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
  const [preview, setPreview] = useState<{ key: string; file: File; output: ImageProcessorOutput } | null>(null);
  const [previewError, setPreviewError] = useState<{ key: string; message: string } | null>(null);

  const originalUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);

  // 設定が処理可能な値かどうか(リサイズの幅・高さ、目標KB)
  const settingsValid =
    spec?.mode === "resize"
      ? Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1
      : spec?.mode === "compress-to-size"
        ? Number.isFinite(targetKB) && targetKB >= 1
        : true;
  const tooLarge = spec?.mode === "resize" && settingsValid && Math.round(width) * Math.round(height) > PREVIEW_MAX_PIXELS;
  // プレビューが「どのファイル・どの設定」の結果かを識別するキー
  const previewKey = !file || !spec
    ? ""
    : [
        toolId,
        file.name,
        file.size,
        file.lastModified,
        spec.mode === "resize" ? `${Math.round(width)}x${Math.round(height)}` : "",
        spec.mode === "compress" ? quality : "",
        spec.mode === "compress-to-size" ? targetKB : "",
        spec.mode === "rotate" ? rotateDegrees : "",
      ].join("|");

  // 設定を変えるたびに、実際のProcessorで処理した結果をプレビューとして更新する
  useEffect(() => {
    if (!file || !spec || !settingsValid || tooLarge) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const output = await runImageProcessor(spec, file, { width, height, quality, targetKB, rotateDegrees });
        if (cancelled) {
          URL.revokeObjectURL(output.url);
          return;
        }
        setPreviewError(null);
        setPreview({ key: previewKey, file, output });
      } catch (e) {
        if (!cancelled) {
          setPreviewError({ key: previewKey, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
        }
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [file, spec, settingsValid, tooLarge, width, height, quality, targetKB, rotateDegrees, previewKey]);

  // プレビュー用Object URLは、差し替わる時・アンマウント時に解放する
  const previewOutput = preview?.output ?? null;
  const shownPreview = preview && preview.file === file ? preview : null;
  const previewStale = shownPreview !== null && shownPreview.key !== previewKey;
  const shownError = previewError && previewError.key === previewKey ? previewError.message : null;
  useEffect(() => {
    return () => {
      if (previewOutput) URL.revokeObjectURL(previewOutput.url);
    };
  }, [previewOutput]);

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
    };
    img.src = url;
    setResult(null);
    setError(null);
    setStatus("idle");
    // Phase 7: revokeをonloadの中だけで行うと、画像のdecodeに失敗した場合
    // （onerror）や、ファイルが素早く変更されてこのeffectが再実行された場合に
    // Object URLが解放されないまま残ってしまう。cleanup関数側で必ず解放する
    // ようにし、どちらのケースでも確実に解放されるようにする。
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    // 処理結果のプレビュー用Object URLは、次の結果に差し替わる時・
    // アンマウント時に解放する（解放しないとメモリリークになる）
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

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
      const output = await runImageProcessor(spec, file, { width, height, quality, targetKB, rotateDegrees });
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
    <PreviewSplitLayout
      previewWidth="lg"
      preview={file ? (
        <div data-testid="tool-preview" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            プレビュー（設定を変えると結果が更新されます）
          </p>
          {shownError && <ErrorMessage message={shownError} />}
          {tooLarge && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              指定サイズが大きすぎるため、プレビューは表示できません（書き出しは実行できます）。
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className="flex min-w-0 flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                元の画像{naturalSize ? ` ・ ${naturalSize.width} × ${naturalSize.height}px` : ""} ・ {formatBytes(file.size)}
              </figcaption>
              {originalUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={originalUrl}
                  alt="元の画像"
                  className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                />
              )}
            </figure>
            <figure className="flex min-w-0 flex-col gap-1">
              <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">
                {shownPreview
                  ? `処理後 ・ ${shownPreview.output.width} × ${shownPreview.output.height}px ・ ${formatBytes(shownPreview.output.sizeBytes)}${
                      file.size > 0 ? `（元の${Math.round((shownPreview.output.sizeBytes / file.size) * 100)}%）` : ""
                    }`
                  : "処理後"}
                {previewStale ? " ・ 更新中..." : ""}
              </figcaption>
              {shownPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shownPreview.output.url}
                  alt="処理後のプレビュー"
                  className={`max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain transition-opacity dark:border-neutral-700 dark:bg-neutral-900 ${
                    previewStale ? "opacity-50" : ""
                  }`}
                />
              ) : (
                <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-xs text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                  {tooLarge || shownError ? "プレビューなし" : "プレビューを作成中..."}
                </div>
              )}
            </figure>
          </div>
        </div>
      ) : null}
    >
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
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </PreviewSplitLayout>
  );
}
