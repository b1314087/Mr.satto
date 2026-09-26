import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  createThumbnailCanvasSink,
  inspectVideoFile,
} from "@/lib/video/shared";

export type ThumbnailImageFormat = "png" | "jpeg";

export interface VideoThumbnailInput {
  file: File;
  timestampSec: number;
  format: ThumbnailImageFormat;
  /** JPEG時の品質(0-1)。PNG時は無視される */
  jpegQuality: number;
}

export interface VideoThumbnailOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  width: number;
  height: number;
  timestampSec: number;
  format: ThumbnailImageFormat;
}

/**
 * 動画サムネイル・静止画抽出（Phase 10 / 動画ツール 6）。
 *
 * 6機能の中で最も軽量：動画全体をデコード・再エンコードする必要がなく、
 * 指定した1時点のフレームだけをmediabunnyのCanvasSinkでシーク取得し、
 * Canvas → Blob(PNG/JPEG) に変換するだけで完結する。
 * Output / Conversion（demux→デコード→エンコード→mux）は一切使わない。
 */
export class VideoThumbnailProcessor extends BrowserProcessor<VideoThumbnailInput, VideoThumbnailOutput> {
  async process({
    file,
    timestampSec,
    format,
    jpegQuality,
  }: VideoThumbnailInput): Promise<VideoThumbnailOutput> {
    if (file.size > VIDEO_SIZE_LIMITS.thumbnail * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.thumbnail}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const clampedTimestamp = Math.max(0, Math.min(timestampSec, Math.max(info.durationSec - 0.001, 0)));
      const sink = createThumbnailCanvasSink(info.videoTrack, info.displayWidth, info.displayHeight);
      const wrapped = await sink.getCanvas(clampedTimestamp);
      if (!wrapped) {
        throw new Error("指定した時点のフレームを取得できませんでした。別の時点をお試しください。");
      }

      const mimeType = format === "png" ? "image/png" : "image/jpeg";
      const blob = await canvasToBlob(wrapped.canvas, mimeType, format === "jpeg" ? jpegQuality : undefined);
      if (!blob) {
        throw new Error("画像の生成に失敗しました。");
      }

      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes: blob.size,
        width: wrapped.canvas.width,
        height: wrapped.canvas.height,
        timestampSec: clampedTimestamp,
        format,
      };
    } finally {
      info.input.dispose();
    }
  }
}

/**
 * HTMLCanvasElement / OffscreenCanvas のどちらが返っても扱えるように
 * Blob化を共通化する（CanvasSinkはDOM文脈ではHTMLCanvasElementを返す）。
 */
function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality?: number
): Promise<Blob | null> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}
