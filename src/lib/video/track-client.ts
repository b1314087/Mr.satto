import type { InputVideoTrack } from "mediabunny";
import { trackRegion, type TrackParams } from "./track";
import { VideoCanceledByUserError } from "./shared";
import { unpackPoints, type FromWorker, type TrackJob } from "./track-protocol";
import type { TrackPoint } from "./mosaic-regions";

/**
 * 動画モザイクの追跡を、できれば Web Worker（画面とは別の処理）で行う（工程4）。
 *
 * - Worker が使えない・Worker の中で動画を読めない環境では、従来どおり画面側（track.ts の trackRegion）で行う。
 *   どちらでも計算の方法は同じなので、結果は変わらない。
 * - 止めるとき：Worker に停止を頼み、少し待っても止まらなければ、Worker ごと終了させる。
 * - 終わったら（成功・失敗・停止のどれでも）、Worker を終了させて、メモリを解放する。
 */

export type TrackEngine = "worker" | "main";

export interface TrackInBackgroundParams extends Omit<TrackParams, "videoTrack"> {
  file: File;
  /** 画面側で追跡するとき（Worker が使えないとき）に使う映像トラック */
  videoTrack: InputVideoTrack;
  /** どちらで追跡したかを知らせる（画面の表示・テスト用） */
  onEngine?: (engine: TrackEngine) => void;
}

/** 停止を頼んでから、Worker を強制終了するまでの時間（ミリ秒） */
export const CANCEL_GRACE_MS = 1500;

/** テスト用：true にすると、Worker を使わずに画面側で追跡する（結果が同じかを比べるため） */
declare global {
  var __mrsattoTrackOnMainThread: boolean | undefined;
}

export function canUseTrackWorker(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && globalThis.__mrsattoTrackOnMainThread !== true;
}

function createWorker(): Worker {
  return new Worker(new URL("./track.worker.ts", import.meta.url), { type: "module", name: "mrsatto-mosaic-track" });
}

/** Worker で追跡する。Worker を使えないと分かったら null を返す（画面側に切り替える） */
function trackInWorker(p: TrackInBackgroundParams): Promise<TrackPoint[] | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = createWorker();
    } catch {
      resolve(null);
      return;
    }
    let ready = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      p.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = () => {
      worker.postMessage({ type: "cancel" });
      // 停止を受け取れない状態が続くときは、Worker ごと終了させる
      killTimer = setTimeout(() => finish(() => reject(new VideoCanceledByUserError("追跡を止めました。"))), CANCEL_GRACE_MS);
    };
    if (p.signal?.aborted) {
      finish(() => reject(new VideoCanceledByUserError("追跡を止めました。")));
      return;
    }
    p.signal?.addEventListener("abort", onAbort);

    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === "ready") {
        ready = true;
        p.onEngine?.("worker");
      } else if (m.type === "unsupported") finish(() => resolve(null));
      else if (m.type === "progress") p.onProgress?.(m.progress);
      else if (m.type === "done") finish(() => resolve(unpackPoints(m.points)));
      else if (m.type === "canceled") finish(() => reject(new VideoCanceledByUserError("追跡を止めました。")));
      else if (m.type === "error") finish(() => reject(new Error(m.message)));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      // 始まる前の失敗（Worker の読み込みに失敗など）は、画面側に切り替える。始まったあとの失敗は、エラーとして伝える
      if (!ready) finish(() => resolve(null));
      else finish(() => reject(new Error("追跡の途中で問題が起きました。もう一度お試しください。")));
    };

    const job: TrackJob = {
      type: "track",
      file: p.file,
      width: p.width,
      height: p.height,
      durationSec: p.durationSec,
      frameRate: p.frameRate,
      anchor: p.anchor,
      keyframes: p.keyframes,
      direction: p.direction,
      from: p.from ?? null,
      to: p.to ?? null,
    };
    worker.postMessage(job);
  });
}

/** 追跡する（Worker が使えれば Worker、使えなければ画面側） */
export async function trackRegionInBackground(p: TrackInBackgroundParams): Promise<TrackPoint[]> {
  if (canUseTrackWorker()) {
    const result = await trackInWorker(p);
    if (result) return result;
    if (p.signal?.aborted) throw new VideoCanceledByUserError("追跡を止めました。");
  }
  p.onEngine?.("main");
  return trackRegion(p);
}
