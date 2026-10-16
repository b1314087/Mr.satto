/**
 * 音声ツール共通ユーティリティ。
 *
 * 動画ツールと同じく、音声のデコード・エンコードはブラウザ標準のWebCodecsと
 * mediabunny（MPL-2.0）で行い、ファイルをサーバーへ送信することは一切ない。
 *
 * MP3の書き出しについて:
 *   ブラウザ標準のWebCodecsはMP3のエンコードに対応していないため、MP3を出力する
 *   ときだけ @mediabunny/mp3-encoder（LAME + WebAssembly、MPL-2.0 / LAMEはLGPL）を
 *   動的に読み込んで登録する。他の形式を使うときは読み込まれない
 *   （ライセンス表記は /licenses ページを参照）。
 */

import {
  ADTS,
  AudioSample,
  AudioSampleSink,
  BlobSource,
  BufferTarget,
  Conversion,
  FLAC,
  FlacOutputFormat,
  Input,
  MATROSKA,
  MP3,
  MP4,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OGG,
  OggOutputFormat,
  Output,
  QTFF,
  WAVE,
  WEBM,
  WavOutputFormat,
  canEncodeAudio,
  type AudioCodec,
  type InputAudioTrack,
  type OutputFormat,
} from "mediabunny";

/** ファイル選択ダイアログ／ドロップゾーンのaccept属性（音声ファイル） */
export const AUDIO_INPUT_ACCEPT =
  "audio/*,video/mp4,video/quicktime,video/webm,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.weba,.mka,.mp4,.mov,.webm";

/** 動画から音声を取り出すツール用のaccept属性 */
export const VIDEO_TO_AUDIO_INPUT_ACCEPT = "video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm,.mkv,.m4v";

/** 読み取りに使うコンテナ（動画ファイルの音声トラックも含む） */
export const AUDIO_INPUT_FORMATS = [MP3, WAVE, OGG, FLAC, ADTS, MP4, QTFF, WEBM, MATROSKA];

/** ドロップゾーンのサイズ上限(MB)。動画ツールと同様、実質的に上限を設けない */
export const AUDIO_DROPZONE_MAX_MB = 100000;

/** ファイルサイズがこれ以上のとき、メモリ不足の可能性を事前に案内する(MB) */
export const AUDIO_SIZE_WARN_MB = 300;

// ---------------------------------------------------------------------------
// 出力形式
// ---------------------------------------------------------------------------

export type AudioOutputKind = "mp3" | "wav" | "m4a" | "ogg" | "flac";

export interface AudioOutputOption {
  kind: AudioOutputKind;
  label: string;
  ext: string;
  mime: string;
  codec: AudioCodec;
  /** ビットレートを指定できる（非可逆圧縮）形式か */
  lossy: boolean;
  description: string;
}

export const AUDIO_OUTPUT_OPTIONS: AudioOutputOption[] = [
  {
    kind: "mp3",
    label: "MP3",
    ext: "mp3",
    mime: "audio/mpeg",
    codec: "mp3",
    lossy: true,
    description: "ほぼすべての機器・アプリで再生できる定番形式",
  },
  {
    kind: "m4a",
    label: "M4A（AAC）",
    ext: "m4a",
    mime: "audio/mp4",
    codec: "aac",
    lossy: true,
    description: "iPhone・Macで標準的に使われる形式。MP3より同じ音質で小さくなりやすい",
  },
  {
    kind: "wav",
    label: "WAV",
    ext: "wav",
    mime: "audio/wav",
    codec: "pcm-s16",
    lossy: false,
    description: "無圧縮で高音質。ファイルサイズは大きくなります",
  },
  {
    kind: "ogg",
    label: "OGG（Opus）",
    ext: "ogg",
    mime: "audio/ogg",
    codec: "opus",
    lossy: true,
    description: "少ないデータ量で高音質。Web・ゲーム向け",
  },
  {
    kind: "flac",
    label: "FLAC",
    ext: "flac",
    mime: "audio/flac",
    codec: "flac",
    lossy: false,
    description: "音質を落とさずに圧縮する形式（WAVより小さくなります）",
  },
];

