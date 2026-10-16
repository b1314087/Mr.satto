import { AudioBufferSource, BufferTarget, Output } from "mediabunny";
import { BrowserProcessor } from "../types";
import {
  AudioCanceledByUserError,
  DEFAULT_AUDIO_BITRATE_KBPS,
  canWriteAudioKind,
  getAudioOutputOption,
  outputFormatForKind,
  toFriendlyAudioError,
  type AudioOutputKind,
} from "@/lib/audio/shared";

export interface AudioMergeInput {
  files: File[];
  kind: AudioOutputKind;
  bitrateKbps?: number;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface AudioMergeOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
  inputSizeBytes: number;
  durationSec: number;
  kind: AudioOutputKind;
  ext: string;
}

/** 結合後のサンプリング周波数。異なる周波数のファイルはこれに揃える */
const MERGE_SAMPLE_RATE = 48000;

async function decodeToBuffer(file: File): Promise<AudioBuffer> {
  const data = await file.arrayBuffer();
  // OfflineAudioContextにデコードさせると、指定したサンプリング周波数へ自動でリサンプルされる
  const ctx = new OfflineAudioContext(2, 1, MERGE_SAMPLE_RATE);
  try {
    return await ctx.decodeAudioData(data);
  } catch {
    throw new Error(
      `「${file.name}」を読み込めませんでした。ファイルが破損しているか、お使いのブラウザが対応していない形式の可能性があります。`
    );
  }
}

/** 1ch/3ch以上のバッファをステレオ(2ch)にそろえる。ステレオはそのまま返す */
function toStereo(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels === 2) return buffer;
  const out = new AudioBuffer({ length: buffer.length, numberOfChannels: 2, sampleRate: buffer.sampleRate });
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels >= 2 ? buffer.getChannelData(1) : left;
  out.copyToChannel(left, 0);
  out.copyToChannel(right, 1);
  return out;
}

/**
 * 音声結合。複数の音声ファイルを、指定した順番に1つへつなげる。
 * ファイルごとに順番にデコード→エンコードして、メモリに全部を同時に載せないようにする。
 * サンプリング周波数は48kHz、チャンネルはステレオにそろえる。
 */
export class AudioMergeProcessor extends BrowserProcessor<AudioMergeInput, AudioMergeOutput> {
  async process({ files, kind, bitrateKbps, onProgress, cancelSignal }: AudioMergeInput): Promise<AudioMergeOutput> {
    if (files.length < 2) throw new Error("結合するには2つ以上のファイルを選んでください。");
    if (cancelSignal?.aborted) throw new AudioCanceledByUserError();
    if (!(await canWriteAudioKind(kind))) {
      throw new Error(
        `お使いのブラウザでは${getAudioOutputOption(kind).label}への書き出しに対応していません。別の出力形式を選んでください。`
      );
    }

    const opt = getAudioOutputOption(kind);
    const target = new BufferTarget();
    const output = new Output({ format: outputFormatForKind(kind), target });
    const source = new AudioBufferSource({
      codec: opt.codec,
      ...(opt.lossy ? { bitrate: (bitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS) * 1000 } : {}),
    });
    output.addAudioTrack(source);

    let totalSec = 0;
    let totalIn = 0;
    try {
      await output.start();
      for (let i = 0; i < files.length; i++) {
        if (cancelSignal?.aborted) throw new AudioCanceledByUserError();
        const file = files[i];
        totalIn += file.size;
        const decoded = await decodeToBuffer(file);
        if (cancelSignal?.aborted) throw new AudioCanceledByUserError();
        const stereo = toStereo(decoded);
        totalSec += stereo.duration;
        await source.add(stereo);
        onProgress?.((i + 1) / files.length);
      }
      source.close();
      await output.finalize();
    } catch (e) {
      try {
        await output.cancel();
      } catch {
        // すでに終了済みなどで失敗しても、元のエラーを優先する
      }
      if (e instanceof AudioCanceledByUserError) throw e;
      if (cancelSignal?.aborted) throw new AudioCanceledByUserError();
      throw toFriendlyAudioError(e);
    }

    if (!target.buffer) throw new Error("音声ファイルの生成に失敗しました。");
    const blob = new Blob([target.buffer], { type: opt.mime });
    return {
      blob,
      url: URL.createObjectURL(blob),
      sizeBytes: blob.size,
      inputSizeBytes: totalIn,
      durationSec: totalSec,
      kind,
      ext: opt.ext,
    };
  }
}
