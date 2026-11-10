"use client";

import type { ReactNode, RefObject, SyntheticEvent } from "react";
import { formatBytes } from "@/lib/utils/format";
import { formatDuration } from "@/lib/video/estimate";
import type { VideoPreviewMeta } from "@/lib/video/use-video-preview";
import { PreviewFullscreenFrame } from "@/components/common/preview-fullscreen";

export interface VideoOutputRow {
  label: string;
  value: string;
}

/**
 * 動画ツール共通のプレビュー領域。
 * 入力動画を <video>（先頭フレーム表示・再生可能）で見せ、元の情報と、
 * 設定に応じた「出力の予定」（解像度・fps・おおよそのサイズなど）を表示する。
 * 動画の処理そのものはここでは行わない。
 */
export function VideoPreviewPanel({
  file,
  previewUrl,
  meta,
  onLoadedMetadata,
  fps,
  hasAudio,
  outputTitle = "変換後の予定",
  outputRows,
  outputNote,
  className = "",
  videoRef,
  children,
}: {
  file: File;
  previewUrl: string | null;
  meta: VideoPreviewMeta | null;
  onLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement>) => void;
  /** 元動画のフレームレート（分かっている場合） */
  fps?: number | null;
  /** 元動画の音声トラックの有無（分かっている場合） */
  hasAudio?: boolean | null;
  outputTitle?: string;
  outputRows?: VideoOutputRow[];
  outputNote?: string;
  className?: string;
  /** 元の動画の <video>（再生位置を読みたいとき。動画編集 工程3の切り取り） */
  videoRef?: RefObject<HTMLVideoElement | null>;
  /** 動画のすぐ下に置くもの（切り取りの操作など） */
  children?: ReactNode;
}) {
  const sourceParts: string[] = [];
  if (meta && meta.width > 0) sourceParts.push(`${meta.width}×${meta.height}`);
  if (meta && meta.durationSec > 0) sourceParts.push(formatDuration(meta.durationSec));
  if (fps) sourceParts.push(`${Math.round(fps * 100) / 100}fps`);
  if (hasAudio === true) sourceParts.push("音声あり");
  if (hasAudio === false) sourceParts.push("音声なし");
  sourceParts.push(formatBytes(file.size));

  return (
    <PreviewFullscreenFrame>
    <section
      data-testid="tool-preview"
      aria-label="動画のプレビュー"
      className={`flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800 ${className}`}
    >
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">元の動画</p>
      {previewUrl && (
        <video
          ref={videoRef}
          src={previewUrl}
          onLoadedMetadata={onLoadedMetadata}
          controls
          playsInline
          preload="metadata"
          className="block mx-auto h-auto w-auto max-w-full max-h-[min(60vh,30rem)] rounded-lg bg-black"
        />
      )}
      {children}
      <p className="break-all text-xs text-neutral-500 dark:text-neutral-400">
        {file.name}（{sourceParts.join(" ・ ")}）
      </p>

      {outputRows && outputRows.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900">
          <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{outputTitle}</p>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {outputRows.map((row) => (
              <div key={row.label} className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-neutral-500 dark:text-neutral-400">{row.label}</dt>
                <dd className="min-w-0 break-words font-medium text-neutral-800 dark:text-neutral-100">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {outputNote && <p className="text-[11px] text-neutral-400">{outputNote}</p>}
        </div>
      )}
    </section>
    </PreviewFullscreenFrame>
  );
}

/** 変換後の動画を再生して確認するプレーヤー（変換が終わったあとの結果欄で使う） */
export function VideoOutputPlayer({ url }: { url: string }) {
  return (
    <div className="flex w-full flex-col gap-1">
      <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">変換後の動画</p>
      <video
        src={url}
        controls
        playsInline
        preload="metadata"
        data-testid="video-output-preview"
        className="block mx-auto h-auto w-auto max-w-full max-h-[min(60vh,30rem)] rounded-lg bg-black"
      />
    </div>
  );
}
