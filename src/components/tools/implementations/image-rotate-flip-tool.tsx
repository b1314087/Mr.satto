"use client";

import { useEffect, useRef, useState } from "react";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ImageFlipProcessor, ImageRotateProcessor, drawFlipped, drawRotated, rotatedSize } from "@/lib/processors/browser/image";
import { useDownscaledImage, useObjectUrl } from "@/components/tools/implementations/shared/image-live-preview";
import type { ImageProcessorOutput } from "@/lib/processors/types";
import { downloadBlob, formatBytes, replaceExtension } from "@/lib/utils/format";

/**
 * 画像の回転・反転の共通画面（画像回転ページ・画像反転ページで共用）。
 * ページごとに、操作の初期モード（initialMode）だけが違う。処理はすべてブラウザの中で行い、画像は送信しない。
 * プレビューと書き出しは、同じ描画関数（drawRotated / drawFlipped）を使う。
 */

export type TransformMode = "rotate" | "flip";
type Degrees = 90 | 180 | 270;
type Direction = "horizontal" | "vertical";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** プレビュー用に縮小する最長辺(px) */
const PREVIEW_MAX_SIDE = 640;

const MODE_LABEL: Record<TransformMode, string> = { rotate: "回転", flip: "反転" };

function activeClass(active: boolean): string {
  return `rounded-lg px-3 py-1.5 text-sm font-medium ${
    active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
  }`;
}

export function ImageRotateFlipTool({ initialMode = "rotate" }: { initialMode?: TransformMode }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<TransformMode>(initialMode);
  const [degrees, setDegrees] = useState<Degrees>(90);
  const [direction, setDirection] = useState<Direction>("horizontal");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; output: ImageProcessorOutput } | null>(null);

  // 結果は「どのファイル・どの操作の結果か」を一緒に持つ。いまの設定と違う古い結果は、表示もダウンロードもしない
  const settingKey = file ? [file.name, file.size, file.lastModified, mode, mode === "rotate" ? degrees : direction].join("|") : "";
  const shownResult = result && result.key === settingKey ? result.output : null;

  useEffect(() => {
    const output = result?.output;
    return () => {
      if (output) URL.revokeObjectURL(output.url);
    };
  }, [result]);

  // --- ライブプレビュー: 元画像と処理後を並べる(描画は書き出しと同じ関数) ---
  const originalUrl = useObjectUrl(file);
  const { canvas: scaled, error: previewError } = useDownscaledImage(file, PREVIEW_MAX_SIDE);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = previewCanvasRef.current;
    if (!scaled || !target) return;
    const size = mode === "rotate" ? rotatedSize(scaled.width, scaled.height, degrees) : { width: scaled.width, height: scaled.height };
    target.width = size.width;
    target.height = size.height;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, target.width, target.height);
    if (mode === "rotate") drawRotated(ctx, scaled, scaled.width, scaled.height, degrees);
    else drawFlipped(ctx, scaled, scaled.width, scaled.height, direction);
  }, [scaled, mode, degrees, direction]);

  function handleFile(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  function clearOutcome() {
    setError(null);
    setStatus("idle");
  }

  function chooseMode(next: TransformMode) {
    setMode(next);
    clearOutcome();
  }

  async function handleRun() {
    if (!file) return;
    const key = settingKey;
    setStatus("processing");
    setError(null);
    try {
      const output =
        mode === "rotate"
          ? await new ImageRotateProcessor().process({ file, degrees })
          : await new ImageFlipProcessor().process({ file, direction });
      setResult({ key, output });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const modeLabel = MODE_LABEL[mode];
  const detail = mode === "rotate" ? `時計回りに${degrees}°回転` : direction === "horizontal" ? "左右反転" : "上下反転";
  const downloadName = file ? replaceExtension(file.name, shownResult ? EXT_BY_MIME[shownResult.mimeType] ?? "png" : "png") : "output.png";

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file ? (
          <div data-testid="tool-preview" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（{detail}）</p>
            {previewError && <ErrorMessage message={previewError} />}
            <div className="grid gap-3 sm:grid-cols-2">
              <figure className="flex min-w-0 flex-col gap-1">
                <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">元の画像 ・ {formatBytes(file.size)}</figcaption>
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
                <figcaption className="text-xs text-neutral-500 dark:text-neutral-400">{modeLabel}後</figcaption>
                <canvas
                  ref={previewCanvasRef}
                  aria-label={`${modeLabel}後のプレビュー`}
                  data-testid="transform-preview-canvas"
                  className="max-h-72 w-full rounded-lg border border-neutral-200 bg-neutral-100 object-contain dark:border-neutral-700 dark:bg-neutral-900"
                />
              </figure>
            </div>
          </div>
        ) : null
      }
    >
      <div role="group" aria-label="操作の種類" className="flex flex-wrap gap-2">
        {(["rotate", "flip"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            data-testid={`transform-mode-${m}`}
            onClick={() => chooseMode(m)}
            className={activeClass(mode === m)}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <FileDropzone
        accept="image/*"
        label="画像をドラッグ&ドロップ"
        hint="またはタップして選択（JPG・PNG・WebPなど。1ファイル50MBまで）"
        onFilesSelected={handleFile}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && mode === "rotate" && (
        <div role="group" aria-label="回転の角度（時計回り）" className="flex flex-wrap gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          {([90, 180, 270] as const).map((deg) => (
            <button
              key={deg}
              type="button"
              aria-pressed={degrees === deg}
              data-testid={`rotate-${deg}`}
              onClick={() => {
                setDegrees(deg);
                clearOutcome();
              }}
              className={activeClass(degrees === deg)}
            >
              {deg}°
            </button>
          ))}
        </div>
      )}

      {file && mode === "flip" && (
        <div role="group" aria-label="反転の向き" className="flex flex-wrap gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          {(
            [
              ["horizontal", "左右反転"],
              ["vertical", "上下反転"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={direction === value}
              data-testid={`flip-${value}`}
              onClick={() => {
                setDirection(value);
                clearOutcome();
              }}
              className={activeClass(direction === value)}
            >
              {label}
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
          {modeLabel}する
        </button>
      )}

      <ProcessingStatus state={status} successLabel={`${modeLabel}が完了しました`} />
      {error && <ErrorMessage message={error} />}

      {shownResult && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shownResult.url} alt="処理結果のプレビュー" className="max-h-64 rounded-lg border border-neutral-200 object-contain dark:border-neutral-700" />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {detail} ・ {shownResult.width} × {shownResult.height}px ・ {formatBytes(shownResult.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(shownResult.blob, downloadName)} />
        </div>
      )}
    </PreviewSplitLayout>
  );
}