/** 出力形式の指定。"original" は元の音声を再エンコードせずそのまま取り出す */
export type AudioOutputChoice = AudioOutputKind | "original";

/**
 * 元の音声コーデックを再エンコードせずに入れられる出力形式を返す。
 * 該当がなければnull（その場合は別の形式を選んでもらう）。
 */
export function resolveOriginalKind(codec: string | null | undefined): { kind: AudioOutputKind; codec: AudioCodec } | null {
  switch (codec) {
    case "aac":
      return { kind: "m4a", codec: "aac" };
    case "mp3":
      return { kind: "mp3", codec: "mp3" };
    case "opus":
      return { kind: "ogg", codec: "opus" };
    case "vorbis":
      return { kind: "ogg", codec: "vorbis" };
    case "flac":
      return { kind: "flac", codec: "flac" };
    case "pcm-s16":
    case "pcm-s24":
    case "pcm-s32":
    case "pcm-f32":
    case "pcm-u8":
      return { kind: "wav", codec: codec as AudioCodec };
    default:
      return null;
  }
}

/**
 * ユーザーの出力形式の選択を、実際に使う形式・コーデックに解決する。
 * reencode=false のとき "original" は元のコーデックのまま（再エンコードなし）。
 */
export function resolveOutputChoice(
  choice: AudioOutputChoice,
  sourceCodec: string | null | undefined,
  reencode: boolean
): { kind: AudioOutputKind; codec?: AudioCodec } {
  if (choice !== "original") return { kind: choice };
  const r = resolveOriginalKind(sourceCodec);
  if (!r) {
    throw new Error(
      `この音声（${audioCodecLabel(sourceCodec)}）は、元の形式のままでは書き出せません。出力形式をMP3やWAVなどから選んでください。`
    );
  }
  return reencode ? { kind: r.kind } : { kind: r.kind, codec: r.codec };
}

export function getAudioOutputOption(kind: AudioOutputKind): AudioOutputOption {
  return AUDIO_OUTPUT_OPTIONS.find((o) => o.kind === kind) ?? AUDIO_OUTPUT_OPTIONS[0];
}

export function outputFormatForKind(kind: AudioOutputKind): OutputFormat {
  switch (kind) {
    case "mp3":
      return new Mp3OutputFormat();
    case "wav":
      return new WavOutputFormat();
    case "m4a":
      return new Mp4OutputFormat();
    case "ogg":
      return new OggOutputFormat();
    case "flac":
      return new FlacOutputFormat();
  }
}

/** ビットレート(kbps)の選択肢 */
export const AUDIO_BITRATE_OPTIONS_KBPS = [320, 256, 192, 128, 96, 64, 48] as const;
export const DEFAULT_AUDIO_BITRATE_KBPS = 192;

let mp3EncoderReady: Promise<boolean> | null = null;

/**
 * MP3エンコーダ（LAME/WebAssembly）を必要なときだけ読み込んで登録する。
 * ブラウザが最初からMP3エンコードに対応している場合は何も読み込まない。
 */
export function ensureMp3Encoder(): Promise<boolean> {
  if (!mp3EncoderReady) {
    mp3EncoderReady = (async () => {
      try {
        if (await canEncodeAudio("mp3")) return true;
        const { registerMp3Encoder } = await import("@mediabunny/mp3-encoder");
        registerMp3Encoder();
        return await canEncodeAudio("mp3");
      } catch {
        return false;
      }
    })();
  }
  return mp3EncoderReady;
}

/** この形式で書き出せるか（実行時にこのブラウザで確認する） */
export async function canWriteAudioKind(kind: AudioOutputKind): Promise<boolean> {
  const opt = getAudioOutputOption(kind);
  try {
    if (kind === "mp3") return await ensureMp3Encoder();
    return await canEncodeAudio(opt.codec);
  } catch {
    return false;
  }
}

/**
 * 選択中の出力形式が、このブラウザで書き出せない場合に、書き出せる形式へ置き換える。
 * （対応状況の調査が終わるまではそのまま返す。"original" は常にそのまま）
 */
