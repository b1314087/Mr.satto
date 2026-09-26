"use client";

import { useEffect, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoH264Processor, type VideoH264Output } from "@/lib/processors/browser/video-h264";
import { VIDEO_INPUT_ACCEPT, VIDEO_SIZE_LIMITS, checkH264EncodeSupport } from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange } from "@/lib/video/use-video-preview";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

/**
 * H.264コーデック変換（Phase 10 / 動画ツール 5）。
 *
 * 出力は常にMP4 + H.264。実行前に必ず canEncodeVideo("avc") でこの
 * ブラウザが実際にH.264エンコードに対応しているかを確認する
 * （開発指示書 24章：「WebCodecsがあるから全部H.264変換できる」と考えない）。
 * 対応していないブラウザでは、ツール自体を実行不可として明示する。
 */
export function VideoH264Tool() {
  const [supportChecked, setSupportChecked] = useState(false);
  const [supported, setSupported] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VideoH264Output | null>(null);

  useRevokeObjectUrlOnChange(result?.url);

  useEffect(() => {
    let cancelled = false;
    // 汎用的な解像度(1280x720)でこのブラウザのH.264エンコード対応を事前確認する。
    // ファイル選択後、実際の解像度でも再度確認する（Processor内部）。
    checkH264EncodeSupport(1280, 720).then((ok) => {
      if (!cancelled) {
        setSupported(ok);
        setSupportChecked(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      const output = await new VideoH264Processor().process({ file, onProgress: setProgress });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-h264.mp4`);
  }

  if (supportChecked && !supported) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-6 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
        <p>このブラウザではH.264変換を利用できません。</p>
        <p className="text-xs">最新のGoogle ChromeなどWebCodecsのH.264エンコードに対応したブラウザでお試しください。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          動画をH.264（AVC）コーデック・MP4形式に変換します。この動画はブラウザ上で処理され、Mr.Sattoの
          サーバーへアップロードされることはありません。
        </p>
        <p>
          元の動画がすでにH.264の場合は再エンコードせずにそのままMP4化するため、画質の劣化はありません。
          それ以外のコーデックの場合は再エンコードが発生し、多少の画質差が生じる場合があります。
        </p>
      </div>

      <FileDropzone
        accept={VIDEO_INPUT_ACCEPT}
        maxSizeMB={VIDEO_SIZE_LIMITS.h264}
        label="動画ファイルをドラッグ&ドロップ"
        hint={`またはタップして選択（MP4 / MOV / WebM、上限${VIDEO_SIZE_LIMITS.h264}MB）`}
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
          H.264に変換する
        </button>
      )}

      <ProcessingStatus
        state={status}
        processingLabel={`変換中... ${Math.round(progress * 100)}%`}
        successLabel="H.264への変換が完了しました"
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
