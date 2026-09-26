"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoFrameRateProcessor, type VideoFrameRateOutput } from "@/lib/processors/browser/video-frame-rate";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_SIZE_LIMITS,
  getAvailableFrameRates,
  inspectVideoFile,
  type OutputContainer,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 動画フレームレート変更（Phase 10 / 動画ツール 4）。
 *
 * 元動画の実測fpsより高い値への変更（フレーム複製によるアップサンプリング）は
 * 提供しない。ファイル選択時にmediabunnyで実測fps（フレーム間隔から算出）を
 * 取得し、選択できる候補を絞り込む。
 */
export function VideoFrameRateTool() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceFps, setSourceFps] = useState<number | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoFrameRateOutput | null>(null);

  useRevokeObjectUrlOnChange(result?.url);

  async function handleSelect(files: File[]) {
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setTarget(null);
    setSourceFps(null);
    setDetecting(true);
    try {
      const info = await inspectVideoFile(selected);
      info.input.dispose();
      setSourceFps(info.bestGuessFrameRate);
    } catch (e) {
      setError(e instanceof Error ? e.message : "動画の読み込みに失敗しました");
    } finally {
      setDetecting(false);
    }
  }

  async function handleRun() {
    if (!file || target === null) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);

    try {
      const output = await new VideoFrameRateProcessor().process({
        file,
        targetFps: target,
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
    downloadBlob(result.blob, `${stripExtension(file.name)}-fps.${ext}`);
  }

  const availableFps = sourceFps !== null ? getAvailableFrameRates(sourceFps) : [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画のフレームレート（fps）を下げます。この動画はブラウザ上で処理され、Mr.Sattoのサーバーへ
          アップロードされることはありません。
        </p>
        <p>
          元の動画より高いフレームレートへの変更（フレームを複製して増やす処理）は対応していません。
          自然な変換ができる、フレームレートを下げる方向のみに対応しています。
        </p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_SIZE_LIMITS.frameRate}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.frameRate}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {detecting && <p className="text-xs text-neutral-500 dark:text-neutral-400">動画情報を読み込み中...</p>}

      {file && sourceFps !== null && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            変更後のフレームレート（元: 約{sourceFps.toFixed(1)}fps）
          </legend>
          {availableFps.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              この動画はすでにフレームレートが低いため、下げられる選択肢がありません。
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableFps.map((fps) => (
                <label
                  key={fps}
                  className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    target === fps
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="video-fps-target"
                    value={fps}
                    checked={target === fps}
                    onChange={() => setTarget(fps)}
                    className="sr-only"
                  />
                  {fps}fps
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
                  name="video-fps-container"
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
          フレームレートを変更する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`処理中... ${Math.round(progress * 100)}%`}
        successLabel="フレームレートの変更が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              サイズ: {formatBytes(result.inputSizeBytes)} → {formatBytes(result.sizeBytes)}
            </span>
            <span>
              フレームレート: 約{result.sourceFps.toFixed(1)}fps → {target}fps
            </span>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </div>
      )}
    </div>
  );
}
