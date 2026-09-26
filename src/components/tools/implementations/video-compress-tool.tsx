"use client";

import { useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoCompressProcessor, type VideoCompressOutput } from "@/lib/processors/browser/video-compress";
import {
  COMPRESSION_LEVEL_OPTIONS,
  OUTPUT_CONTAINER_OPTIONS,
  VIDEO_INPUT_ACCEPT,
  VIDEO_SIZE_LIMITS,
  type CompressionLevel,
  type OutputContainer,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * 動画圧縮（Phase 10 / 動画ツール 2）。
 *
 * 圧縮レベルは「弱め/標準/強め」の3段階。内部的には映像のエンコード品質
 * （ビットレート相当）を変更し、必ず再エンコードする（forceTranscode）。
 * 入力によってはほとんどサイズが変わらない場合もあるため「必ず○％削減」
 * とは表示しない（開発指示書 51章）。
 */
export function VideoCompressTool() {
  const [file, setFile] = useState<File | null>(null);
  const [level, setLevel] = useState<CompressionLevel>("medium");
  const [container, setContainer] = useState<OutputContainer>("mp4");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoCompressOutput | null>(null);

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
      const output = await new VideoCompressProcessor().process({
        file,
        level,
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
    downloadBlob(result.blob, `${stripExtension(file.name)}-compressed.${ext}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画のファイルサイズを削減します。この動画はブラウザ上で処理され、Mr.Sattoのサーバーへ
          アップロードされることはありません。
        </p>
        <p>
          動画の内容によってはほとんどサイズが変わらない場合もあります。必ず一定の割合で削減されることを
          保証するものではありません。
        </p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_SIZE_LIMITS.compress}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.compress}MB）`}
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-neutral-700 dark:text-neutral-200">圧縮レベル</legend>
            <div className="flex flex-wrap gap-2">
              {COMPRESSION_LEVEL_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                    level === opt.value
                      ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "border-neutral-300 text-neutral-600 hover:border-blue-400 dark:border-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="video-compress-level"
                    value={opt.value}
                    checked={level === opt.value}
                    onChange={() => setLevel(opt.value)}
                    className="sr-only"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {COMPRESSION_LEVEL_OPTIONS.find((o) => o.value === level)?.description}
            </p>
          </fieldset>

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
                    name="video-compress-container"
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
        </>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          圧縮する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`圧縮中... ${Math.round(progress * 100)}%`}
        successLabel="圧縮が完了しました"
      />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>
              サイズ: {formatBytes(result.inputSizeBytes)} → {formatBytes(result.sizeBytes)}（
              {result.sizeBytes < result.inputSizeBytes
                ? `${Math.round((1 - result.sizeBytes / result.inputSizeBytes) * 100)}%削減`
                : result.sizeBytes === result.inputSizeBytes
                  ? "サイズは変わりませんでした"
                  : "元の動画がすでに高効率で圧縮されているため、サイズが増加しました"}
              ）
            </span>
            <span>
              解像度: {result.width}×{result.height}
            </span>
          </div>
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </div>
      )}
    </div>
  );
}
