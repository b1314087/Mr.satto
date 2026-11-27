/**
 * 動画の再生速度変更（2026-11-27）の設定。画面（video-speed-tool）と処理（video-speed processor）の両方から使う。
 */

/** 選べる速さ（ボタン）。自由な数字の入力は、SPEED_MIN〜SPEED_MAX の範囲で受け付ける */
export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.25, 1.5, 2, 3, 4] as const;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
/** 初期値 */
export const DEFAULT_SPEED = 2;

/** 変えられる元の動画の長さの上限（秒）。音声をまとめて計算するため、ブラウザのメモリに収まる長さにする */
export const SPEED_MAX_SOURCE_SECONDS = 10 * 60;

/** 速さとして使える数字か（範囲内で、1倍ちょうどではない） */
export function isValidSpeed(speed: number): boolean {
  return Number.isFinite(speed) && speed >= SPEED_MIN && speed <= SPEED_MAX && Math.abs(speed - 1) > 1e-6;
}

/** 書き出すフレームレート：元の動画に合わせ、24〜60fps に収める（元が不明なら30fps） */
export function speedOutputFps(sourceFps: number | null | undefined): number {
  if (!sourceFps || !Number.isFinite(sourceFps)) return 30;
  return Math.max(24, Math.min(60, Math.round(sourceFps)));
}

/** 速さの表示（「2倍速」「0.5倍（ゆっくり）」） */
export function speedLabel(speed: number): string {
  const n = Math.round(speed * 100) / 100;
  return speed > 1 ? `${n}倍速` : `${n}倍（ゆっくり）`;
}

/** 速さを変えたあとの長さ（秒） */
export function speedDuration(durationSec: number, speed: number): number {
  return durationSec / speed;
}
