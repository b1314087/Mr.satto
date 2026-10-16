import { BrowserProcessor } from "../types";
import {
  AudioCanceledByUserError,
  applyGain,
  dbToGain,
  gainToDb,
  getAudioOutputOption,
  inspectAudioFile,
  resolveOutputChoice,
  runAudioConversion,
  scanPeak,
  type AudioOutputChoice,
  type AudioOutputKind,
} from "@/lib/audio/shared";

export type VolumeMode = "gain" | "normalize";

export interface AudioVolumeInput {
  file: File;
  mode: VolumeMode;
  /** mode="gain" のときの増減量(dB) */
  gainDb: number;
  /** mode="normalize" のときの目標ピーク(dBFS、0以下) */
  targetPeakDb: number;
  /** "original" は元と同じ形式で再エンコードして書き出す */
  choice: AudioOutputChoice;
  bitrateKbps?: number;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface AudioVolumeOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  kind: AudioOutputKind;
  ext: string;
  /** 実際に掛けた倍率(dB) */
  appliedGainDb: number;
  /** 元の最大ピーク(dBFS)。ノーマライズ時のみ */
  originalPeakDb: number | null;
  /** ゲインにより音が割れる（クリップする）可能性があるか */
  mayClip: boolean;
}

/** 音量調整（dB指定）／ノーマライズ（最大音量を目標値に揃える）。 */
export class AudioVolumeProcessor extends BrowserProcessor<AudioVolumeInput, AudioVolumeOutput> {
  async process({
    file,
    mode,
    gainDb,
    targetPeakDb,
    choice,
    bitrateKbps,
    onProgress,
    cancelSignal,
  }: AudioVolumeInput): Promise<AudioVolumeOutput> {
    if (cancelSignal?.aborted) throw new AudioCanceledByUserError();

    const info = await inspectAudioFile(file);
    try {
      let appliedDb = gainDb;
      let originalPeakDb: number | null = null;
      let mayClip = false;

      if (mode === "normalize") {
        // 1回目: 全体の最大ピークを調べる（進捗の前半 40%）
        const peak = await scanPeak(
          info.audioTrack,
          info.durationSec,
          (p) => onProgress?.(p * 0.4),
          cancelSignal
        );
        if (peak <= 0.0001) {
          throw new Error("この音声はほぼ無音のため、ノーマライズできません。");
        }
        originalPeakDb = gainToDb(peak);
        appliedDb = targetPeakDb - originalPeakDb;
      } else {
        mayClip = gainDb > 0;
      }

      const gain = dbToGain(appliedDb);
      const base = mode === "normalize" ? 0.4 : 0;
      const { kind } = resolveOutputChoice(choice, info.codec, true);

      const { blob, sizeBytes } = await runAudioConversion({
        input: info.input,
        kind,
        bitrateKbps,
        forceTranscode: true,
        process: (sample) => applyGain(sample, gain),
        onProgress: (p) => onProgress?.(base + p * (1 - base)),
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
        appliedGainDb: appliedDb,
        originalPeakDb,
        mayClip,
      };
    } finally {
      info.input.dispose();
    }
  }
}
