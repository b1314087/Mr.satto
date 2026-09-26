"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoResizeProcessor, type VideoResizeOutput } from "@/lib/processors/browser/video-resize";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_SIZE_LIMITS,
  getAvailableResolutionPresets,
  type OutputContainer,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 動画解像度変更（Phase 10 / 動画ツール 3）。
 *
 * 元の動画より大きい解像度は選択肢に出さない（アップスケール非対応）。
 * 縦動画・横動画のどちらでも短辺を基準に指定し、アスペクト比を維持する。
 */
export function VideoResizeTool() {
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoResizeOutput | null>(null);

  const { meta, handleLoadedMetadata, previewUrl } = useVideoPreview(file);
  useRevokeObjectUrlOnChange(result?.url);

  const availablePresets = meta ? getAvailableResolutionPresets(meta.width, meta.height) : [];

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setTarget(null);
  }

  async function handleRun() {
    if (!file || target === null) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);

    try {
      const output = await new VideoResizeProcessor().process({
        file,
        shortSideTarget: target,
        outputContainer: container,
        onProgress: setProgress,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === result.outputContainer)?.ext ?? "mp4";
    downloadBlob(result.blob, `${stripExtension(file.name)}-resized.${ext}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画の解像度を変更し、ファイルサイズを削減します。この動画はブラウザ上で処理され、Mr.Sattoの
          サーバーへアップロードされることはありません。
        </p>
        <p>元の動画より大きい解像度への拡大には対応していません。縦動画・横動画ともアスペクト比を維持します。</p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_SIZE_LIMITS.resize}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.resize}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {previewUrl && (
        <video
          src={previewUrl}
          onLoadedMetadata={handleLoadedMetadata}
          controls
          className="max-h-64 w-full rounded-lg bg-black"
        />
      )}

      {file && meta && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            解像度（元: {meta.width}×{meta.height}）
          </legend>
          {availablePresets.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              この動画はすでに解像度が小さいため、縮小できる選択肢がありません。
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availablePresets.map((p) => (
                <label
                  key={p}
                  className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    target === p
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="video-resize-target"
                    value={p}
                    checked={target === p}
                    onChange={() => setTarget(p)}
                    className="sr-only"
                  />
                  {p}p
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      {file && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">出力形式</legend>
          <div className="flex flex-wrap gap-2">
            {OUTPUT_CONTAINER_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  container === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                <input
                  type="radio"
                  name="video-resize-container"
                  value={opt.value}
                  checked={container === opt.value}
                  onChange={() => setContainer(opt.value)}
                  className="sr-only"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || target === null}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          解像度を変更する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`処理中... ${Math.round(progress * 100)}%`}
        successLabel="解像度の変更が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              サイズ: {formatBytes(result.inputSizeBytes)} → {formatBytes(result.sizeBytes)}
            </span>
            <span>
              解像度: {result.inputWidth}×{result.inputHeight} → {result.outputWidth}×{result.outputHeight}
            </span>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </div>
      )}
    </div>
  );
}
