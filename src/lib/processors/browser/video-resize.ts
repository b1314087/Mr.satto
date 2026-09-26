import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  getAvailableResolutionPresets,
  inspectOutputDimensions,
  inspectVideoFile,
  resolutionOptionsFor,
  runConversion,
  type OutputContainer,
} from "@/lib/video/shared";

export interface VideoResizeInput {
  file: File;
  /** 短辺の目標ピクセル数（1080 / 720 / 480）。入力より大きい値は指定できない */
  shortSideTarget: number;
  outputContainer: OutputContainer;
  onProgress?: (progress: number) => void;
}

export interface VideoResizeOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
  outputContainer: OutputContainer;
}

/**
 * 動画解像度変更（Phase 10 / 動画ツール 3）。
 *
 * 縦動画・横動画を問わず、短辺（縦動画なら幅、横動画なら高さ）を基準に
 * 目標解像度を指定し、長辺はmediabunnyの自動アスペクト比計算に任せる。
 * これにより意図しない引き伸ばし・レターボックスを避け、アスペクト比を
 * 常に維持する（開発指示書 20章）。
 *
 * 入力より大きい解像度は候補にすら出さない（アップスケール非対応）。
 * ここでも一応、呼び出し側の実装ミスに備えてサーバー的な二重チェックを行う。
 */
export class VideoResizeProcessor extends BrowserProcessor<VideoResizeInput, VideoResizeOutput> {
  async process({
    file,
    shortSideTarget,
    outputContainer,
    onProgress,
  }: VideoResizeInput): Promise<VideoResizeOutput> {
    if (file.size > VIDEO_SIZE_LIMITS.resize * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.resize}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const available = getAvailableResolutionPresets(info.displayWidth, info.displayHeight);
      if (!available.includes(shortSideTarget)) {
        throw new Error(
          "指定した解像度はこの動画では選択できません（元の動画より大きい解像度には拡大できません）。"
        );
      }

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: outputContainer,
        video: resolutionOptionsFor(info.displayWidth, info.displayHeight, shortSideTarget),
        onProgress,
      });

      const outputDims = await inspectOutputDimensions(blob, outputContainer);

      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: info.durationSec,
        inputWidth: info.displayWidth,
        inputHeight: info.displayHeight,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        outputContainer,
      };
    } finally {
      info.input.dispose();
    }
  }
}
