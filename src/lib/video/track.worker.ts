/// <reference lib="webworker" />
import { Input, BlobSource, ALL_FORMATS } from "mediabunny";
import { trackRegion } from "./track";
import { VideoCanceledByUserError } from "./shared";
import { packPoints, type FromWorker, type ToWorker } from "./track-protocol";

/**
 * 動画モザイクの追跡を、画面とは別の処理（Web Worker）で行う（工程4）。
 * 動画の読み取り（WebCodecs）・縮小・明るさの計算・テンプレートマッチングを、すべてここで行うため、
 * 追跡している間も、画面の操作（再生・スクロール・ボタン）が固まらない。計算の方法は画面側と同じ（track.ts）。
 * 動画はブラウザの外へ送らない。終わったら、画面側がこの Worker を終了させ、メモリを解放する。
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let controller: AbortController | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []) {
  ctx.postMessage(msg, transfer);
}

ctx.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    controller?.abort();
    return;
  }
  if (typeof OffscreenCanvas === "undefined" || typeof VideoDecoder === "undefined") {
    post({ type: "unsupported", reason: "worker-no-webcodecs" });
    return;
  }
  controller = new AbortController();
  const input = new Input({ source: new BlobSource(msg.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      post({ type: "unsupported", reason: "worker-cannot-decode" });
      return;
    }
    post({ type: "ready" });
    let lastSent = 0;
    const points = await trackRegion({
      videoTrack: track,
      width: msg.width,
      height: msg.height,
      durationSec: msg.durationSec,
      frameRate: msg.frameRate,
      anchor: msg.anchor,
      keyframes: msg.keyframes,
      direction: msg.direction,
      from: msg.from,
      to: msg.to,
      signal: controller.signal,
      onProgress: (p) => {
        // 進み具合は、1%ごとに知らせる（やりとりを増やしすぎない）
        if (p - lastSent >= 0.01 || p >= 1) {
          lastSent = p;
          post({ type: "progress", progress: p });
        }
      },
    });
    const packed = packPoints(points);
    post({ type: "done", points: packed }, [packed.buffer]);
  } catch (err) {
    if (err instanceof VideoCanceledByUserError || controller?.signal.aborted) post({ type: "canceled" });
    else post({ type: "error", message: err instanceof Error ? err.message : "追跡できませんでした。" });
  } finally {
    input.dispose();
    controller = null;
  }
};
