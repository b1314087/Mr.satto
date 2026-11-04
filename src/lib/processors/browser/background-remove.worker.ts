/// <reference lib="webworker" />
import { renderRemovedPng, runMaskModel, type RemoveRenderOptions } from "./background-remove";
import { serveWorker, WorkerUnsupported } from "@/lib/workers/worker-serve";

/**
 * 背景除去の重い計算を、画面とは別の処理（Web Worker）で行う（ロードマップC 工程3）。
 * - predict：AI（U²-Net・onnxruntime-web）でマスクを推論する（AIのモデルは、この Worker の中に読み込んだまま使い回す）
 * - render：元の解像度で、マスクの拡大・透明度の計算（全画素）・PNG化を行う
 * 計算の方法は、画面側（background-remove.ts）とまったく同じ関数を使う。画像は外部へ送らない。
 */

export type BgRemoveRequest =
  | { type: "predict"; input: Float32Array }
  | { type: "render"; bitmap: ImageBitmap; opts: RemoveRenderOptions };

serveWorker<BgRemoveRequest>(async (req) => {
  if (typeof OffscreenCanvas === "undefined" || typeof WebAssembly === "undefined") {
    throw new WorkerUnsupported("worker-no-offscreen-canvas");
  }
  if (req.type === "predict") {
    const mask = await runMaskModel(req.input);
    return { value: mask, transfer: [mask.buffer] };
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
