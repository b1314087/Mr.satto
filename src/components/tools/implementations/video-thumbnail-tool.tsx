"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { VideoThumbnailProcessor, type ThumbnailImageFormat, type VideoThumbnailOutput } from "@/lib/processors/browser/video-thumbnail";
import { formatTimeInput } from "@/lib/video/edit-settings";
import { VIDEO_INPUT_ACCEPT, VIDEO_DROPZONE_MAX_MB, VideoCanceledByUserError, thumbnailCanvasOptionsFor } from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { RunBar } from "@/components/ui/run-bar";

const FORMAT_OPTIONS: { value: ThumbnailImageFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
];

/**
 * 動画サムネイル抽出（総合改修 13）。
 *
 * 操作は1つだけ：動画を再生して、好きな位置で一時停止し、その位置のフレームを画像にする。
 * （以前あった「指定した時刻」「一定の間隔」「均等に」のまとめて取り出す方法は、操作を分かりやすくするため削除した）
 *
 * - 一時停止した位置（または、シークバーで動かした位置）を「抽出する位置」とし、そのフレームを右（スマホでは上）に表示する。
 * - 再生中に抽出ボタンを押したときは、まず一時停止して、止まった位置を抽出する。
 * - 抽出は、動画全体をデコード・再エンコードせず、その1時点のフレームだけを取り出す（従来と同じ処理）。
 */
