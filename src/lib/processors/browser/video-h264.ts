import { BrowserProcessor } from "../types";
import {
  VideoCanceledByUserError,
  checkH264EncodeSupport,
  inspectVideoFile,
  qualityFromName,
  runConversion,
  type VideoQualityName,
} from "@/lib/video/shared";

export interface VideoH264Input {
  file: File;
  /**
   * 再エンコードするときの画質。省略時は "high"(高画質)。元の動画がすでにH.264のときは再エンコードしないので無関係。
   * H.265はH.264より同じ画質でもファイルが小さいため、H.265→H.264ではファイルサイズが大きくなることがある。
   */
  quality?: VideoQualityName;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface VideoH264Output {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  /** 元の動画の映像コーデック("hevc" / "avc" / "vp9" など) */
  sourceCodec: string | null;
  /** 再エンコードしたか(元がH.264なら、画質を落とさずMP4に入れ直すだけなのでfalse) */
  reencoded: boolean;
}

/**
 * H.264コーデック変換（Phase 10 / 動画ツール 5）。H.265(HEVC)・VP9・AV1など、ほかのコーデックの動画をH.264にできる。
 * iPhoneなどで撮影したH.265のMOV/MP4を、どこでも再生できるH.264のMP4にする使い方を想定している
 * (H.265の読み込みは、WebCodecsでH.265をデコードできるブラウザが必要。できない場合は専用の案内を出す)。
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
  async process({ file, quality = "high", onProgress, cancelSignal }: VideoH264Input): Promise<VideoH264Output> {
    if (cancelSignal?.aborted) {
      throw new VideoCanceledByUserError();
    }

    const info = await inspectVideoFile(file);
    try {
      if (cancelSignal?.aborted) {
        throw new VideoCanceledByUserError();
      }

      const supported = await checkH264EncodeSupport(info.displayWidth, info.displayHeight);
      if (!supported) {
        throw new Error(
          "このブラウザではH.264変換を利用できません。別のブラウザ（最新のChrome等）でお試しください。"
        );
      }
      if (cancelSignal?.aborted) {
        throw new VideoCanceledByUserError();
      }

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: "mp4",
        video: info.codec === "avc" ? { codec: "avc" } : { codec: "avc", quality: qualityFromName(quality) },
        onProgress,
        cancelSignal,
      });

      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: info.durationSec,
        width: info.displayWidth,
        height: info.displayHeight,
        sourceCodec: info.codec,
        reencoded: info.codec !== "avc",
      };
    } finally {
      info.input.dispose();
    }
  }
}
