/**
 * ブラウザ側の文字起こしの実行（音声の準備 → 区切り → 1つずつサーバーへ送る）。
 *
 * - 音声・動画は、ブラウザの中で 16kHz・モノラルのWAVに変換する（元のファイルは送らない）。
 * - 区切りごとに /api/ai/transcribe へ送る。サーバーは保存せずにAIへ渡し、文字だけを返す。
 * - 話し声がない区切りは送らない（利用枠を使わない）。
 * - 途中で失敗・中止したときは、そこまでの結果を返す（やり直しは利用者が選ぶ）。
 */
import { AudioConvertProcessor } from "@/lib/processors/browser/audio-convert";
import { AudioCanceledByUserError } from "@/lib/audio/shared";
import {
  TRANSCRIBE_CONSENT_VERSION,
  TRANSCRIBE_MAX_TOTAL_SECONDS,
  TRANSCRIBE_SAMPLE_RATE,
  buildTranscribePrompt,
  encodeWavPcm16Mono,
  parseWavPcm16,
  type TranscribeLanguage,
} from "@/lib/ai/transcribe";
import { FRAME_SEC, frameEnergy, planChunks, speechThreshold, timeSegments, voicedRanges, type TranscriptSegment } from "./transcript";

export interface PreparedAudio {
  samples: Int16Array;
  sampleRate: number;
  durationSec: number;
}

export class TranscribeCanceledError extends Error {
  constructor() {
    super("中止しました。");
    this.name = "TranscribeCanceledError";
  }
}

export class TranscribeRunError extends Error {
  constructor(
    message: string,
    /** 失敗した区切りまでに、できた分 */
    public readonly partial: TranscriptSegment[],
    public readonly usage: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "TranscribeRunError";
  }
}

/** 音声（または動画の音声）を、送る形式（16kHz・モノラル・16bit）にする */
export async function prepareTranscriptionAudio(file: File, opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<PreparedAudio> {
  let out;
  try {
    out = await new AudioConvertProcessor().process({
      file,
      choice: "wav",
      sampleRate: TRANSCRIBE_SAMPLE_RATE,
      channels: 1,
      onProgress: opts.onProgress,
      cancelSignal: opts.signal,
    });
  } catch (e) {
    if (e instanceof AudioCanceledByUserError || opts.signal?.aborted) throw new TranscribeCanceledError();
    throw e;
  }
  URL.revokeObjectURL(out.url);
  const bytes = new Uint8Array(await out.blob.arrayBuffer());
  const wav = parseWavPcm16(bytes);
  if (!wav.ok || wav.channels !== 1) throw new Error("音声を準備できませんでした。別のファイルでお試しください。");
  if (wav.durationSec > TRANSCRIBE_MAX_TOTAL_SECONDS) {
    throw new Error(`1回で文字起こしできるのは${TRANSCRIBE_MAX_TOTAL_SECONDS / 60}分までです。音声カットで分けてからお試しください。`);
  }
  // 2バイト境界にそろえるため、データ部分をコピーする
  const samples = new Int16Array(bytes.slice(wav.dataOffset, wav.dataOffset + wav.dataBytes).buffer);
  return { samples, sampleRate: wav.sampleRate, durationSec: wav.durationSec };
}

/** 送る区切りと、それぞれの「声がある時間」（無音の区切りは除く） */
export function planTranscription(audio: PreparedAudio) {
  const energy = frameEnergy(audio.samples, audio.sampleRate, FRAME_SEC);
  const threshold = speechThreshold(energy);
  const chunks = planChunks(energy, FRAME_SEC).map((range) => ({ range, voiced: voicedRanges(energy, threshold, range, FRAME_SEC) }));
  const toSend = chunks.filter((c) => c.voiced.length > 0);
  const silentSec = chunks.filter((c) => c.voiced.length === 0).reduce((sum, c) => sum + (c.range.end - c.range.start), 0);
  const sendSec = toSend.reduce((sum, c) => sum + (c.range.end - c.range.start), 0);
  return { chunks: toSend, silentSec, sendSec };
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface RunTranscriptionOptions {
  language: TranscribeLanguage;
  terms: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, segments: TranscriptSegment[]) => void;
  onUsage?: (usage: Record<string, unknown>) => void;
}

export class TranscribeChunkError extends Error {
  constructor(
    message: string,
    public readonly usage: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "TranscribeChunkError";
  }
}

/**
 * 区切り1つ分の音声（16kHz・モノラルのWAV）を /api/ai/transcribe へ送り、文字を受け取る。
 * 失敗は TranscribeChunkError（利用状況が返っていれば添える）、中止は TranscribeCanceledError。
 */
export async function sendTranscribeChunk(
  wav: Uint8Array,
  opts: { language: TranscribeLanguage; prompt: string; signal?: AbortSignal },
): Promise<{ text: string; usage: Record<string, unknown> | null }> {
  if (opts.signal?.aborted) throw new TranscribeCanceledError();
  const form = new FormData();
  form.append("audio", new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }), "chunk.wav");
  form.append("requestId", newRequestId());
  form.append("language", opts.language);
  form.append("prompt", opts.prompt);
  form.append("consentAccepted", "true");
  form.append("consentVersion", TRANSCRIBE_CONSENT_VERSION);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), 70_000);
  let data: Record<string, unknown> | null = null;
  let ok = false;
  try {
    const res = await fetch("/api/ai/transcribe", { method: "POST", body: form, cache: "no-store", signal: controller.signal });
    data = await res.json().catch(() => null);
    ok = res.ok && data?.ok === true;
  } catch {
    if (opts.signal?.aborted) throw new TranscribeCanceledError();
    throw new TranscribeChunkError("通信に失敗しました。時間をおいて、もう一度お試しください。", null);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  const usage = data?.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : null;
  if (!ok) throw new TranscribeChunkError(typeof data?.message === "string" ? data.message : "文字起こしに失敗しました。", usage);
  return { text: typeof data?.text === "string" ? data.text : "", usage };
}

/** 区切りを1つずつ送り、時間つきの文の一覧を返す */
export async function runTranscription(audio: PreparedAudio, options: RunTranscriptionOptions): Promise<TranscriptSegment[]> {
  const { chunks } = planTranscription(audio);
  const segments: TranscriptSegment[] = [];
  let previous = "";
  let lastUsage: Record<string, unknown> | null = null;
  options.onProgress?.(0, chunks.length, segments);
  for (let i = 0; i < chunks.length; i++) {
    if (options.signal?.aborted) throw new TranscribeCanceledError();
    const { range, voiced } = chunks[i];
    const from = Math.floor(range.start * audio.sampleRate);
    const to = Math.min(audio.samples.length, Math.ceil(range.end * audio.sampleRate));
    const wav = encodeWavPcm16Mono(audio.samples.subarray(from, to), audio.sampleRate);
    let text: string;
    try {
      const r = await sendTranscribeChunk(wav, { language: options.language, prompt: buildTranscribePrompt(options.terms, previous), signal: options.signal });
      text = r.text;
      if (r.usage) {
        lastUsage = r.usage;
        options.onUsage?.(r.usage);
      }
    } catch (e) {
      if (e instanceof TranscribeCanceledError) throw e;
      const usage = e instanceof TranscribeChunkError ? e.usage : null;
      if (usage) options.onUsage?.(usage);
      throw new TranscribeRunError(e instanceof Error ? e.message : "文字起こしに失敗しました。", segments, usage ?? lastUsage);
    }

    segments.push(...timeSegments(text, range, voiced));
    previous = text;
    options.onProgress?.(i + 1, chunks.length, segments);
  }
  return segments;
}
