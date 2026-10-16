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

export interface AudioCompressInput {
  file: File;
  /** 非可逆形式（MP3 / M4A / OGG）、または "original"（元と同じ形式で再圧縮） */
  choice: AudioOutputChoice;
  bitrateKbps: number;
  /** trueでモノラルにする（ファイルサイズがほぼ半分になる） */
  mono: boolean;
  /** 出力のサンプリング周波数(Hz)。省略時は元のまま */
  sampleRate?: number;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface AudioCompressOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  kind: AudioOutputKind;
  ext: string;
}

/** 音声圧縮。ビットレートを下げて再エンコードし、ファイルサイズを小さくする。 */
export class AudioCompressProcessor extends BrowserProcessor<AudioCompressInput, AudioCompressOutput> {
  async process({
    file,
    choice,
    bitrateKbps,
    mono,
    sampleRate,
    onProgress,
    cancelSignal,
  }: AudioCompressInput): Promise<AudioCompressOutput> {
    if (cancelSignal?.aborted) throw new AudioCanceledByUserError();

    const info = await inspectAudioFile(file);
    try {
      const { kind } = resolveOutputChoice(choice, info.codec, true);
      if (!getAudioOutputOption(kind).lossy) {
        throw new Error(
          "元の音声が無圧縮（WAV / FLAC）のため、同じ形式のまま圧縮はできません。出力形式にMP3・M4A・OGGのいずれかを選んでください。"
        );
      }
      const { blob, sizeBytes } = await runAudioConversion({
        input: info.input,
        kind,
        bitrateKbps,
        channels: mono ? 1 : undefined,
        sampleRate,
        forceTranscode: true,
        onProgress,
        cancelSignal,
      });
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: info.durationSec,
        kind,
        ext: getAudioOutputOption(kind).ext,
      };
    } finally {
      info.input.dispose();
    }
  }
}
