"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { VideoSizeWarning } from "@/components/tools/implementations/shared/video-size-warning";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  VideoThumbnailProcessor,
  type ThumbnailImageFormat,
  type VideoThumbnailOutput,
} from "@/lib/processors/browser/video-thumbnail";
import {
  VIDEO_INPUT_ACCEPT,
  VIDEO_DROPZONE_MAX_MB,
  VideoCanceledByUserError,
  thumbnailCanvasOptionsFor,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const FORMAT_OPTIONS: { value: ThumbnailImageFormat; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * 動画サムネイル・静止画抽出（Phase 10 / 動画ツール 6）。
 *
 * 6機能の中で最も軽量な実装：動画全体をデコード・再エンコードせず、
 * 指定した1時点のフレームだけを取り出す。
 *
 * スライダーの操作そのものでは毎回デコードを行わず（巨大動画を無駄に
 * 何度もdecodeしないため。開発指示書 26章）、「この時点を抽出」ボタンを
 * 押したタイミングでのみ実際のフレーム取得を行う。
 */
export function VideoThumbnailTool() {
  const [file, setFile] = useState<File | null>(null);
  const [timestamp, setTimestamp] = useState(0);
  const [format, setFormat] = useState<ThumbnailImageFormat>("png");
  const [jpegQuality, setJpegQuality] = useState(0.9);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoThumbnailOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);

  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 出力画像の解像度（長辺が上限を超える場合は縮小される。抽出処理と同じ規則）
  const outputSize = (() => {
    if (!meta || meta.width <= 0) return { width: 0, height: 0 };
    const opt = thumbnailCanvasOptionsFor(meta.width, meta.height);
    if (opt.width !== undefined) {
      return { width: opt.width, height: Math.round((meta.height * opt.width) / meta.width) };
    }
    if (opt.height !== undefined) {
      return { width: Math.round((meta.width * opt.height) / meta.height), height: opt.height };
    }
    return { width: meta.width, height: meta.height };
  })();
  const outputWidth = outputSize.width;
  const outputHeight = outputSize.height;

  // スライダーを動かすと、その時点のフレームを<video>に表示する（抽出する時点と一致）
  function seekTo(t: number) {
    setTimestamp(t);
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = t;
    }
  }

  // 動画側の操作（再生・シークバー）でも抽出する時点を同期する
  function syncTimestampFromVideo(e: React.SyntheticEvent<HTMLVideoElement>) {
    setTimestamp(e.currentTarget.currentTime);
  }
  useRevokeObjectUrlOnChange(result?.url);

  // タブ遷移やアンマウント時にも、実行中の処理を実際に中断する。
  useEffect(() => {
    return () => {
      cancelControllerRef.current?.abort();
    };
  }, []);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setTimestamp(0);
    setWasCanceled(false);
  }

  async function handleExtract() {
    if (!file) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    setStatus("processing");
    setError(null);
    setResult(null);
    setWasCanceled(false);
    setCanceling(false);

    try {
      const output = await new VideoThumbnailProcessor().process({
        file,
        timestampSec: timestamp,
        format,
        jpegQuality,
        cancelSignal: controller.signal,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      if (e instanceof VideoCanceledByUserError) {
        setWasCanceled(true);
        setStatus("idle");
      } else {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
    } finally {
      setCanceling(false);
      cancelControllerRef.current = null;
    }
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画の指定した時点のフレームを画像として書き出します。この動画はブラウザ上で処理され、Mr.Sattoの
          サーバーへアップロードされることはありません。
        </p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_DROPZONE_MAX_MB}
        label="動画ファイルをドラッグ&ドロップ"
        hint="またはタップして選択（MP4 / MOV / WebM。サイズの上限はありません）"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}
      {file && <VideoSizeWarning sizeBytes={file.size} />}

      {file && previewUrl && (
        <section
          data-testid="tool-preview"
          aria-label="抽出するフレームのプレビュー"
          className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            この時点のフレーム（スライダーを動かすと切り替わります）
          </p>
          <video
            ref={videoRef}
            src={previewUrl}
            onLoadedMetadata={handleLoadedMetadata}
            onSeeked={syncTimestampFromVideo}
            onTimeUpdate={syncTimestampFromVideo}
            controls
            playsInline
            preload="auto"
            className="max-h-64 w-full rounded-lg bg-black"
          />

          {meta && meta.durationSec > 0 && (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                抽出する時点: {formatTime(timestamp)} / {formatTime(meta.durationSec)}
              </label>
              <input
                type="range"
                min={0}
                max={meta.durationSec}
                step={0.1}
                value={timestamp}
                onChange={(e) => seekTo(Number(e.target.value))}
                aria-label="抽出する時点"
                className="w-full"
              />
            </div>
          )}

          {meta && meta.width > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              出力画像: {outputWidth}×{outputHeight}（{format === "png" ? "PNG" : `JPEG・品質${Math.round(jpegQuality * 100)}%`}）
            </p>
          )}
        </section>
      )}

      {file && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">画像形式</legend>
          <div className="flex flex-wrap gap-2">
            {FORMAT_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  format === opt.value
                    ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                }`}
              >
                <input
                  type="radio"
                  name="thumbnail-format"
                  value={opt.value}
                  checked={format === opt.value}
                  onChange={() => setFormat(opt.value)}
                  className="sr-only"
                />
                {opt.label}
              </label>
            ))}
          </div>
          {format === "jpeg" && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-500 dark:text-neutral-400">
                JPEG品質: {Math.round(jpegQuality * 100)}%
              </label>
              <input
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
        </fieldset>
      )}

      {file && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleExtract}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            この時点を抽出する
          </button>
          {status === "processing" && !canceling && (
            <button
              type="button"
              onClick={handleCancel}
              className="w-fit rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-600 transition-colors hover:border-red-400 hover:text-red-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-red-500 dark:hover:text-red-400"
            >
              キャンセル
            </button>
          )}
          {canceling && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">キャンセル処理中...</span>
          )}
        </div>
      )}

      <ProcessingStatus state={status} processingLabel="抽出中..." successLabel="画像の抽出が完了しました" />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          処理をキャンセルしました。設定を確認して、もう一度実行できます。
        </div>
      )}
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element -- ブラウザ内で生成したObject URLのプレビューのため next/image は不要 */}
          <img src={result.url} alt="抽出したサムネイル" className="max-h-64 max-w-full rounded-lg border border-neutral-200 dark:border-neutral-800" />
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              サイズ: {result.width}×{result.height}
            </span>
            <span>ファイルサイズ: {formatBytes(result.sizeBytes)}</span>
            <span>時点: {formatTime(result.timestampSec)}</span>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="画像をダウンロード" />
        </div>
      )}
    </div>
  );
}
