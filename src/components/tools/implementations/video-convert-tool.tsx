"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoConvertProcessor, type VideoConvertOutput } from "@/lib/processors/browser/video-convert";
import {
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_SIZE_LIMITS,
  type OutputContainer,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 動画形式変換（Phase 10 / 動画ツール 1）。
 *
 * 動画ファイルは一切サーバーへ送信せず、ブラウザ内（WebCodecs + mediabunny）で
 * 完結する。対応入力: MP4 / MOV / WebM。対応出力: MP4 / WebM
 * （実際に安定して生成・再生確認できた組み合わせに限定。開発指示書 17-18章）。
 */
export function VideoConvertTool() {
  const [file, setFile] = useState<File | null>(null);
  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoConvertOutput | null>(null);

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
      const output = await new VideoConvertProcessor().process({
        file,
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
    downloadBlob(result.blob, `${stripExtension(file.name)}.${ext}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画ファイル（MP4 / MOV / WebM）を、MP4またはWebM形式に変換します。この動画はブラウザ上で処理され、
          動画ファイルをMr.Sattoのサーバーへアップロードすることはありません。
        </p>
        <p>
          お使いのブラウザが対応していないコーデックの動画は変換できない場合があります。すべての通信ログが
          一切存在しないことを保証するものではありませんが、動画ファイルの内容がMr.Satto側に送信・保存されることはありません。
        </p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_SIZE_LIMITS.convert}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.convert}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">変換後の形式</legend>
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
                  name="video-convert-container"
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
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          変換する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`変換中... ${Math.round(progress * 100)}%`}
        successLabel="変換が完了しました"
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
