import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  inspectVideoFile,
  qualityFor,
  runConversion,
  type CompressionLevel,
  type OutputContainer,
} from "@/lib/video/shared";

export interface VideoCompressInput {
  file: File;
  level: CompressionLevel;
  outputContainer: OutputContainer;
  onProgress?: (progress: number) => void;
}

export interface VideoCompressOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  outputContainer: OutputContainer;
}

/**
 * 動画圧縮（Phase 10 / 動画ツール 2）。
 *
 * 圧縮レベル（弱め/標準/強め）を映像のビットレート品質（Quality）へ反映し、
 * forceTranscode: true を指定して確実に再エンコードさせる
 * （指定しない場合、入力コーデックが変換先コンテナでそのまま使える際に
 * mediabunnyが「コピー」を選び、サイズが変わらないままになりうるため）。
 *
 * 解像度・フレームレートはこのツールでは変更しない
 * （それぞれ専用のツールに分離しているため）。
 * 音声は圧縮対象に含めない（そのままコピー）。多くの入力動画の音声は
 * 既に十分圧縮されたAAC/Opus等であり、映像ほどサイズへの影響が大きくない
 * ことに加え、チャンネル数・サンプルレートの意図しない変更を避けるため。
 */
export class VideoCompressProcessor extends BrowserProcessor<VideoCompressInput, VideoCompressOutput> {
  async process({
    file,
    level,
    outputContainer,
    onProgress,
  }: VideoCompressInput): Promise<VideoCompressOutput> {
    if (file.size > VIDEO_SIZE_LIMITS.compress * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.compress}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: outputContainer,
        video: {
          quality: qualityFor(level),
          forceTranscode: true,
        },
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
        outputContainer,
      };
    } finally {
      info.input.dispose();
    }
  }
}
