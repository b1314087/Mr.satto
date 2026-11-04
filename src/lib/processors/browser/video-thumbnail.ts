import { BrowserProcessor } from "../types";
import {
  VideoCanceledByUserError,
  toFriendlyVideoError,
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
        // 内部のエラー（英語）をそのまま見せず、原因に合った日本語の案内にする（動画編集 工程1）
        throw toFriendlyVideoError(e);
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

// ---------------------------------------------------------------------------
// 複数抽出（動画編集 工程4）
// ---------------------------------------------------------------------------

export interface VideoThumbnailBatchInput {
  file: File;
  /** 取り出す時刻（秒・小さい順） */
  times: number[];
  format: ThumbnailImageFormat;
  jpegQuality: number;
  onProgress?: (done: number, total: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoThumbnailBatchItem {
  /** 指定した時刻 */
  timestampSec: number;
  /** 実際に取り出したコマの時刻 */
  frameSec: number;
  blob: Blob;
  width: number;
  height: number;
}

export interface VideoThumbnailBatchOutput {
  items: VideoThumbnailBatchItem[];
  /** 取り出せなかった時刻と理由 */
  failures: { timestampSec: number; message: string }[];
  /** 別の時刻と同じコマになったため、省いた数 */
  sameFrameSkipped: number;
  format: ThumbnailImageFormat;
}

/**
 * 1本の動画から、複数の時刻のコマを、順番に1枚ずつ取り出す（全部のコマを一度にメモリへ読まない）。
 * 取り出したら、すぐ画像（Blob）にして、キャンバスは手放す。
 * 1枚が失敗しても、ほかの時刻は続ける（失敗した時刻は failures に入れ、画面で「一部を取り出せなかった」と知らせる）。
 * キャンセルしたときは、途中まで取り出した画像は返さない（完成品と間違えないため）。
 */
export class VideoThumbnailBatchProcessor extends BrowserProcessor<VideoThumbnailBatchInput, VideoThumbnailBatchOutput> {
  async process({ file, times, format, jpegQuality, onProgress, cancelSignal }: VideoThumbnailBatchInput): Promise<VideoThumbnailBatchOutput> {
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();
    if (times.length === 0) throw new Error("取り出す時刻がありません。");
    const info = await inspectVideoFile(file);
    let canceledByUser = false;
    const onAbort = () => {
      canceledByUser = true;
      info.input.dispose();
    };
    cancelSignal?.addEventListener("abort", onAbort);
    const items: VideoThumbnailBatchItem[] = [];
    const failures: { timestampSec: number; message: string }[] = [];
    let sameFrameSkipped = 0;
    const seenFrames = new Set<number>();
    try {
      const sink = createThumbnailCanvasSink(info.videoTrack, info.displayWidth, info.displayHeight);
      const mimeType = format === "png" ? "image/png" : "image/jpeg";
      onProgress?.(0, times.length);
      for (let i = 0; i < times.length; i++) {
        if (canceledByUser) throw new VideoCanceledByUserError();
        const t = Math.max(0, Math.min(times[i], Math.max(info.durationSec - 0.001, 0)));
        try {
          const wrapped = await sink.getCanvas(t);
          if (canceledByUser) throw new VideoCanceledByUserError();
          if (!wrapped) throw new Error("この時刻のコマを取得できませんでした。");
          const frameKey = Math.round(wrapped.timestamp * 1000);
          if (seenFrames.has(frameKey)) {
            // 別の時刻と同じコマ（動画のコマの間隔より近い時刻など）は、同じ画像を2回作らない
            sameFrameSkipped++;
          } else {
            seenFrames.add(frameKey);
            const blob = await canvasToBlob(wrapped.canvas, mimeType, format === "jpeg" ? jpegQuality : undefined);
            if (canceledByUser) throw new VideoCanceledByUserError();
            if (!blob) throw new Error("画像の生成に失敗しました。");
            items.push({ timestampSec: times[i], frameSec: wrapped.timestamp, blob, width: wrapped.canvas.width, height: wrapped.canvas.height });
          }
        } catch (e) {
          if (canceledByUser || e instanceof VideoCanceledByUserError) throw new VideoCanceledByUserError();
          failures.push({ timestampSec: times[i], message: toFriendlyVideoError(e).message });
        }
        onProgress?.(i + 1, times.length);
      }
      if (items.length === 0) {
        throw new Error(failures[0]?.message ?? "画像を取り出せませんでした。");
      }
      return { items, failures, sameFrameSkipped, format };
    } catch (e) {
      // キャンセル・全部失敗のときは、途中まで作った画像を手放す
      items.length = 0;
      throw e;
    } finally {
      cancelSignal?.removeEventListener("abort", onAbort);
      info.input.dispose();
    }
  }
}
