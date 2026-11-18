/**
 * AI文字起こし（OpenAI gpt-transcribe）の、画面とサーバーで共通の決めごと・計算（通信も保存もしない）。
 *
 * 流れ（全体）:
 *   ブラウザ: 音声・動画を 16kHz・モノラルのWAVに変換 → 無音の位置で約40秒ごとに区切る → 1区切りずつサーバーへ送る
 *   サーバー: 権限・同意の確認 → WAVの形式と長さを自分で確かめる → 長さから利用枠を予約 → OpenAIへ送る → 長さで確定
 *
 * 料金: gpt-transcribe は音声1分あたり 0.0045ドル（2026-11-18 時点の公式の単価）。
 *   = 1秒あたり 75 µUSD。長さはブラウザの申告ではなく、サーバーがWAVのヘッダーとデータ量から計算する。
 *   単価が変わったら TRANSCRIBE_MICRO_USD_PER_SECOND と TRANSCRIBE_PRICE_VERSION を更新する。
 */
import { RESERVE_MARGIN_PERCENT, microUsdToAiTokens } from "./pricing";

export const TRANSCRIBE_CONSENT_VERSION = "2026-11-18-transcribe";
export const TRANSCRIBE_MODEL_ID = "gpt-transcribe";
export const TRANSCRIBE_PRICE_VERSION = "2026-11-18";
/** 1秒あたりの費用（µUSD）。0.0045ドル/分 ÷ 60 = 0.000075ドル/秒 */
export const TRANSCRIBE_MICRO_USD_PER_SECOND = 75;

/** 送る音声の形式（ブラウザで変換する。サーバーはこの形式だけを受け付ける） */
export const TRANSCRIBE_SAMPLE_RATE = 16_000;
/** 1回に送る音声の上限（秒）。区切りは最大58秒にするので、少し余裕を持たせる */
export const TRANSCRIBE_MAX_CHUNK_SECONDS = 60.5;
/** 短すぎる音声は送らない（秒） */
export const TRANSCRIBE_MIN_CHUNK_SECONDS = 0.1;
/** 1回の文字起こしで扱える長さの上限（秒）。ブラウザのメモリと利用枠の使いすぎを防ぐ */
export const TRANSCRIBE_MAX_TOTAL_SECONDS = 120 * 60;
/** 1回に送る本文の上限（バイト）。60.5秒のWAV（約1.94MB）＋フォームの項目。Vercelの上限（約4.5MB）より十分小さい */
export const TRANSCRIBE_MAX_BODY_BYTES = 2_100_000;

/** 用語（固有名詞など）の入力の上限（文字） */
export const TRANSCRIBE_MAX_TERMS_CHARS = 300;
/** AIへ渡すヒント（用語＋直前の文字起こしの末尾）の上限（文字） */
export const TRANSCRIBE_MAX_PROMPT_CHARS = 600;
/** 直前の区切りの文字起こしから、ヒントとして渡す末尾の長さ（文字） */
const PREVIOUS_TAIL_CHARS = 200;

export type TranscribeLanguage = "auto" | "ja" | "en" | "zh" | "ko";
export const TRANSCRIBE_LANGUAGES: { value: TranscribeLanguage; label: string }[] = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "英語" },
  { value: "zh", label: "中国語" },
  { value: "ko", label: "韓国語" },
  { value: "auto", label: "自動で判断" },
];

export function isTranscribeLanguage(v: unknown): v is TranscribeLanguage {
  return v === "auto" || v === "ja" || v === "en" || v === "zh" || v === "ko";
}

// ---------------------------------------------------------------------------
// 料金
// ---------------------------------------------------------------------------

/** 音声の長さ（秒）から、費用（µUSD、整数・切り上げ） */
export function transcribeCostMicroUsd(seconds: number): number {
  return Math.ceil(Math.max(0, seconds) * TRANSCRIBE_MICRO_USD_PER_SECOND);
}

/** 呼び出し前に予約する額（µUSD）。費用に余裕（%）を足し、最低でも1秒分 */
export function transcribeReserveMicroUsd(seconds: number): number {
  return Math.max(TRANSCRIBE_MICRO_USD_PER_SECOND, Math.ceil((transcribeCostMicroUsd(seconds) * RESERVE_MARGIN_PERCENT) / 100));
}

/** 画面に出す目安（AIトークン）。無音で送らない区切りがあると、実際はこれより少なくなる */
export function estimateTranscribeAiTokens(seconds: number): number {
  return microUsdToAiTokens(transcribeCostMicroUsd(seconds));
}