export function coerceAudioChoice(
  choice: AudioOutputChoice,
  writable: AudioOutputKind[] | null,
  onlyLossy = false
): AudioOutputChoice {
  if (choice === "original" || writable === null) return choice;
  const usable = writable.filter((k) => !onlyLossy || getAudioOutputOption(k).lossy);
  if (usable.includes(choice)) return choice;
  const order: AudioOutputKind[] = ["mp3", "ogg", "m4a", "wav", "flac"];
  return order.find((k) => usable.includes(k)) ?? choice;
}

/** このブラウザで書き出せる出力形式の一覧 */
export async function getWritableAudioKinds(): Promise<AudioOutputKind[]> {
  const checks = await Promise.all(
    AUDIO_OUTPUT_OPTIONS.map(async (o) => ((await canWriteAudioKind(o.kind)) ? o.kind : null))
  );
  return checks.filter((k): k is AudioOutputKind => k !== null);
}

// ---------------------------------------------------------------------------
// 入力ファイルの検査
// ---------------------------------------------------------------------------

export class AudioCanceledByUserError extends Error {
  constructor(message = "処理をキャンセルしました。") {
    super(message);
    this.name = "AudioCanceledByUserError";
  }
}

/** メモリ不足など、大きいファイルで起きやすい失敗を分かりやすい日本語にする */
export function toFriendlyAudioError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (
    (e instanceof RangeError && /allocation|array buffer|invalid (typed )?array length/i.test(message)) ||
    /out of memory|allocation failed|QuotaExceeded|Unable to allocate/i.test(message)
  ) {
    return new Error(
      "メモリが足りず、処理を完了できませんでした。ファイルが大きすぎる可能性があります。他のタブやアプリを閉じて再度お試しいただくか、ファイルを分割してからお試しください。"
    );
  }
  return e instanceof Error ? e : new Error(message);
}

export function audioSizeWarning(sizeBytes: number): string | null {
  const mb = sizeBytes / 1024 / 1024;
  if (mb >= AUDIO_SIZE_WARN_MB) {
    return `ファイルが大きい（約${Math.round(mb)}MB）ため、処理に時間がかかったり、お使いの端末やブラウザによってはメモリ不足で失敗したりする場合があります。このまま続行できます。`;
  }
  return null;
}

export function audioCodecLabel(codec: string | null | undefined): string {
  switch (codec) {
    case "aac":
      return "AAC";
    case "mp3":
      return "MP3";
    case "opus":
      return "Opus";
    case "vorbis":
      return "Vorbis";
    case "flac":
      return "FLAC";
    case "ac3":
      return "AC-3";
    case "eac3":
      return "E-AC-3";
    case "pcm-s16":
    case "pcm-s24":
    case "pcm-s32":
    case "pcm-f32":
    case "pcm-u8":
      return "WAV（PCM）";
    default:
      return codec ? codec.toUpperCase() : "不明";
  }
}

export interface AudioInputInfo {
  input: Input;
  audioTrack: InputAudioTrack;
  codec: string | null;
  durationSec: number;
  sampleRate: number;
  channels: number;
}

/**
 * 音声ファイル（または音声付き動画）を検証し、長さ・サンプリング周波数などを取得する。
 * 拡張子だけを信頼せず、実際にコンテナを読み取って音声トラックの有無とデコード可否を確認する。
 * 失敗時は分かりやすい日本語のErrorを投げる。
 */
export async function inspectAudioFile(file: File): Promise<AudioInputInfo> {
  const input = new Input({ source: new BlobSource(file), formats: AUDIO_INPUT_FORMATS });

  let canRead = false;
  try {
    canRead = await input.canRead();
  } catch {
    canRead = false;
  }
  if (!canRead) {
    input.dispose();
    throw new Error(
      "この形式のファイルは読み込めませんでした。MP3 / WAV / M4A / AAC / OGG / FLAC などの音声ファイル、またはMP4 / MOV / WebMの動画ファイルを選択してください。"
    );
  }

  const audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
  if (!audioTrack) {
    input.dispose();
    throw new Error("このファイルには音声が含まれていません。");
  }

  const codec = await audioTrack.getCodec().catch(() => null);
  const canDecode = await audioTrack.canDecode().catch(() => false);
  if (!canDecode) {
    input.dispose();
    throw new Error(
      `この音声のコーデック（${audioCodecLabel(codec)}）は、お使いのブラウザでは読み込めません。別のブラウザ（最新のChrome・Edge・Safariなど）でお試しいただくか、別の形式のファイルを選択してください。`
    );
  }

  const [durationSec, sampleRate, channels] = await Promise.all([
    input.computeDuration(),
    audioTrack.getSampleRate(),
    audioTrack.getNumberOfChannels(),
  ]);

  return { input, audioTrack, codec, durationSec, sampleRate, channels };
}

