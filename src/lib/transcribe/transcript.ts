/**
 * 文字起こしの、音声の区切り方と、結果の整え方（純粋な計算だけ。通信・画面に依存しない）。
 *
 * - 区切り: 約40秒ごとに、前後でいちばん静かな位置で区切る（言葉の途中で切らないため）。最大58秒。
 * - 無音の区切り: 話し声がない区切りは送らない（利用枠を使わない）。
 * - 時間: AIが返すのは文章だけなので、区切りの中の「声がある時間」に、文の長さの割合で時間を割り当てる（目安）。
 */

export interface TranscriptSegment {
  /** 開始（秒） */
  start: number;
  /** 終了（秒） */
  end: number;
  text: string;
}

export interface TimeRange {
  start: number;
  end: number;
}

/** 音の大きさを測る1コマの長さ（秒） */
export const FRAME_SEC = 0.02;

export interface ChunkPlanOptions {
  targetSec: number;
  minSec: number;
  maxSec: number;
}

export const DEFAULT_CHUNK_PLAN: ChunkPlanOptions = { targetSec: 40, minSec: 20, maxSec: 58 };

/** 20ミリ秒ごとの音の大きさ（RMS、0〜1） */
export function frameEnergy(samples: Int16Array, sampleRate: number, frameSec = FRAME_SEC): Float32Array {
  const frame = Math.max(1, Math.round(sampleRate * frameSec));
  const count = Math.ceil(samples.length / frame);
  const out = new Float32Array(count);
  for (let f = 0; f < count; f++) {
    const from = f * frame;
    const to = Math.min(samples.length, from + frame);
    let sum = 0;
    for (let i = from; i < to; i++) {
      const v = samples[i] / 32768;
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / Math.max(1, to - from));
  }
  return out;
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

/** 「声がある」とみなす大きさの境目（雑音の大きさと、大きな声の大きさから決める） */
export function speechThreshold(energy: Float32Array): number {
  const floor = percentile(energy, 0.1);
  const peak = percentile(energy, 0.99);
  const thr = Math.max(0.004, floor * 2.5, floor + (peak - floor) * 0.08);
  // ずっと音が続く録音（無音がほとんどない）では、雑音の大きさ＝声の大きさになるため、
  // 大きな声の半分を上限にして、声を「無音」と見なさない（送らずに取りこぼすのを防ぐ）
  return Math.min(thr, Math.max(0.004, peak * 0.5));
}

/** 区切りの位置を決める（秒の範囲の一覧）。全体が maxSec 以下なら1つ */
export function planChunks(energy: Float32Array, frameSec = FRAME_SEC, options: ChunkPlanOptions = DEFAULT_CHUNK_PLAN): TimeRange[] {
  const total = energy.length * frameSec;
  if (total <= 0) return [];
  const SMOOTH = 10; // 0.2秒の平均で静かさを比べる
  const prefix = new Float64Array(energy.length + 1);
  for (let i = 0; i < energy.length; i++) prefix[i + 1] = prefix[i] + energy[i];
  const smooth = (i: number) => {
    const a = Math.max(0, i - SMOOTH / 2);
    const b = Math.min(energy.length, i + SMOOTH / 2);
    return (prefix[b] - prefix[a]) / Math.max(1, b - a);
  };
  const typical = Math.max(1e-6, percentile(energy, 0.5));
  const chunks: TimeRange[] = [];
  let start = 0;
  while (total - start > options.maxSec) {
    const lo = Math.ceil((start + options.minSec) / frameSec);
    const hi = Math.min(energy.length - 1, Math.floor((start + options.maxSec) / frameSec));
    const target = start + options.targetSec;
    let best = hi;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = lo; i <= hi; i++) {
      // 静かさを優先し、同じくらい静かなら目標の長さに近いほうを選ぶ
      const score = smooth(i) + typical * 0.5 * (Math.abs(i * frameSec - target) / options.targetSec);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    const cut = best * frameSec;
    chunks.push({ start, end: cut });
    start = cut;
  }
  const rest = total - start;
  // 最後が1秒未満なら、前の区切りに足す（前の区切りは最大58秒なので、足しても60秒を超えない）
  if (rest < 1 && chunks.length > 0) chunks[chunks.length - 1].end = total;
  else chunks.push({ start, end: total });
  return chunks;
}

/** 範囲の中の「声がある時間」（範囲の始まりからの秒）。短い切れ目はつなぎ、短すぎる音は除く */
export function voicedRanges(energy: Float32Array, threshold: number, range: TimeRange, frameSec = FRAME_SEC): TimeRange[] {
  const from = Math.max(0, Math.floor(range.start / frameSec));
  const to = Math.min(energy.length, Math.ceil(range.end / frameSec));
  const raw: TimeRange[] = [];
  let open: number | null = null;
  for (let i = from; i < to; i++) {
    const loud = energy[i] >= threshold;
    if (loud && open === null) open = i;
    if (!loud && open !== null) {
      raw.push({ start: (open - from) * frameSec, end: (i - from) * frameSec });
      open = null;
    }
  }
  if (open !== null) raw.push({ start: (open - from) * frameSec, end: (to - from) * frameSec });
  const merged: TimeRange[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < 0.3) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.filter((r) => r.end - r.start >= 0.15);
}

/** 字幕1つの長さの目安（文字）。これより長い文は、読点などで分ける */
const MAX_SEGMENT_CHARS = 36;

function splitLong(sentence: string): string[] {
  if (sentence.length <= MAX_SEGMENT_CHARS) return [sentence];
  const mid = sentence.length / 2;
  let best = -1;
  for (let i = 1; i < sentence.length - 1; i++) {
    const ch = sentence[i];
    if (ch === "、" || ch === "，" || ch === "," || ch === " " || ch === "　") {
      if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
    }
  }
  // 区切りの文字がなければ、真ん中で分ける
  const cut = best > 0 ? best + 1 : Math.ceil(mid);
  return [...splitLong(sentence.slice(0, cut).trim()), ...splitLong(sentence.slice(cut).trim())].filter((s) => s !== "");
}

/** 文章を、字幕に使える長さの文に分ける（句点・疑問符・改行で分け、長い文は読点で分ける） */
export function splitTranscriptText(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/\n+|(?<=[。！？!?])|(?<=[.](?=\s))/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .flatMap(splitLong);
}

/**
 * 区切り1つ分の文字起こしに、時間を割り当てる。
 * 声がある時間をつなげた長さを、文の文字数の割合で分ける（声のない時間には字幕を置かない）。
 */
export function timeSegments(text: string, chunk: TimeRange, voiced: TimeRange[]): TranscriptSegment[] {
  const sentences = splitTranscriptText(text);
  if (sentences.length === 0) return [];
  const duration = Math.max(0.01, chunk.end - chunk.start);
  const ranges = voiced.length > 0 ? voiced : [{ start: 0, end: duration }];
  const speechTotal = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const charsTotal = sentences.reduce((sum, s) => sum + s.length, 0);
  // 「声がある時間」の中での位置（0〜speechTotal）を、区切りの中の時刻に直す
  const toTime = (pos: number): number => {
    let rest = pos;
    for (const r of ranges) {
      const len = r.end - r.start;
      if (rest <= len) return r.start + rest;
      rest -= len;
    }
    return ranges[ranges.length - 1].end;
  };
  const out: TranscriptSegment[] = [];
  let chars = 0;
  for (const s of sentences) {
    const a = (chars / charsTotal) * speechTotal;
    chars += s.length;
    const b = (chars / charsTotal) * speechTotal;
    const start = chunk.start + toTime(a + 1e-6);
    const end = chunk.start + toTime(b);
    out.push({ start: round3(start), end: round3(Math.max(end, start + 0.3)), text: s });
  }
  // 次の字幕と重ならないようにする
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.05, out[i + 1].start);
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** 秒 → 「00:01:23」 */
export function formatClockTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 秒 → SRTの時刻「00:01:23,456」 */
export function formatSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/** 字幕ファイル（SRT） */
export function toSrt(segments: TranscriptSegment[]): string {
  return segments.map((seg, i) => `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`).join("\n");
}

/** 時刻つきの文章（1行に1つ） */
export function toTimestampedText(segments: TranscriptSegment[]): string {
  return segments.map((seg) => `[${formatClockTime(seg.start)}] ${seg.text}`).join("\n");
}

/** 時刻なしの文章（日本語は詰めてつなぎ、ほかの言語は空白でつなぐ。約1分ごとに改行） */
export function toPlainText(segments: TranscriptSegment[]): string {
  const lines: string[] = [];
  let line = "";
  let lineStart = 0;
  for (const seg of segments) {
    if (line !== "" && seg.start - lineStart >= 60) {
      lines.push(line);
      line = "";
    }
    if (line === "") lineStart = seg.start;
    const joiner = line === "" || /[　-鿿＀-￯]$/.test(line) ? "" : " ";
    line += joiner + seg.text;
  }
  if (line !== "") lines.push(line);
  return lines.join("\n\n");
}
