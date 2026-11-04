import { BrowserProcessor } from "../types";
import {
  VideoCanceledByUserError,
  inspectOutputSummary,
  inspectVideoFile,
  runConversion,
  type OutputContainer,
  type VideoOutputSummary,
} from "@/lib/video/shared";
import { buildVideoOptions, fpsChoicesFor, resolutionChoicesFor, type VideoEditSettings } from "@/lib/video/edit-settings";

export interface VideoEditInput {
  file: File;
  settings: VideoEditSettings;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
  /** 音声を書き出せない形式で、利用者が「音声なしで書き出す」を選んだとき true（動画編集 工程1） */
  dropAudio?: boolean;
}

export interface VideoEditOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  outputContainer: OutputContainer;
  /** 元の動画の情報 */
  input: { width: number; height: number; fps: number; durationSec: number; hasAudio: boolean };
  /** 書き出した動画を読み直して調べた、実際の情報 */
  output: VideoOutputSummary;
}

/**
 * 動画の変換・編集（動画編集 工程2）。形式変換・圧縮・解像度変更・フレームレート変更の4ページが共通で使う。
 *
 * 出力形式・画質・解像度・フレームレートの指定を、1回の変換（runConversion）にまとめて渡す。
 * 解像度を変えてから別に圧縮する、のような二重の作り直しはしない（時間がかかり、画質も落ちるため）。
 *
 * 工程1の仕組み（音声の確認と案内・少しずつの書き出し・MP4の moov を先頭へ・書き出し後の確認・
 * キャンセル・エラーの日本語化）は、すべて runConversion の中にあり、そのまま使う。
 * 元の動画より大きい解像度・高いフレームレートは、画面で選べないうえ、ここでも受け付けない（拡大しない）。
 */
export class VideoEditProcessor extends BrowserProcessor<VideoEditInput, VideoEditOutput> {
  async process({ file, settings, onProgress, cancelSignal, dropAudio }: VideoEditInput): Promise<VideoEditOutput> {
    if (cancelSignal?.aborted) throw new VideoCanceledByUserError();
    if (settings.resolution === null || settings.fps === null) {
      throw new Error(settings.resolution === null ? "変更後の解像度を選んでください。" : "変更後のフレームレートを選んでください。");
    }

    const info = await inspectVideoFile(file);
    try {
      if (cancelSignal?.aborted) throw new VideoCanceledByUserError();

      if (typeof settings.resolution === "number" && !resolutionChoicesFor(info.displayWidth, info.displayHeight).includes(settings.resolution)) {
        throw new Error("指定した解像度はこの動画では選択できません（元の動画より大きい解像度には拡大できません）。");
      }
      if (typeof settings.fps === "number" && !fpsChoicesFor(info.bestGuessFrameRate).includes(settings.fps)) {
        throw new Error("指定したフレームレートはこの動画では選択できません（元の動画より高いフレームレートには変更できません）。");
      }

      const { blob, sizeBytes } = await runConversion({
        input: info.input,
        container: settings.container,
        video: buildVideoOptions(settings, { width: info.displayWidth, height: info.displayHeight }),
        onProgress,
        cancelSignal,
        dropAudio,
      });

      const output = await inspectOutputSummary(blob, settings.container);
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        outputContainer: settings.container,
        input: {
          width: info.displayWidth,
          height: info.displayHeight,
          fps: info.bestGuessFrameRate,
          durationSec: info.durationSec,
          hasAudio: info.hasAudio,
        },
        output,
      };
    } finally {
      info.input.dispose();
    }
  }
}
