import type { Keyframe, TrackPoint } from "./mosaic-regions";

/**
 * 動画モザイクの追跡を Web Worker（画面とは別の処理）で行うときの、やりとりの形（工程4）。
 * 動画のファイル（File）はそのまま渡す（中身は複製されない）。結果の位置は、数値の配列にまとめて、
 * 複製せずに渡す（Transferable）。
 */

export interface TrackJob {
  type: "track";
  file: File;
  width: number;
  height: number;
  durationSec: number;
  frameRate: number;
  anchor: Keyframe;
  keyframes: Keyframe[];
  direction: "both" | "forward";
  from: number | null;
  to: number | null;
}

export type ToWorker = TrackJob | { type: "cancel" };

export type FromWorker =
  /** 動画を開いて、追跡を始められる状態になった */
  | { type: "ready" }
  /** この環境の Worker では動画を読めない（画面側の処理に切り替える） */
  | { type: "unsupported"; reason: string }
  | { type: "progress"; progress: number }
  /** 結果：1点につき t, x, y, w, h, score の6つの数 */
  | { type: "done"; points: Float64Array }
  | { type: "canceled" }
  | { type: "error"; message: string };

const FIELDS = 6;

export function packPoints(points: TrackPoint[]): Float64Array {
  const a = new Float64Array(points.length * FIELDS);
  points.forEach((p, i) => {
    a.set([p.t, p.x, p.y, p.w, p.h, p.score], i * FIELDS);
  });
  return a;
}

export function unpackPoints(a: Float64Array): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let i = 0; i + FIELDS <= a.length; i += FIELDS) {
    out.push({ t: a[i], x: a[i + 1], y: a[i + 2], w: a[i + 3], h: a[i + 4], score: a[i + 5] });
  }
  return out;
}