export function VideoThumbnailTool() {
  const [file, setFile] = useState<File | null>(null);
  const [timestamp, setTimestamp] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [format, setFormat] = useState<ThumbnailImageFormat>("png");
  const [jpegQuality, setJpegQuality] = useState(0.9);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoThumbnailOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);
  // 実行ごとの番号。動画を消した・選び直したあとに、前の処理の結果が遅れて届いても表示しないために使う
  const runIdRef = useRef(0);

  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // 出力画像の解像度（長辺が上限を超える場合は縮小される。抽出処理と同じ規則）
  const outputSize = (() => {
    if (!meta || meta.width <= 0) return { width: 0, height: 0 };
    const opt = thumbnailCanvasOptionsFor(meta.width, meta.height);
    if (opt.width !== undefined) return { width: opt.width, height: Math.round((meta.height * opt.width) / meta.width) };
    if (opt.height !== undefined) return { width: Math.round((meta.width * opt.height) / meta.height), height: opt.height };
    return { width: meta.width, height: meta.height };
  })();

  useRevokeObjectUrlOnChange(result?.url);

  // タブ遷移やアンマウント時にも、実行中の処理を実際に中断する。
  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  /** 止まっている（一時停止した・シークした）位置のフレームを、プレビュー用のキャンバスに写す */
  function drawPausedFrame() {
    const v = videoRef.current;
    const c = frameCanvasRef.current;
    if (!v || !c || v.videoWidth === 0) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
  }

  function handlePause(e: React.SyntheticEvent<HTMLVideoElement>) {
    setPlaying(false);
    setTimestamp(e.currentTarget.currentTime);
    drawPausedFrame();
  }

  function handleSeeked(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (!e.currentTarget.paused) return;
    setTimestamp(e.currentTarget.currentTime);
    drawPausedFrame();
  }

  function handleSelect(files: File[]) {
    // 前の動画の処理が残っていれば止め、その結果を新しい動画に表示しない
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setTimestamp(0);
    setPlaying(false);
    setWasCanceled(false);
  }

  async function handleExtract() {
    if (!file) return;
    // 再生中なら、まず一時停止して、止まった位置を抽出する
    const v = videoRef.current;
    let at = timestamp;
    if (v && !v.paused) {
      v.pause();
      at = v.currentTime;
      setTimestamp(at);
    }
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    const runId = ++runIdRef.current;
    setStatus("processing");
    setError(null);
    setResult(null);
    setWasCanceled(false);
    setCanceling(false);

    try {
      const output = await new VideoThumbnailProcessor().process({
        file,
        timestampSec: at,
        format,
        jpegQuality,
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

  // 選んだ動画を消したときは、前の動画の結果・進み具合・エラー・案内をすべて消し、処理中なら止める
  function handleRemove() {
    runIdRef.current++;
    cancelControllerRef.current?.abort();
    cancelControllerRef.current = null;
    setFile(null);
    setResult(null);
    setStatus("idle");
    setError(null);
    setWasCanceled(false);
    setCanceling(false);
    setPlaying(false);
  }

  function handleCancel() {
    if (!cancelControllerRef.current) return;
    setCanceling(true);
    cancelControllerRef.current.abort();
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-thumbnail.${result.format === "png" ? "png" : "jpg"}`);
  }

  return (
    <PreviewSplitLayout
      previewWidth="lg"
      preview={
        file && previewUrl ? (
          <section data-testid="tool-preview" aria-label="抽出するフレームのプレビュー" className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              抽出するフレーム{" "}
              <span className="font-normal text-neutral-500 dark:text-neutral-400" data-testid="thumb-paused-at">
                （{formatTimeInput(timestamp)}{meta && meta.durationSec > 0 ? ` / ${formatTimeInput(meta.durationSec)}` : ""}）
              </span>
            </p>
            <canvas
              ref={frameCanvasRef}
              aria-label="一時停止した位置のフレーム"
              data-testid="thumb-paused-frame"
              className="mx-auto block h-auto w-auto max-h-[min(50vh,26rem)] max-w-full rounded-lg bg-black"
            />
            {playing && (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="thumb-playing-note">
                再生中です。抽出したい位置で一時停止してください（このまま抽出ボタンを押すと、押した位置で止めて抽出します）。
              </p>
            )}
            {meta && meta.width > 0 && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                出力画像: {outputSize.width}×{outputSize.height}（{format === "png" ? "PNG" : `JPEG・品質${Math.round(jpegQuality * 100)}%`}）
              </p>
            )}
          </section>
        ) : null
      }
    >
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

      {file && previewUrl && (
        <SettingsStack>
          <SettingsSection n={1} title="再生して、抽出したい位置で一時停止する">
            <video
              ref={videoRef}
              src={previewUrl}
              onLoadedMetadata={handleLoadedMetadata}
              onLoadedData={drawPausedFrame}
              onPlay={() => setPlaying(true)}
              onPause={handlePause}
              onSeeked={handleSeeked}
              controls
              playsInline
              preload="auto"
              data-testid="thumb-video"
              className="block mx-auto h-auto w-auto max-w-full max-h-[min(50vh,26rem)] rounded-lg bg-black"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              一時停止した位置のフレームが「抽出するフレーム」に表示されます。止めたあとにシークバーで動かして選び直すこともできます。
            </p>
          </SettingsSection>

          <SettingsSection n={2} title="画像形式" summary={format === "png" ? "PNG" : `JPEG・品質${Math.round(jpegQuality * 100)}%`}>
            <div className="ms-seg" role="radiogroup" aria-label="画像形式">
              {FORMAT_OPTIONS.map((opt) => (
                <button key={opt.value} type="button" role="radio" aria-checked={format === opt.value} onClick={() => setFormat(opt.value)}>
                  {opt.label}
                </button>
              ))}
            </div>
            {format === "jpeg" && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-neutral-500 dark:text-neutral-400" htmlFor="thumb-jpeg-quality">
                  JPEG品質: {Math.round(jpegQuality * 100)}%
                </label>
                <input
                  id="thumb-jpeg-quality"
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.05}
                  value={jpegQuality}
                  onChange={(e) => setJpegQuality(Number(e.target.value))}
                  className="flex-1"
                />
              </div>
            )}
          </SettingsSection>
        </SettingsStack>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleExtract}
            disabled={status === "processing"}
            aria-busy={status === "processing" || undefined}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            一時停止した位置を抽出する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} processingLabel="抽出中..." successLabel="画像の抽出が完了しました" onCancel={handleCancel} canceling={canceling} />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">処理をキャンセルしました。</div>
      )}
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          {/* eslint-disable-next-line @next/next/no-img-element -- ブラウザ内で生成したObject URLのプレビューのため next/image は不要 */}
          <img src={result.url} alt="抽出したサムネイル" className="max-h-64 max-w-full rounded-lg border border-neutral-200 dark:border-neutral-800" />
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="thumb-result-time">
            {formatTimeInput(result.timestampSec)} のフレーム
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="画像をダウンロード" />
        </ResultPopup>
      )}
    </PreviewSplitLayout>
  );
}
