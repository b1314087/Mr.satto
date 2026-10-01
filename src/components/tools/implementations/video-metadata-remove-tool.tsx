"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  VideoMetadataRemoveProcessor,
  type VideoMetadataRemoveOutput,
} from "@/lib/processors/browser/video-metadata-remove";
import { OUTPUT_CONTAINER_OPTIONS, VIDEO_INPUT_ACCEPT, VIDEO_SIZE_LIMITS } from "@/lib/video/shared";
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

  useRevokeObjectUrlOnChange(result?.url);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setProgress(0);

    try {
      const output = await new VideoMetadataRemoveProcessor().process({
        file,
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
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          メタデータを削除する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`処理中... ${Math.round(progress * 100)}%`}
        successLabel="メタデータの削除が完了しました"
      />
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
