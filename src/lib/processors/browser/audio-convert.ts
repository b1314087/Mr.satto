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

export interface AudioConvertInput {
  file: File;
  /** 出力形式。"original" は元の音声を再エンコードせずそのまま取り出す */
  choice: AudioOutputChoice;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface AudioConvertOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  kind: AudioOutputKind;
  ext: string;
}

/**
 * 音声形式変換／動画から音声を抽出（共通）。
 * 入力は音声ファイルでも音声付き動画でもよい（映像は常に破棄する）。
 * 全てブラウザ内で処理し、ファイルは外部へ送信されない。
 */
export class AudioConvertProcessor extends BrowserProcessor<AudioConvertInput, AudioConvertOutput> {
  async process({
    file,
    choice,
    bitrateKbps,
    sampleRate,
    channels,
    onProgress,
    cancelSignal,
  }: AudioConvertInput): Promise<AudioConvertOutput> {
    if (cancelSignal?.aborted) throw new AudioCanceledByUserError();

    const info = await inspectAudioFile(file);
    try {
      const needsReencode = sampleRate !== undefined || channels !== undefined;
      const { kind, codec } = resolveOutputChoice(choice, info.codec, needsReencode);
      const { blob, sizeBytes } = await runAudioConversion({
        input: info.input,
        kind,
        codec,
        bitrateKbps,
        sampleRate,
        channels,
        onProgress,
        cancelSignal,
      });
      const opt = getAudioOutputOption(kind);
      return {
        blob,
        url: URL.createObjectURL(blob),
        sizeBytes,
        inputSizeBytes: file.size,
        durationSec: info.durationSec,
        kind,
        ext: opt.ext,
      };
    } finally {
      info.input.dispose();
    }
  }
}
