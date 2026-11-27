"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { VideoOutputPlayer, VideoPreviewPanel } from "@/components/tools/implementations/shared/video-preview-panel";
import { VideoSpeedProcessor, type VideoSpeedOutput } from "@/lib/processors/browser/video-speed";
import { OUTPUT_CONTAINER_OPTIONS, VIDEO_DROPZONE_MAX_MB, VIDEO_INPUT_ACCEPT, VideoCanceledByUserError, type OutputContainer } from "@/lib/video/shared";
import {
  DEFAULT_SPEED,
  SPEED_MAX,
  SPEED_MAX_SOURCE_SECONDS,
  SPEED_MIN,
  SPEED_PRESETS,
  isValidSpeed,
  speedDuration,
  speedLabel,
} from "@/lib/video/speed";
import { formatDuration } from "@/lib/video/estimate";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";

/**
 * 動画の再生速度変更（2026-11-27）。
 * 0.25〜4倍の速さに変え、音声は音の高さを保ったまま長さだけを変える（保たないこともできる）。
 * 動画はサーバーへ送らず、ブラウザの中（WebCodecs + mediabunny）で処理する。
 */
export function VideoSpeedTool() {
  const [file, setFile] = useState<File | null>(null);
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  const [speedText, setSpeedText] = useState(String(DEFAULT_SPEED));
  const [keepPitch, setKeepPitch] = useState(true);
  const [muted, setMuted] = useState(false);
  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoSpeedOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);
  // 実行ごとの番号。動画を消した・選び直したあとに、前の処理の結果が遅れて届いても表示しないために使う
  const runIdRef = useRef(0);

  useRevokeObjectUrlOnChange(result?.url);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);

  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  function resetResult() {
    setResult(null);
    if (status === "success") setStatus("idle");
  }

  function chooseSpeed(value: number) {
    setSpeed(value);
    setSpeedText(String(value));
    resetResult();
  }

  function changeSpeedText(text: string) {
    setSpeedText(text);
    const n = Number(text.normalize("NFKC"));
    setSpeed(text.trim() === "" ? NaN : n);
    resetResult();
  }

  function handleSelect(files: File[]) {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
  }

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
  }

  async function handleRun() {
    if (!file || !isValidSpeed(speed)) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);
    try {
      const output = await new VideoSpeedProcessor().process({
        file,
        speed,
        keepPitch,
        muted,
        container,
        onProgress: setProgress,
        cancelSignal: controller.signal,
      });
      if (runIdRef.current !== runId) return;
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      if (e instanceof VideoCanceledByUserError) {
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

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  const outputName = (c: OutputContainer) => {
    const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === c)?.ext ?? "mp4";
    const tag = String(Math.round(speed * 100) / 100).replace(".", "_");
    return `${stripExtension(file?.name ?? "video")}-x${tag}.${ext}`;
  };

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, outputName(result.outputContainer));
  }

  const speedOk = isValidSpeed(speed);
  const speedProblem = speedText.trim() === "" || !Number.isFinite(speed)
    ? "速さを数字で入れてください。"
    : Math.abs(speed - 1) <= 1e-6
      ? "1倍のままでは変わりません。ほかの速さを選んでください。"
      : !speedOk
        ? `速さは${SPEED_MIN}〜${SPEED_MAX}倍の範囲で入れてください。`
        : null;
  const duration = meta?.durationSec && Number.isFinite(meta.durationSec) ? meta.durationSec : null;
  const tooLong = duration !== null && duration > SPEED_MAX_SOURCE_SECONDS + 0.5;
  const busy = status === "processing";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        compact={!!file}
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_DROPZONE_MAX_MB}
        label="動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP4 / MOV / WebM）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={handleRemove} />}
      {file && <VideoSizeWarning sizeBytes={file.size} />}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4 dark:border-blue-900 dark:bg-blue-950/20" data-testid="video-speed-settings">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium text-ms-text">再生速度</legend>
            <div className="flex flex-wrap gap-2">
              {SPEED_PRESETS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => chooseSpeed(s)}
                  aria-pressed={speed === s}
                  className={`rounded-md px-3 py-1.5 text-sm ${speed === s ? "bg-blue-600 text-white" : "bg-white text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-50 dark:bg-neutral-900 dark:text-neutral-200 dark:ring-neutral-700"}`}
                  data-testid={`video-speed-preset-${s}`}
                >
                  {s}倍
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="video-speed-value" className="text-xs text-ms-muted">
                数字で指定
              </label>
              <input
                id="video-speed-value"
                type="text"
                inputMode="decimal"
                value={speedText}
                onChange={(e) => changeSpeedText(e.target.value)}
                aria-invalid={speedProblem ? true : undefined}
                className={`w-20 rounded-md border px-2 py-1 text-sm dark:bg-neutral-900 dark:text-neutral-100 ${speedProblem ? "border-red-400" : "border-neutral-300 dark:border-neutral-700"}`}
                data-testid="video-speed-value"
              />
              <span className="text-xs text-ms-muted">倍（{SPEED_MIN}〜{SPEED_MAX}）</span>
            </div>
            {speedProblem && (
              <p className="text-xs text-red-600 dark:text-red-400" data-testid="video-speed-error">
                {speedProblem}
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium text-ms-text">音声</legend>
            <label className="flex items-start gap-2 text-sm text-ms-text">
              <input type="checkbox" checked={keepPitch} disabled={muted} onChange={(e) => { setKeepPitch(e.target.checked); resetResult(); }} className="mt-1" data-testid="video-speed-keep-pitch" />
              <span>
                音の高さを保つ
                <span className="block text-xs text-ms-muted">オフにすると、速くしたときは声が高く、ゆっくりにしたときは低くなります。</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-ms-text">
              <input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.target.checked); resetResult(); }} data-testid="video-speed-muted" />
              音声を消す
            </label>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium text-ms-text">出力形式</legend>
            <div className="ms-seg-radio">
              {OUTPUT_CONTAINER_OPTIONS.map((o) => (
                <label key={o.value}>
                  <input type="radio" name="video-speed-container" value={o.value} checked={container === o.value} onChange={() => { setContainer(o.value); resetResult(); }} className="sr-only" />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      {file && (
        <VideoPreviewPanel
          file={file}
          previewUrl={previewUrl}
          meta={meta}
          onLoadedMetadata={handleLoadedMetadata}
          outputTitle="変更後の予定"
          outputRows={[
            { label: "速さ", value: speedOk ? speedLabel(speed) : "（正しい速さを入れてください）" },
            { label: "長さ", value: duration !== null && speedOk ? `${formatDuration(duration)} → ${formatDuration(speedDuration(duration, speed))}` : "—" },
            { label: "音声", value: muted ? "消す" : keepPitch ? "残す（音の高さはそのまま）" : "残す（速さに合わせて高さも変わる）" },
            { label: "形式", value: container.toUpperCase() },
          ]}
          outputNote="映像は、速さに合わせて作り直します。元の動画が長いほど、時間がかかります。"
        />
      )}
      {file && tooLong && (
        <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="video-speed-too-long">
          変えられる動画の長さは{SPEED_MAX_SOURCE_SECONDS / 60}分までです。長い動画は、動画カット・結合で短くしてからお試しください。
        </p>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={busy || !speedOk || tooLong}
            aria-busy={busy || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            速さを変える
          </button>
        </RunBar>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`変換中... ${Math.round(progress * 100)}%`}
        successLabel="速さの変更が完了しました"
        onCancel={handleCancel}
        canceling={canceling}
      />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}

      {result && file && (
        <ResultPopup>
          <VideoOutputPlayer url={result.url} />
          <div className="flex w-full flex-col gap-1 text-sm" data-testid="video-speed-result">
            <p className="break-all text-xs text-neutral-500 dark:text-neutral-400">保存するファイル名: {outputName(result.outputContainer)}</p>
            <p>
              長さ：{formatDuration(result.inputDurationSec)} → <span className="font-medium">{formatDuration(result.durationSec)}</span>
            </p>
            <p>
              {result.width}×{result.height}・{result.fps}fps・音声{result.hasAudio ? "あり" : "なし"}・{formatBytes(result.sizeBytes)}
            </p>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
