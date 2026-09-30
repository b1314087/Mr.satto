/**
 * 日付・曜日ツール（次工程・軽量便利ツール一括追加）向けの純粋関数群。
 *
 * 外部ライブラリは追加せず、標準の Date オブジェクトだけで実装する
 * （指示書7章: 新しい外部APIを追加しない・既存ライブラリで実現できる場合は
 * それを利用する、の方針に沿い、標準機能で十分なため新規依存も追加しない）。
 *
 * すべてローカルタイムゾーン基準で扱う（サーバーへ送信しないブラウザ内処理のため、
 * ユーザー自身の環境の「今日」の感覚とズレないようにする）。
 */

export const WEEKDAY_NAMES_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "YYYY-MM-DD" 形式の文字列をローカルタイムゾーンの Date（00:00固定）に変換する。
 * "2026-02-30" のような存在しない日付は、Dateの自動繰り上げ（3月2日等になる）を
 * 検知して null を返す（ユーザー入力ミスをそのまま計算してしまわないため）。
 */
export function parseIsoDate(input: string): Date | null {
  const m = ISO_DATE_RE.exec(input.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function formatIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function weekdayNameOf(date: Date): string {
  return WEEKDAY_NAMES_JA[date.getDay()];
}

export function isWeekend(date: Date): boolean {
  const w = date.getDay();
  return w === 0 || w === 6;
}

/** days に負の値を渡すと過去方向へずらす（「○日後」「○日前」を1つの関数で扱う） */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * 月初・月末は Date のロールオーバーに任せる（うるう年の2月29日/28日も
 * 自動的に正しく計算される。day=0 は「前月の末日」を意味するDateの仕様を利用）。
 */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

const MAX_LIST_DAYS = 3660; // 約10年分。無制限の範囲指定による重い処理を避ける安全弁

/** start〜end（両端含む）の日付一覧を返す。endがstartより前の場合はエラーにする */
export function listDatesInRange(start: Date, end: Date): Date[] {
  if (end.getTime() < start.getTime()) {
    throw new Error("終了日は開始日以降の日付にしてください");
  }
  const totalDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (totalDays > MAX_LIST_DAYS) {
    throw new Error("期間が長すぎます（最大 約10年分 までにしてください）");
  }
  const dates: Date[] = [];
  for (let i = 0; i <= totalDays; i++) {
    dates.push(addDays(start, i));
  }
  return dates;
}

/**
 * 営業日（土日を除く）ベースで count 日後/前を計算する。
 * 祝日は考慮しない（指示書が明示する範囲「土日を除外」ベースのみに限定し、
 * 祝日カレンダーという別領域の複雑な機能を無理に追加しない）。
 */
export function addBusinessDays(date: Date, count: number): Date {
  if (!Number.isFinite(count) || !Number.isInteger(count)) {
    throw new Error("営業日数は整数で入力してください");
  }
  const step = count >= 0 ? 1 : -1;
  let remaining = Math.abs(count);
  let result = new Date(date);
  while (remaining > 0) {
    result = addDays(result, step);
    if (!isWeekend(result)) remaining--;
  }
  return result;
}
