import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  inspectVideoFile,
  runConversion,
  type OutputContainer,
} from "@/lib/video/shared";

export interface VideoConvertInput {
  file: File;
  outputContainer: OutputContainer;
  onProgress?: (progress: number) => void;
}

export interface VideoConvertOutput {
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
 * 動画形式変換（Phase 10 / 動画ツール 1）。
 *
 * コンテナ（MP4 / WebM）だけを変換する。既存のコーデックが変換先コンテナで
 * そのまま使える場合はmediabunnyが自動的に「コピー」（再エンコードなし）で
 * 済ませ、そうでない場合のみ自動で再エンコードする（Conversion API既定動作）。
 * このツール自身では codec / bitrate を指定しない
 * ＝ユーザーが求めているのはあくまで「コンテナの変換」であり、
 * 画質やコーデックへの意図しない介入を避けるため。
 */
export class VideoConvertProcessor extends BrowserProcessor<VideoConvertInput, VideoConvertOutput> {
  async process({ file, outputContainer, onProgress }: VideoConvertInput): Promise<VideoConvertOutput> {
    if (file.size > VIDEO_SIZE_LIMITS.convert * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.convert}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: outputContainer,
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