// ---------------------------------------------------------------------------
// WAV（16bit PCM）の読み書き
// ---------------------------------------------------------------------------

export type WavInfo =
  | { ok: true; sampleRate: number; channels: number; bitsPerSample: number; dataOffset: number; dataBytes: number; durationSec: number }
  | { ok: false; message: string };

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * WAVのヘッダーを読む（16bit PCMだけ）。中身の音声は読まない。
 * 余計なチャンク（LIST など）は飛ばす。データの長さは、実際のバイト数を超えないように切り詰める。
 */
export function parseWavPcm16(bytes: Uint8Array): WavInfo {
  if (bytes.length < 44 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") return { ok: false, message: "WAV形式ではありません。" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) return { ok: false, message: "WAVの形式情報が壊れています。" };
      fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!fmt) return { ok: false, message: "WAVの形式情報がありません。" };
      // 1 = PCM、0xFFFE = 拡張形式（中身がPCMのときに使われる）
      if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.bits !== 16) return { ok: false, message: "16bit PCMのWAVではありません。" };
      if (fmt.channels < 1 || fmt.sampleRate < 1) return { ok: false, message: "WAVの形式情報が正しくありません。" };
      const available = bytes.length - body;
      const frameBytes = fmt.channels * 2;
      const dataBytes = Math.floor(Math.min(size, available) / frameBytes) * frameBytes;
      return {
        ok: true,
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: 16,
        dataOffset: body,
        dataBytes,
        durationSec: dataBytes / frameBytes / fmt.sampleRate,
      };
    }
    offset = body + size + (size % 2);
  }
  return { ok: false, message: "WAVに音声のデータがありません。" };
}

/** 16bit・モノラルのサンプルから、WAVファイルの中身を作る */
export function encodeWavPcm16Mono(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/** サーバーで受け付ける音声か（16kHz・モノラル・16bit、長さが範囲内） */
export function validateTranscribeAudio(bytes: Uint8Array): { ok: true; durationSec: number } | { ok: false; message: string } {
  const wav = parseWavPcm16(bytes);
  if (!wav.ok) return { ok: false, message: wav.message };
  if (wav.sampleRate !== TRANSCRIBE_SAMPLE_RATE || wav.channels !== 1) return { ok: false, message: "音声の形式が正しくありません。" };
  if (wav.durationSec < TRANSCRIBE_MIN_CHUNK_SECONDS) return { ok: false, message: "音声が短すぎます。" };
  if (wav.durationSec > TRANSCRIBE_MAX_CHUNK_SECONDS) return { ok: false, message: "1回に送る音声が長すぎます。" };
  return { ok: true, durationSec: wav.durationSec };
}

// ---------------------------------------------------------------------------
// 依頼の項目
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 制御文字（改行・タブ以外）は送らない
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface TranscribeFields {
  requestId: string;
  language: TranscribeLanguage;
  prompt: string;
}

/** フォームの項目（文字だけ）を確かめる。音声は validateTranscribeAudio で確かめる */
export function validateTranscribeFields(raw: { requestId?: unknown; language?: unknown; prompt?: unknown }): { ok: true; value: TranscribeFields } | { ok: false; message: string } {
  if (typeof raw.requestId !== "string" || !UUID_RE.test(raw.requestId)) return { ok: false, message: "依頼の番号が正しくありません。" };
  const language = raw.language === undefined || raw.language === "" ? "ja" : raw.language;
  if (!isTranscribeLanguage(language)) return { ok: false, message: "言語の指定が正しくありません。" };
  const prompt = typeof raw.prompt === "string" ? raw.prompt.replace(CONTROL_RE, "") : "";
  if (prompt.length > TRANSCRIBE_MAX_PROMPT_CHARS) return { ok: false, message: "用語のヒントが長すぎます。" };
  return { ok: true, value: { requestId: raw.requestId.toLowerCase(), language, prompt } };
}

/**
 * AIへ渡すヒント（文字起こしの精度を上げるための文脈）を作る。
 * 用語（利用者が入力した固有名詞など）と、直前の区切りの文字起こしの末尾（文のつながりのため）。
 */
export function buildTranscribePrompt(terms: string, previousText: string): string {
  const cleanTerms = terms.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim().slice(0, TRANSCRIBE_MAX_TERMS_CHARS);
  const tail = previousText.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim().slice(-PREVIOUS_TAIL_CHARS);
  const parts: string[] = [];
  if (cleanTerms) parts.push(`用語: ${cleanTerms}`);
  if (tail) parts.push(tail);
  return parts.join("\n").slice(0, TRANSCRIBE_MAX_PROMPT_CHARS);
}
