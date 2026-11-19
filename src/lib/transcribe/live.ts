/**
 * 録音しながらの文字起こし（リアルタイム文字起こし。2026-11-19）。2つのやり方がある。
 *
 * 1. かんたん（無料）：ブラウザの音声認識（Web Speech API）。話すとすぐ文字になる（精度は目安）。
 *    Chrome などでは、音声がブラウザの会社の音声認識サービスに送られて文字になる（このサービスのサーバーには送らない）。
 * 2. 高精度（プレミアム・AI）：マイクの音を16kHz・モノラルにして、約30秒ごと（静かな位置で区切る）に
 *    /api/ai/transcribe へ送る。文字起こし（AI）ツールと同じ仕組み・同じ利用枠。少し遅れて文字が足されていく。
 *
 * どちらも、時刻は「録音の中の時間」（一時停止していた時間は数えない）。
 */
import { TRANSCRIBE_SAMPLE_RATE, buildTranscribePrompt, encodeWavPcm16Mono, type TranscribeLanguage } from "@/lib/ai/transcribe";
import { FRAME_SEC, frameEnergy, planChunks, speechThreshold, timeSegments, voicedRanges, type TranscriptSegment } from "./transcript";
import { TranscribeCanceledError, TranscribeChunkError, sendTranscribeChunk } from "./run-transcription";

// ---------------------------------------------------------------------------
// 1. ブラウザの音声認識
// ---------------------------------------------------------------------------

/** Web Speech API の、使う部分だけの型（ブラウザにより名前が違うため） */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** このブラウザで、かんたん（無料）の文字起こしが使えるか */
export function browserSpeechSupported(): boolean {
  return speechRecognitionCtor() !== null;
}

const SPEECH_LANG: Record<TranscribeLanguage, string> = { ja: "ja-JP", en: "en-US", zh: "zh-CN", ko: "ko-KR", auto: "ja-JP" };

export interface LiveUpdate {
  /** 確定した文（時刻つき） */
  segments: TranscriptSegment[];
  /** まだ確定していない、話している途中の文字（かんたんのときだけ） */
  interim: string;
}

export interface LiveTranscriber {
  pause(): void;
  resume(): void;
  /** 止める。高精度のときは、残りの音声を送り終えるまで待つ */
  stop(): Promise<void>;
  /** すぐにやめる（送っている途中のものも中止する） */
  abort(): void;
}

/**
 * ブラウザの音声認識で文字起こしする。ブラウザは数十秒話さないと自分で止まるので、録音中は自動でつなぎ直す。
 * clock は、録音の中の時間（秒）を返す関数。
 */
export function startBrowserLiveTranscriber(opts: {
  language: TranscribeLanguage;
  clock: () => number;
  onUpdate: (u: LiveUpdate) => void;
  onError: (message: string) => void;
}): LiveTranscriber {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) throw new Error("このブラウザは、かんたん文字起こし（音声認識）に対応していません。");
  const segments: TranscriptSegment[] = [];
  let active = true;
  let paused = false;
  let rec: SpeechRecognitionLike | null = null;
  // 話し始めた時刻（結果の番号ごと。確定したときの開始時刻に使う）
  const startedAt = new Map<number, number>();

  const emit = (interim: string) => opts.onUpdate({ segments: [...segments], interim });

  const open = () => {
    const r = new Ctor();
    r.lang = SPEECH_LANG[opts.language];
    r.continuous = true;
    r.interimResults = true;
    startedAt.clear();
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = (res[0]?.transcript ?? "").trim();
        if (!startedAt.has(i)) startedAt.set(i, opts.clock());
        if (res.isFinal) {
          if (text) {
            const start = startedAt.get(i) ?? opts.clock();
            const end = Math.max(start + 0.5, opts.clock());
            // 前の文の終わりが重ならないようにする
            const prev = segments[segments.length - 1];
            if (prev && prev.end > start) prev.end = start;
            segments.push({ start, end, text });
          }
        } else {
          interim += text;
        }
      }
      emit(interim);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        active = false;
        opts.onError("ブラウザの音声認識が使えませんでした。ブラウザの設定で、音声認識（マイク）を許可してください。");
      } else if (e.error === "network") {
        active = false;
        opts.onError("ブラウザの音声認識サービスに接続できませんでした。インターネットの接続を確かめてください（録音は続いています）。");
      } else if (e.error === "language-not-supported") {
        active = false;
        opts.onError("この言語は、お使いのブラウザの音声認識では使えません。");
      }
    };
    r.onend = () => {
      // 録音中なのにブラウザが止めたときは、つなぎ直す
      if (active && !paused) {
        try {
          open();
        } catch {
          // つなぎ直せないときは、そのまま（録音は続く）
        }
      }
    };
    rec = r;
    r.start();
  };

  open();
  return {
    pause() {
      paused = true;
      rec?.stop();
      emit("");
    },
    resume() {
      if (!active) return;
      paused = false;
      open();
    },
    async stop() {
      active = false;
      rec?.stop();
      emit("");
    },
    abort() {
      active = false;
      rec?.abort();
    },
  };
}

// ---------------------------------------------------------------------------
// 2. 高精度（AI）
// ---------------------------------------------------------------------------

/** AIへ送る区切りの長さ（秒）：目安・最短・最長 */
const LIVE_CHUNK = { targetSec: 28, minSec: 20, maxSec: 35 };

