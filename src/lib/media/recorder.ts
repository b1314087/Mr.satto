/**
 * 録音・画面録画の共通部品（2026-11-18）。ブラウザの MediaRecorder で録って、ファイル（Blob）にする。
 * 録ったデータはブラウザのメモリの中だけにあり、サーバーへは送らない。
 */

/** 録音に使う形式の候補（上から順に、このブラウザで使えるものを選ぶ） */
export const AUDIO_RECORD_TYPES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];

/** 画面録画に使う形式の候補（MP4 を先に。使えなければ WebM） */
export const VIDEO_RECORD_TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickRecordType(candidates: string[]): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const t of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      // 判定できない形式は飛ばす
    }
  }
  return null;
}

/** 形式（MIMEタイプ）から、保存するファイルの拡張子を決める */
export function extensionForType(type: string): string {
  const t = type.toLowerCase();
  if (t.startsWith("audio/mp4")) return "m4a";
  if (t.startsWith("video/mp4")) return "mp4";
  if (t.startsWith("audio/ogg")) return "ogg";
  if (t.startsWith("audio/webm") || t.startsWith("video/webm")) return "webm";
  if (t.startsWith("audio/wav")) return "wav";
  return "bin";
}

/** 「録音_20261118-2105」のような、日時入りのファイル名の本体 */
export function timestampName(prefix: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/** 秒を「1:02:03」「2:03」の形にする */
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 録っている時間を、一時停止の間を除いて数える */
export class RecordingClock {
  private startedAt: number | null = null;
  private accumulated = 0;
  start(now = performance.now()) {
    this.startedAt = now;
  }
  pause(now = performance.now()) {
    if (this.startedAt !== null) this.accumulated += now - this.startedAt;
    this.startedAt = null;
  }
  reset() {
    this.startedAt = null;
    this.accumulated = 0;
  }
  elapsedSec(now = performance.now()): number {
    return (this.accumulated + (this.startedAt !== null ? now - this.startedAt : 0)) / 1000;
  }
}

/** マイク・画面の使用を断られたときなどのエラーを、分かりやすい言葉にする */
export function friendlyMediaError(e: unknown, what: "マイク" | "画面" | "カメラ"): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return `${what}の使用が許可されませんでした。ブラウザのアドレス欄の左にある設定から、${what}の使用を許可してください。`;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return `使える${what}が見つかりませんでした。つながっているか確かめてください。`;
  if (name === "NotReadableError") return `${what}をほかのアプリが使っている可能性があります。ほかのアプリを閉じてから、もう一度お試しください。`;
  if (name === "AbortError") return `${what}の選択が取り消されました。`;
  return `${what}を使えませんでした。ページを読み込み直してから、もう一度お試しください。`;
}

/** 動いている入力（マイク・カメラ・画面）を、すべて止める */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}
