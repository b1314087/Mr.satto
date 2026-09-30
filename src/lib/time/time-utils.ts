/**
 * 時間計算ツール（次工程・軽量便利ツール一括追加 Tool 2）向けの純粋関数群。
 * 時刻は分単位の整数で内部表現し、丸め誤差を避ける。
 */

export interface TimeOfDay {
  h: number;
  m: number;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** "H:MM" / "HH:MM" 形式（0:00〜23:59）をパースする。不正な形式・範囲外は null */
export function parseTimeStr(input: string): TimeOfDay | null {
  const m = TIME_RE.exec(input.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

export function toMinutesOfDay(t: TimeOfDay): number {
  return t.h * 60 + t.m;
}

export function formatTimeOfDay(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 「7時間30分」のような表示用ラベルを生成する（負の値には先頭に "-" を付ける） */
export function minutesToDurationLabel(totalMinutes: number): string {
  const sign = totalMinutes < 0 ? "-" : "";
  const abs = Math.round(Math.abs(totalMinutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}時間${m}分`;
}

export function minutesToDecimalHours(totalMinutes: number): number {
  return Math.round((totalMinutes / 60) * 100) / 100;
}

export function decimalHoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

/**
 * 開始〜終了の差（分）を計算する。終了時刻が開始時刻より前の場合は
 * 「日付をまたいだ」とみなし、24時間を加算する（可能な範囲での日またぎ対応）。
 */
export function diffMinutes(start: TimeOfDay, end: TimeOfDay): number {
  let diff = toMinutesOfDay(end) - toMinutesOfDay(start);
  if (diff < 0) diff += 24 * 60;
  return diff;
}
