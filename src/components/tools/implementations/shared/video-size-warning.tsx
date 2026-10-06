"use client";

import { videoSizeWarning } from "@/lib/video/shared";

/**
 * 大きい動画ファイルを選んだときの警告。読み込みは止めず、処理に時間がかかる・メモリ不足で失敗する
 * 可能性があることだけを伝える(そのまま続行できる)。小さいファイルでは何も表示しない。
 */
export function VideoSizeWarning({ sizeBytes }: { sizeBytes: number }) {
  const message = videoSizeWarning(sizeBytes);
  if (!message) return null;
  return (
    <p
      role="status"
      data-testid="video-size-warning"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
    >
      {message}
    </p>
  );
}
