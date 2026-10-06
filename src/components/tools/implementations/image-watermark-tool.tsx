"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { SliderField } from "@/components/common/slider-field";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  ImageWatermarkProcessor,
  WATERMARK_FONT_SIZE_MAX,
  WATERMARK_FONT_SIZE_MIN,
  drawWatermarkText,
  loadImage,
  type ImageWatermarkPosition,
} from "@/lib/processors/browser/image";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, replaceExtension } from "@/lib/utils/format";

const POSITION_OPTIONS: { value: ImageWatermarkPosition; label: string }[] = [
  { value: "top-left", label: "左上" },
  { value: "top-right", label: "右上" },
  { value: "center", label: "中央" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-right", label: "右下" },
];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** プレビュー用に縮小する最長辺(px) */
const PREVIEW_MAX_SIDE = 800;

/** 画像の大きさに合わせた、文字サイズのスライダー上限(px)。写真の長辺ほどまで大きくできる */
function fontSizeSliderMax(naturalWidth: number | null, naturalHeight: number | null): number {
  if (!naturalWidth || !naturalHeight) return 400;
  const longest = Math.max(naturalWidth, naturalHeight);
  return Math.min(WATERMARK_FONT_SIZE_MAX, Math.max(400, longest));
}

/**
 * 画像ウォーターマーク（Phase 8）。
 * PDF透かし（pdf-watermark）の「位置・不透明度・回転」という設定項目の
 * 考え方を踏襲しつつ、Canvas APIのみで実装する（新しい画像用ライブラリは追加しない）。
 *
 * 設定を変えるたびに縮小したプレビューへ同じ描画関数(drawWatermarkText)で透かしを描き直す。
 * 文字サイズは「元画像のピクセル」で指定する(プレビューでは縮小率を掛けて同じ見た目にする)。
 * スライダーの上限は画像の大きさに合わせて広がる。
 */
export function ImageWatermarkTool() {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("CONFIDENTIAL");
  const [position, setPosition] = useState<ImageWatermarkPosition>("bottom-right");
  const [opacity, setOpacity] = useState(50);
  const [fontSize, setFontSize] = useState(32);
  const [rotation, setRotation] = useState(0);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImageProcessorOutput | null>(null);

  // --- プレビュー ---
  const baseRef = useRef<{ canvas: HTMLCanvasElement; scale: number } | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [prepared, setPrepared] = useState<{ file: File; width: number; height: number } | null>(null);
  const [previewErrorFor, setPreviewErrorFor] = useState<{ file: File; message: string } | null>(null);
  const previewReady = file !== null && prepared?.file === file;
  const naturalSize = previewReady && prepared ? { width: prepared.width, height: prepared.height } : null;
  const previewError = previewErrorFor && previewErrorFor.file === file ? previewErrorFor.message : null;
  const sliderMax = fontSizeSliderMax(naturalSize?.width ?? null, naturalSize?.height ?? null);
  const shownFontSize = fontSize;

  const originalUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
    };
  }, [originalUrl]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  useEffect(() => {
    let cancelled = false;
    baseRef.current = null;
    if (!file) return;
    (async () => {
      try {
        const img = await loadImage(file);
        if (cancelled) return;
        const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        ctx.drawImage(img, 0, 0, c.width, c.height);
        baseRef.current = { canvas: c, scale };
        setPrepared({ file, width: img.naturalWidth, height: img.naturalHeight });
      } catch (e) {
        if (!cancelled) setPreviewErrorFor({ file, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    const base = baseRef.current;
    const canvas = previewCanvasRef.current;
    if (!previewReady || !base || !canvas) return;
    const frame = requestAnimationFrame(() => {
      canvas.width = base.canvas.width;
      canvas.height = base.canvas.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(base.canvas, 0, 0);
      if (text.trim() !== "") {
        drawWatermarkText(ctx, canvas.width, canvas.height, {
          text,
          position,
          opacity: opacity / 100,
          fontSize: Math.max(1, shownFontSize * base.scale),
          rotation,
        });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [previewReady, text, position, opacity, shownFontSize, rotation]);

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    try {
      const output = await new ImageWatermarkProcessor().process({
        file,
        text,
        position,
        opacity: opacity / 100,
        fontSize: shownFontSize,
        rotation,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file
    ? replaceExtension(file.name, result ? EXT_BY_MIME[result.mimeType] ?? "png" : "png")
    : "watermarked.png";

  const relativePercent = naturalSize ? Math.round((shownFontSize / Math.min(naturalSize.width, naturalSize.height)) * 100) : null;

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど）"
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
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー(設定に合わせて変わります)</p>
          {previewError && <ErrorMessage message={previewError} />}
          <canvas
            ref={previewCanvasRef}
            aria-label="透かし入りプレビュー"
            data-testid="watermark-preview"
            className="max-h-96 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      )}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <label className="flex flex-col gap-1 text-sm">
            透かしの文字
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={60}
              className="w-full rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">位置</p>
            <div className="flex flex-wrap gap-2">
              {POSITION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPosition(opt.value)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    position === opt.value
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <SliderField
            label="フォントサイズ"
            value={shownFontSize}
            min={WATERMARK_FONT_SIZE_MIN}
            max={sliderMax}
            inputMax={WATERMARK_FONT_SIZE_MAX}
            unit="px"
            onChange={setFontSize}
            hint={
              naturalSize
                ? `元画像(${naturalSize.width}×${naturalSize.height}px)に対する大きさです。画像の短辺の約${relativePercent}%。バーは画像に合わせて最大${sliderMax}pxまで、数値入力なら最大${WATERMARK_FONT_SIZE_MAX}pxまで指定できます。`
                : undefined
            }
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <SliderField label="不透明度" value={opacity} min={5} max={100} unit="%" onChange={setOpacity} />
            <SliderField label="回転角度" value={rotation} min={-90} max={90} unit="°" onChange={setRotation} />
          </div>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || !text.trim()}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          透かしを追加する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="処理が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.width} × {result.height}px ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
