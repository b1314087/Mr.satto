import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  getAvailableFrameRates,
  inspectVideoFile,
  runConversion,
  type OutputContainer,
} from "@/lib/video/shared";

export interface VideoFrameRateInput {
  file: File;
  targetFps: number;
  outputContainer: OutputContainer;
  onProgress?: (progress: number) => void;
}

export interface VideoFrameRateOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  sourceFps: number;
  outputContainer: OutputContainer;
}

/**
 * 動画フレームレート変更（Phase 10 / 動画ツール 4）。
 *
 * 対応範囲を明確にする（開発指示書 21章）：元動画の実測fpsより低い値への
 * 変更のみをサポートする。フレーム複製による不自然なアップサンプリングは
 * 行わない（候補にすら出さない）。実測fpsは
 * InputVideoTrack.computeFrameRateMetrics()（実際のフレーム間隔から算出、
 * ファイルのメタデータは信用しない）で求めた bestGuessFrameRate を使う。
 */
export class VideoFrameRateProcessor extends BrowserProcessor<VideoFrameRateInput, VideoFrameRateOutput> {
  async process({
    file,
    targetFps,
    outputContainer,
    onProgress,
  }: VideoFrameRateInput): Promise<VideoFrameRateOutput> {
    if (file.size > VIDEO_SIZE_LIMITS.frameRate * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.frameRate}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const available = getAvailableFrameRates(info.bestGuessFrameRate);
      if (!available.includes(targetFps)) {
        throw new Error(
          "指定したフレームレートはこの動画では選択できません（元の動画より高いフレームレートには変更できません）。"
        );
      }

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: outputContainer,
        video: { frameRate: targetFps },
        onProgress,
      });

      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: info.durationSec,
        width: info.displayWidth,
        height: info.displayHeight,
        sourceFps: info.bestGuessFrameRate,
        outputContainer,
      };
    } finally {
      info.input.dispose();
    }
  }
}
