"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { VideoAudioLossNotice } from "@/components/tools/implementations/shared/video-audio-loss-notice";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { VideoFrameRateProcessor, type VideoFrameRateOutput } from "@/lib/processors/browser/video-frame-rate";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_DROPZONE_MAX_MB,
  VideoAudioWouldBeLostError,
  VideoCanceledByUserError,
  getAvailableFrameRates,
  inspectVideoFile,
  type OutputContainer,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { VideoOutputPlayer, VideoPreviewPanel } from "@/components/tools/implementations/shared/video-preview-panel";
import { estimateFrameRateBytes, formatDuration } from "@/lib/video/estimate";
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
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);
  // 実行ごとの番号。動画を消した・選び直したあとに、前の処理の結果が遅れて届いても表示しないために使う
  const runIdRef = useRef(0);
  // 音声を書き出せないときの案内（音声なしで書き出すかを選んでもらう）
  const [audioLoss, setAudioLoss] = useState<string | null>(null);

  useRevokeObjectUrlOnChange(result?.url);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);

  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  async function handleSelect(files: File[]) {
    // 前の動画の処理が残っていれば止め、その結果を新しい動画に表示しない
    const selectId = ++runIdRef.current;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setAudioLoss(null);
    const selected = files[0];
    setFile(selected);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setTarget(null);
    setSourceFps(null);
    setWasCanceled(false);
    setDetecting(true);
    try {
      const info = await inspectVideoFile(selected);
      info.input.dispose();
      // 調べている間に動画を消した・選び直した場合は、古い結果を使わない
      if (runIdRef.current !== selectId) return;
      setSourceFps(info.bestGuessFrameRate);
    } catch (e) {
      if (runIdRef.current !== selectId) return;
      setError(e instanceof Error ? e.message : "動画の読み込みに失敗しました");
    } finally {
      if (runIdRef.current === selectId) setDetecting(false);
    }
  }

  async function handleRun(options: { dropAudio?: boolean } = {}) {
    if (!file || target === null) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    setAudioLoss(null);

    try {
      const output = await new VideoFrameRateProcessor().process({
        file,
        targetFps: target,
        outputContainer: container,
        onProgress: setProgress,
        cancelSignal: controller.signal,
        dropAudio: options.dropAudio,
      });
      if (runIdRef.current !== runId) return;
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoAudioWouldBeLostError) {
        setAudioLoss(e.message);
        setStatus("idle");
      } else if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      if (runIdRef.current === runId) {
        setCanceling(false);
        cancelControllerRef.current = null;
      }
    }
  }

  // 選んだ動画を消したときは、前の動画の結果・進み具合・エラー・案内をすべて消し、処理中なら止める
  function handleRemove() {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(null);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    setAudioLoss(null);
    setDetecting(false);
  }

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  function handleDownload() {
    if (!file || !result) return;
    const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === result.outputContainer)?.ext ?? "mp4";
    downloadBlob(result.blob, `${stripExtension(file.name)}-fps.${ext}`);
  }

  const availableFps = sourceFps !== null ? getAvailableFrameRates(sourceFps) : [];

  return (
    <div className="flex flex-col gap-6">

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_DROPZONE_MAX_MB}
        label="動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP4 / MOV / WebM）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={handleRemove} />}
      {file && <VideoSizeWarning sizeBytes={file.size} />}

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
        <VideoPreviewPanel
          file={file}
          previewUrl={previewUrl}
          meta={meta}
          onLoadedMetadata={handleLoadedMetadata}
          fps={sourceFps}
          outputTitle="変更後の予定"
          outputRows={[
            { label: "形式", value: container.toUpperCase() },
            {
              label: "解像度",
              value: meta && meta.width > 0 ? `${meta.width}×${meta.height}（変更なし）` : "元の動画と同じ",
            },
            ...(sourceFps !== null
              ? [
                  {
                    label: "フレームレート",
                    value:
                      target === null
                        ? `約${sourceFps.toFixed(1)}fps（上で変更後のfpsを選んでください）`
                        : `約${sourceFps.toFixed(1)}fps → ${target}fps`,
                  },
                ]
              : []),
            ...(meta && meta.durationSec > 0 ? [{ label: "長さ", value: formatDuration(meta.durationSec) }] : []),
            ...(sourceFps !== null && target !== null
              ? [
                  {
                    label: "サイズの目安",
                    value: `約 ${formatBytes(estimateFrameRateBytes(file.size, sourceFps, target))}`,
                  },
                ]
              : []),
          ]}
          outputNote="サイズはフレーム数からの目安です。実際のサイズは変更後に表示されます。"
        />
      )}

      {file && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => handleRun()}
            disabled={status === "processing" || target === null} aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            フレームレートを変更する
          </button>
        </div>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`処理中... ${Math.round(progress * 100)}%`}
        successLabel="フレームレートの変更が完了しました"
        onCancel={handleCancel}
        canceling={canceling}
      />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}
      {audioLoss && (
        <VideoAudioLossNotice message={audioLoss} onProceed={() => handleRun({ dropAudio: true })} onDismiss={() => setAudioLoss(null)} />
      )}

      {result && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
