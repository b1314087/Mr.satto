/// <reference lib="webworker" />
import { renderRemovedPng, type RemoveRenderOptions } from "./background-remove";
import { serveWorker, WorkerUnsupported } from "@/lib/workers/worker-serve";

/**
 * 背景除去の重い計算を、画面とは別の処理（Web Worker）で行う（ロードマップC 工程3）。
 * - render：元の解像度で、透明度の計算（全画素）・PNG化を行う
 * 計算の方法は、画面側（background-remove.ts）とまったく同じ関数を使う。画像は外部へ送らない。
 * （AIによる背景の判定は、工程2で削除した）
 */

export type BgRemoveRequest = { type: "render"; bitmap: ImageBitmap; opts: RemoveRenderOptions };

serveWorker<BgRemoveRequest>(async (req) => {
  if (typeof OffscreenCanvas === "undefined") {
    throw new WorkerUnsupported("worker-no-offscreen-canvas");
  }
  const { bitmap, opts } = req;
  try {
    const blob = await renderRemovedPng(bitmap, bitmap.width, bitmap.height, opts);
    return { value: blob };
  } finally {
    // 受け取った画像は、使い終わったらすぐ手放す
    bitmap.close();
  }
});
