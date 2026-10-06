import { BrowserProcessor } from "../types";
import {
  VideoCanceledByUserError,
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
  /**
   * ユーザーによるキャンセル要求を伝えるシグナル（Phase 27・第4段階）。
   * このツールは Conversion を使わないため、6ツール共通の
   * conversion.cancel() は使えない。CanvasSink.getCanvas() 自体には
   * 中断用のAPIがない（PacketRetrievalOptions型を確認済み）ため、
   * mediabunnyのInput.disposeが「進行中の読み取り処理・メディアシンク
   * 操作をキャンセルする」とドキュメントに明記されている挙動を使って
   * 停止する。Input.dispose()は冪等なので、既存のfinally節とこの
   * キャンセル処理が二重に呼んでも問題ない。
   */
  cancelSignal?: AbortSignal;
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
    cancelSignal,
  }: VideoThumbnailInput): Promise<VideoThumbnailOutput> {
    if (cancelSignal?.aborted) {
      throw new VideoCanceledByUserError();
    }

    const info = await inspectVideoFile(file);

    let canceledByUser = false;
    const onAbort = () => {
      canceledByUser = true;
      // getCanvas()で進行中の読み取りを中断させる（InputDisposedErrorでの
      // reject、または取得済みフレームの破棄につながる）。
      info.input.dispose();
    };
    cancelSignal?.addEventListener("abort", onAbort);

    try {
      if (canceledByUser) {
        throw new VideoCanceledByUserError();
      }

      const clampedTimestamp = Math.max(0, Math.min(timestampSec, Math.max(info.durationSec - 0.001, 0)));
      const sink = createThumbnailCanvasSink(info.videoTrack, info.displayWidth, info.displayHeight);

      let wrapped: Awaited<ReturnType<typeof sink.getCanvas>>;
      try {
        wrapped = await sink.getCanvas(clampedTimestamp);
      } catch (e) {
        if (canceledByUser) {
          throw new VideoCanceledByUserError();
        }
        throw e;
      }
      if (canceledByUser) {
        throw new VideoCanceledByUserError();
      }
      if (!wrapped) {
        throw new Error("指定した時点のフレームを取得できませんでした。別の時点をお試しください。");
      }

      const mimeType = format === "png" ? "image/png" : "image/jpeg";
      const blob = await canvasToBlob(wrapped.canvas, mimeType, format === "jpeg" ? jpegQuality : undefined);
      if (canceledByUser) {
        throw new VideoCanceledByUserError();
      }
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
      cancelSignal?.removeEventListener("abort", onAbort);
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
