import { BrowserProcessor } from "../types";
import {
  VIDEO_SIZE_LIMITS,
  checkH264EncodeSupport,
  inspectVideoFile,
  runConversion,
} from "@/lib/video/shared";

export interface VideoH264Input {
  file: File;
  onProgress?: (progress: number) => void;
}

export interface VideoH264Output {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
}

/**
 * H.264コーデック変換（Phase 10 / 動画ツール 5）。
 *
 * 出力コンテナは常にMP4に固定する（H.264/AVCはMP4との組み合わせが
 * 最も互換性が高く、WebMへH.264を格納するのは一般的でないため。
 * 開発指示書 22章：コンテナとコーデックを混同しない）。
 *
 * 実行前に必ず canEncodeVideo("avc", ...) でこのブラウザが実際に
 * H.264エンコードを利用できるかを確認する（開発指示書 24章）。
 * 利用できない場合は変換を試みず、分かりやすいエラーを返す。
 *
 * codecにavcを指定するだけで、入力が既にH.264の場合はmediabunnyが
 * 自動的に「コピー」（無劣化・高速）を選び、そうでない場合のみ実際に
 * 再エンコードする。これは「無駄な劣化を避ける」という観点で正しい挙動であり、
 * 「変換していないのに完了扱いにする」ことには当たらない
 * （出力は最終的に必ずH.264/MP4になっている。開発指示書 67章9項）。
 */
export class VideoH264Processor extends BrowserProcessor<VideoH264Input, VideoH264Output> {
  async process({ file, onProgress }: VideoH264Input): Promise<VideoH264Output> {
    if (file.size > VIDEO_SIZE_LIMITS.h264 * 1024 * 1024) {
      throw new Error(
        `ファイルサイズが大きすぎます（上限 ${VIDEO_SIZE_LIMITS.h264}MB）。ファイルを確認してください。`
      );
    }

    const info = await inspectVideoFile(file);
    try {
      const supported = await checkH264EncodeSupport(info.displayWidth, info.displayHeight);
      if (!supported) {
        throw new Error(
          "このブラウザではH.264変換を利用できません。別のブラウザ（最新のChrome等）でお試しください。"
        );
      }

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: "mp4",
        video: { codec: "avc" },
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
      };
    } finally {
      info.input.dispose();
    }
  }
}