/** 浮動小数の音を、16kHz・16bit に間引く（簡単な平均で、折り返し雑音を抑える） */
export function downsampleTo16k(input: Float32Array, inputRate: number, carry: { pos: number }): Int16Array {
  const ratio = inputRate / TRANSCRIBE_SAMPLE_RATE;
  const out: number[] = [];
  let pos = carry.pos;
  while (pos + ratio <= input.length) {
    const from = Math.floor(pos);
    const to = Math.min(input.length, Math.floor(pos + ratio));
    let sum = 0;
    for (let i = from; i < to; i++) sum += input[i];
    const v = sum / Math.max(1, to - from);
    out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
    pos += ratio;
  }
  carry.pos = pos - input.length;
  return Int16Array.from(out);
}

/**
 * マイクの音を集めて、約30秒ごとにAIへ送る。送るのは順番に1つずつ（直前の文字起こしをヒントにするため）。
 * 途中で失敗したら、それ以降は送らず onError で知らせる（録音は続く）。
 */
export function startAiLiveTranscriber(opts: {
  stream: MediaStream;
  language: TranscribeLanguage;
  terms: string;
  onUpdate: (u: LiveUpdate & { pending: number }) => void;
  onUsage: (usage: Record<string, unknown>) => void;
  onError: (message: string) => void;
}): LiveTranscriber {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(opts.stream);
  // ScriptProcessor は古い仕組みだが、別のファイルを読み込まずに使え、主要なブラウザで動く
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute).connect(ctx.destination);

  const controller = new AbortController();
  const segments: TranscriptSegment[] = [];
  const carry = { pos: 0 };
  let parts: Int16Array[] = [];
  let bufferedSamples = 0;
  /** 送った（または捨てた）音声の長さ（秒）。次の区切りの開始時刻 */
  let sentSec = 0;
  let paused = false;
  let failed = false;
  let previous = "";
  let pending = 0;
  let queue: Promise<void> = Promise.resolve();

  const emit = () => opts.onUpdate({ segments: [...segments], interim: "", pending });

  const takeBuffer = (): Int16Array => {
    const all = new Int16Array(bufferedSamples);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return all;
  };

  const enqueue = (samples: Int16Array, startSec: number) => {
    if (failed || samples.length < TRANSCRIBE_SAMPLE_RATE * 0.2) return;
    const energy = frameEnergy(samples, TRANSCRIBE_SAMPLE_RATE, FRAME_SEC);
    const range = { start: 0, end: samples.length / TRANSCRIBE_SAMPLE_RATE };
    const voiced = voicedRanges(energy, speechThreshold(energy), range, FRAME_SEC);
    // 話し声がない区切りは送らない（利用枠を使わない）
    if (voiced.length === 0) return;
    pending++;
    emit();
    const wav = encodeWavPcm16Mono(samples, TRANSCRIBE_SAMPLE_RATE);
    queue = queue.then(async () => {
      if (failed || controller.signal.aborted) return;
      try {
        const r = await sendTranscribeChunk(wav, { language: opts.language, prompt: buildTranscribePrompt(opts.terms, previous), signal: controller.signal });
        if (r.usage) opts.onUsage(r.usage);
        previous = r.text;
        const shifted = timeSegments(r.text, { start: startSec, end: startSec + range.end }, voiced.map((v) => ({ start: v.start, end: v.end })));
        segments.push(...shifted);
      } catch (e) {
        if (e instanceof TranscribeCanceledError) return;
        if (e instanceof TranscribeChunkError && e.usage) opts.onUsage(e.usage);
        failed = true;
        opts.onError(`${e instanceof Error ? e.message : "文字起こしに失敗しました。"}（ここから先の文字起こしは止めました。録音は続いています）`);
      } finally {
        pending--;
        emit();
      }
    });
  };

  /** たまった音声が長くなったら、静かな位置で区切って送る（force のときは全部送る） */
  const flush = (force: boolean) => {
    if (bufferedSamples === 0) return;
    const all = takeBuffer();
    const sec = all.length / TRANSCRIBE_SAMPLE_RATE;
    let cut = all.length;
    if (!force) {
      if (sec <= LIVE_CHUNK.maxSec) return;
      const plan = planChunks(frameEnergy(all, TRANSCRIBE_SAMPLE_RATE, FRAME_SEC), FRAME_SEC, LIVE_CHUNK);
      cut = Math.min(all.length, Math.round(plan[0].end * TRANSCRIBE_SAMPLE_RATE));
    }
    enqueue(all.subarray(0, cut), sentSec);
    sentSec += cut / TRANSCRIBE_SAMPLE_RATE;
    const rest = all.slice(cut);
    parts = rest.length > 0 ? [rest] : [];
    bufferedSamples = rest.length;
  };

  node.onaudioprocess = (e) => {
    if (paused || failed) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm = downsampleTo16k(input, ctx.sampleRate, carry);
    if (pcm.length === 0) return;
    parts.push(pcm);
    bufferedSamples += pcm.length;
    flush(false);
  };

  const close = () => {
    node.onaudioprocess = null;
    try {
      source.disconnect();
      node.disconnect();
    } catch {
      // すでに外れているときは何もしない
    }
    void ctx.close();
  };

  emit();
  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    async stop() {
      paused = true;
      close();
      flush(true);
      await queue;
      emit();
    },
    abort() {
      paused = true;
      controller.abort();
      close();
    },
  };
}
