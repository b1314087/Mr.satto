"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  VideoThumbnailProcessor,
  type ThumbnailImageFormat,
  type VideoThumbnailOutput,
} from "@/lib/processors/browser/video-thumbnail";
import { VIDEO_INPUT_ACCEPT, VIDEO_SIZE_LIMITS } from "@/lib/video/shared";
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

  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);
  useRevokeObjectUrlOnChange(result?.url);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setTimestamp(0);
  }

  async function handleExtract() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);

    try {
      const output = await new VideoThumbnailProcessor().process({
        file,
        timestampSec: timestamp,
        format,
        jpegQuality,
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
        maxSizeMB={VIDEO_SIZE_LIMITS.thumbnail}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.thumbnail}MB）`}
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

      {file && meta && meta.durationSec > 0 && (
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
            onChange={(e) => setTimestamp(Number(e.target.value))}
            className="w-full"
          />
        </div>
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
        <button
          type="button"
          onClick={handleExtract}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          この時点を抽出する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="抽出中..." successLabel="画像の抽出が完了しました" />
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
