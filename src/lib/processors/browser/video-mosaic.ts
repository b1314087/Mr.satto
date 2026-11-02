import { BrowserProcessor } from "../types";
import type { VideoSample } from "mediabunny";
import {
  VideoCanceledByUserError,
  inspectVideoFile,
  runConversion,
  toFriendlyVideoError,
  type OutputContainer,
} from "@/lib/video/shared";
import { boxAt, clampBox, EffectPainter, isActiveAt, type MosaicRegion } from "@/lib/video/mosaic-regions";

/**
 * 動画モザイク（Stage 5）。指定した範囲（固定・追跡）に、フレームごとにモザイク・ぼかし・塗りつぶしをかけて書き出す。
 *
 * 書き出しは、ほかの動画ツールと同じ runConversion（mediabunny の Conversion API・WebCodecs）を使い、
 * video.process で、1フレームずつキャンバスに描いて効果をかける。全フレームを一度にメモリへ読まない。
 * 音声は Conversion の既定の扱い（そのままコピー、または出力形式に合わせて変換）で残す。
 * フレームレート・長さは元のまま（フレームを落とさない・足さない）。動画はブラウザの外へ送らない。
 */

export interface VideoMosaicInput {
  file: File;
  regions: MosaicRegion[];
  /** 範囲の座標の基準にした動画の大きさ（画面で見た大きさ。書き出しの大きさと違えば、比で合わせる） */
  sourceWidth: number;
  sourceHeight: number;
  outputContainer: OutputContainer;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoMosaicOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  outputContainer: OutputContainer;
}

export class VideoMosaicProcessor extends BrowserProcessor<VideoMosaicInput, VideoMosaicOutput> {
  async process({ file, regions, sourceWidth, sourceHeight, outputContainer, onProgress, cancelSignal }: VideoMosaicInput): Promise<VideoMosaicOutput> {
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();
    if (regions.length === 0) throw new Error("モザイクをかける範囲がありません。動画の上をドラッグして、範囲を指定してください。");
    const info = await inspectVideoFile(file);
    try {
      const W = info.displayWidth;
      const H = info.displayHeight;
      const kx = W / Math.max(1, sourceWidth);
      const ky = H / Math.max(1, sourceHeight);
      const shortSide = Math.min(W, H);
      const frameSec = 1 / Math.max(1, info.bestGuessFrameRate);
      let canvas: OffscreenCanvas | HTMLCanvasElement;
      if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(W, H);
      else {
        canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
      }
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      if (!ctx) throw new Error("この環境では、動画にモザイクをかけられません。");
      const painter = new EffectPainter();

      const process = (sample: VideoSample) => {
        const t = sample.timestamp;
        ctx.clearRect(0, 0, W, H);
        // 回転の情報（縦向きに撮った動画など）も反映して、表示の向きで描く
        sample.draw(ctx, 0, 0, W, H);
        for (const r of regions) {
          if (!isActiveAt(r, t)) continue;
          const b = boxAt(r, t, frameSec);
          const box = clampBox({ x: b.x * kx, y: b.y * ky, w: b.w * kx, h: b.h * ky }, W, H);
          painter.apply(ctx, canvas, box, r.kind, r.level, shortSide);
        }
        return canvas;
      };

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: outputContainer,
        video: { process, processedWidth: W, processedHeight: H, forceTranscode: true },
        onProgress,
        cancelSignal,
      });
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        durationSec: info.durationSec,
        width: W,
        height: H,
        hasAudio: info.hasAudio,
        outputContainer,
      };
    } catch (e) {
      if (e instanceof VideoCanceledByUserError) throw e;
      throw toFriendlyVideoError(e);
    } finally {
      info.input.dispose();
    }
  }
}
