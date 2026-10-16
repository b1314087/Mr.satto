import { BrowserProcessor } from "../types";
import {
  AudioCanceledByUserError,
  getAudioOutputOption,
  inspectAudioFile,
  resolveOutputChoice,
  runAudioConversion,
  type AudioOutputChoice,
  type AudioOutputKind,
} from "@/lib/audio/shared";

export interface AudioTrimInput {
  file: File;
  startSec: number;
  endSec: number;
  choice: AudioOutputChoice;
  bitrateKbps?: number;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface AudioTrimOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  /** 切り出した長さ（秒） */
  durationSec: number;
  kind: AudioOutputKind;
  ext: string;
}

/** 音声カット（指定した範囲だけを切り出す）。 */
export class AudioTrimProcessor extends BrowserProcessor<AudioTrimInput, AudioTrimOutput> {
  async process({
    file,
    startSec,
    endSec,
    choice,
    bitrateKbps,
    onProgress,
    cancelSignal,
  }: AudioTrimInput): Promise<AudioTrimOutput> {
    if (cancelSignal?.aborted) throw new AudioCanceledByUserError();
    if (!(endSec > startSec)) {
      throw new Error("終了位置は開始位置より後ろにしてください。");
    }

    const info = await inspectAudioFile(file);
    try {
      if (startSec >= info.durationSec) {
        throw new Error("開始位置が音声の長さを超えています。");
      }
      const end = Math.min(endSec, info.durationSec);
      const { kind, codec } = resolveOutputChoice(choice, info.codec, false);
      const { blob, sizeBytes } = await runAudioConversion({
        input: info.input,
        kind,
        codec,
        bitrateKbps: codec ? undefined : bitrateKbps,
        trim: { start: startSec, end },
        onProgress,
        cancelSignal,
      });
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: end - startSec,
        kind,
        ext: getAudioOutputOption(kind).ext,
      };
    } finally {
      info.input.dispose();
    }
  }
}