export interface AudioProbe {
  durationSec: number;
  codec: string | null;
  sampleRate: number;
  channels: number;
}

/** ファイル選択直後に、長さ・形式などを軽く調べる（変換はしない）。読めなければnull */
export async function probeAudioFile(file: File): Promise<AudioProbe | null> {
  try {
    const info = await inspectAudioFile(file);
    const probe = {
      durationSec: info.durationSec,
      codec: info.codec,
      sampleRate: info.sampleRate,
      channels: info.channels,
    };
    info.input.dispose();
    return probe;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 変換の実行
// ---------------------------------------------------------------------------

export interface RunAudioConversionParams {
  input: Input;
  kind: AudioOutputKind;
  /** コーデックを明示する（元の音声をそのまま取り出す場合に使う）。省略時は形式の既定 */
  codec?: AudioCodec;
  /** ビットレート(kbps)。非可逆形式のときのみ有効 */
  bitrateKbps?: number;
  /** 出力のサンプリング周波数(Hz)。省略時は入力のまま */
  sampleRate?: number;
  /** 出力のチャンネル数。省略時は入力のまま */
  channels?: number;
  /** 範囲を切り出す（秒）。省略時は全体 */
  trim?: { start?: number; end?: number };
  /** サンプルごとの加工（音量調整など）。返した新しいサンプルが使われる */
  process?: (sample: AudioSample) => AudioSample;
  /** trueで必ず再エンコードする（圧縮・音量調整など） */
  forceTranscode?: boolean;
  onProgress?: (progress: number) => void;
  cancelSignal?: AbortSignal;
}

export interface RunAudioConversionResult {
  blob: Blob;
  sizeBytes: number;
}

/**
 * mediabunnyのConversion APIで、音声のみのファイルを書き出す共通処理。
 * 映像トラックは常に破棄する（動画から音声を取り出す場合も同じ）。
 */
export async function runAudioConversion({
  input,
  kind,
  codec,
  bitrateKbps,
  sampleRate,
  channels,
  trim,
  process,
  forceTranscode,
  onProgress,
  cancelSignal,
}: RunAudioConversionParams): Promise<RunAudioConversionResult> {
  if (cancelSignal?.aborted) throw new AudioCanceledByUserError();

  // 元の音声をそのまま取り出す場合はエンコーダ不要（コンテナに詰め替えるだけ）
  const needsEncoder = codec === undefined || forceTranscode || process !== undefined;
  if (needsEncoder && !(await canWriteAudioKind(kind))) {
    throw new Error(
      `お使いのブラウザでは${getAudioOutputOption(kind).label}への書き出しに対応していません。別の出力形式を選ぶか、最新のChrome・Edge・Safariでお試しください。`
    );
  }
  const opt = getAudioOutputOption(kind);

  const target = new BufferTarget();
  const output = new Output({ format: outputFormatForKind(kind), target });

  // MP3（LAME）は最大2チャンネル。多チャンネルの音声は自動的にステレオへまとめる。
  let outChannels = channels;
  if (kind === "mp3" && outChannels === undefined) {
    const track = await input.getPrimaryAudioTrack().catch(() => null);
    const n = track ? await track.getNumberOfChannels().catch(() => 2) : 2;
    if (n > 2) outChannels = 2;
  }

  const conversion = await Conversion.init({
    input,
    output,
    video: { discard: true },
    audio: {
      codec: codec ?? opt.codec,
      ...(opt.lossy && needsEncoder ? { bitrate: (bitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS) * 1000 } : {}),
      ...(sampleRate ? { sampleRate } : {}),
      ...(outChannels ? { numberOfChannels: outChannels } : {}),
      ...(forceTranscode || process ? { forceTranscode: true } : {}),
      ...(process ? { process } : {}),
    },
    ...(trim && (trim.start !== undefined || trim.end !== undefined)
      ? { trim: { start: trim.start, end: trim.end } }
      : {}),
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => t.reason).join(" / ");
    throw new Error(
      reasons
        ? `この音声は変換できませんでした（${reasons}）。`
        : "この音声は指定した条件では変換できませんでした。"
    );
  }

  if (onProgress) conversion.onProgress = (p) => onProgress(p);

  let canceledByUser = false;
  const onAbort = () => {
    canceledByUser = true;
    void conversion.cancel();
  };
  cancelSignal?.addEventListener("abort", onAbort);

  try {
    await conversion.execute();
  } catch (e) {
    if (canceledByUser) throw new AudioCanceledByUserError();
    throw toFriendlyAudioError(e);
  } finally {
    cancelSignal?.removeEventListener("abort", onAbort);
  }

  if (canceledByUser) throw new AudioCanceledByUserError();
  if (!target.buffer) throw new Error("音声ファイルの生成に失敗しました。");

  const blob = new Blob([target.buffer], { type: opt.mime });
  return { blob, sizeBytes: blob.size };
}

// ---------------------------------------------------------------------------
// 音量・ピーク
// ---------------------------------------------------------------------------

/** dB → 倍率 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** 倍率 → dB（0以下は -Infinity） */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/**
 * 全サンプルにゲインを掛けた新しいAudioSampleを作る。
 * 元のサンプルのcloseはmediabunny側が行うため、ここでは触らない。
 * 振幅は-1〜1にクリップする（音割れを起こす場合があるため、UIで警告を出す）。
 */
export function applyGain(sample: AudioSample, gain: number): AudioSample {
  const total = sample.numberOfFrames * sample.numberOfChannels;
  const buf = new Float32Array(total);
  sample.copyTo(buf, { planeIndex: 0, format: "f32" });
  for (let i = 0; i < total; i++) {
    const v = buf[i] * gain;
    buf[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return new AudioSample({
    data: buf,
    format: "f32",
    numberOfChannels: sample.numberOfChannels,
    sampleRate: sample.sampleRate,
    timestamp: sample.timestamp,
  });
}

/**
 * 音声全体の最大ピーク(0〜1以上)を調べる。ノーマライズ用の先読み。
 * 全体をメモリに貯めず、サンプルごとに最大値だけを更新する。
 */
export async function scanPeak(
  audioTrack: InputAudioTrack,
  durationSec: number,
  onProgress?: (progress: number) => void,
  cancelSignal?: AbortSignal
): Promise<number> {
  const sink = new AudioSampleSink(audioTrack);
  let peak = 0;
  for await (const sample of sink.samples()) {
    if (cancelSignal?.aborted) {
      sample.close();
      throw new AudioCanceledByUserError();
    }
    const total = sample.numberOfFrames * sample.numberOfChannels;
    const buf = new Float32Array(total);
    sample.copyTo(buf, { planeIndex: 0, format: "f32" });
    for (let i = 0; i < total; i++) {
      const a = buf[i] < 0 ? -buf[i] : buf[i];
      if (a > peak) peak = a;
    }
    if (onProgress && durationSec > 0) {
      onProgress(Math.min(1, (sample.timestamp + sample.duration) / durationSec));
    }
    sample.close();
  }
  return peak;
}

// ---------------------------------------------------------------------------
// 表示用ユーティリティ
// ---------------------------------------------------------------------------

/** 秒 → "m:ss.s" 形式 */
export function formatAudioTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** "1:23.4" / "83.4" / "1:02:03" を秒に変換。解釈できなければnull */
export function parseAudioTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null;
    total = total * 60 + Number(p);
  }
  return Number.isFinite(total) ? total : null;
}

/** ビットレート(kbps)と長さから概算サイズ(バイト)を求める */
export function estimateLossyBytes(durationSec: number, bitrateKbps: number): number {
  return Math.round((durationSec * bitrateKbps * 1000) / 8);
}

/** 16bit PCM(WAV)の概算サイズ */
export function estimateWavBytes(durationSec: number, sampleRate: number, channels: number): number {
  return Math.round(durationSec * sampleRate * channels * 2) + 44;
}
