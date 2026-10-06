"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { VideoH264Processor, type VideoH264Output } from "@/lib/processors/browser/video-h264";
import {
  VIDEO_INPUT_ACCEPT,
  VIDEO_SIZE_LIMITS,
  VideoCanceledByUserError,
  checkH264EncodeSupport,
} from "@/lib/video/shared";
import { useRevokeObjectUrlOnChange, useVideoPreview } from "@/lib/video/use-video-preview";
import { VideoOutputPlayer, VideoPreviewPanel } from "@/components/tools/implementations/shared/video-preview-panel";
import { formatDuration } from "@/lib/video/estimate";

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
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const cancelControllerRef = useRef<AbortController | null>(null);

  useRevokeObjectUrlOnChange(result?.url);
  const { previewUrl, meta, handleLoadedMetadata } = useVideoPreview(file);

  useEffect(() => {
    let cancelled = false;
    // 汎用的な解像度(1280x720)でこのブラウザのH.264エンコード対応を事前確認する。
    // ファイル選択後、実際の解像度でも再度確認する（Processor内部）。
    // ※この cancelled はこのeffect専用の既存の中断フラグであり、下の
    //   キャンセル機能（cancelControllerRef）とは無関係。混同しないよう
    //   キャンセル機能側は別名の状態・refを使う。
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

  // タブ遷移やアンマウント時にも、実行中の変換処理を実際に中断する。
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
      const output = await new VideoH264Processor().process({
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
        <VideoPreviewPanel
          file={file}
          previewUrl={previewUrl}
          meta={meta}
          onLoadedMetadata={handleLoadedMetadata}
          outputRows={[
            { label: "形式", value: "MP4（H.264）" },
            {
              label: "解像度",
              value: meta && meta.width > 0 ? `${meta.width}×${meta.height}（変更なし）` : "元の動画と同じ",
            },
            {
              label: "長さ",
              value: meta && meta.durationSec > 0 ? formatDuration(meta.durationSec) : "元の動画と同じ",
            },
            { label: "サイズの目安", value: `${formatBytes(file.size)} 前後` },
          ]}
          outputNote="すでにH.264の動画は再エンコードせずに変換します。それ以外はサイズが変わる場合があります。"
        />
      )}

      {file && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleRun}
            disabled={status === "processing"}
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            H.264に変換する
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
        processingLabel={`変換中... ${Math.round(progress * 100)}%`}
        successLabel="H.264への変換が完了しました"
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
          <VideoOutputPlayer url={result.url} />
          <RewardedDownloadGate onDownload={handleDownload} label="ダウンロード" />
        </div>
      )}
    </div>
  );
}
