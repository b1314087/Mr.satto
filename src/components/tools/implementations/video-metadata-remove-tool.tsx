"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  VideoMetadataRemoveProcessor,
  type VideoMetadataRemoveOutput,
} from "@/lib/processors/browser/video-metadata-remove";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_SIZE_LIMITS,
  VideoCanceledByUserError,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 動画メタデータ削除。
 *
 * 動画ファイルは一切サーバーへ送信せず、ブラウザ内（WebCodecs + mediabunny）で
 * 完結する。撮影日時・GPS位置情報・タイトル・作成者・コメント等の記述系
 * メタデータを除去したファイルを生成する。不要な設定項目は設けず、
 * 「選ぶ→削除する→ダウンロードする」のシンプルな流れのみを提供する。
 */
export function VideoMetadataRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoMetadataRemoveOutput | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);

  useRevokeObjectUrlOnChange(result?.url);

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
    setProgress(0);
    setWasCanceled(false);
  }

  async function handleRun() {
    if (!file) return;
    const controller = new AbortController();
    cancelControllerRef.current = controller;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);
    setWasCanceled(false);
    setCanceling(false);

    try {
      const output = await new VideoMetadataRemoveProcessor().process({
        file,
        onProgress: setProgress,
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
    const ext = OUTPUT_CONTAINER_OPTIONS.find((o) => o.value === result.outputContainer)?.ext ?? "mp4";
    downloadBlob(result.blob, `${stripExtension(file.name)}-metadata-removed.${ext}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画ファイル（MP4 / MOV / WebM）から、撮影日時・位置情報（GPS）・タイトル・作成者・コメントなどの
          メタデータを削除します。この動画はブラウザ上で処理され、動画ファイルをMr.Sattoのサーバーへ
          アップロードすることはありません。
        </p>
        <p>
          動画・音声そのものは可能な限り無劣化（再エンコードなしのコピー）で維持されます。ただし、
          コンテナ形式やメタデータの種類によっては、すべてのメタデータを100%除去できることを
          保証するものではありません。
        </p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_SIZE_LIMITS.metadataRemove}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.metadataRemove}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            メタデータを削除する
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

      <ProcessingStatus
        state={status}
        processingLabel={`処理中... ${Math.round(progress * 100)}%`}
        successLabel="メタデータの削除が完了しました"
      />
      {wasCanceled && (
        <div className="flex items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          処理をキャンセルしました。設定を確認して、もう一度実行できます。
        </div>
      )}
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              サイズ: {formatBytes(result.inputSizeBytes)} → {formatBytes(result.sizeBytes)}
            </span>
            <span>
              解像度: {result.width}×{result.height}
            </span>
            <span>長さ: {result.durationSec.toFixed(1)}秒</span>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </div>
      )}
    </div>
  );
}
