import { WorkerCanceledError, WorkerChannel, WorkerUnavailableError } from "@/lib/workers/worker-channel";
import { modelInputFrom, renderRemovedPng, runMaskModel, type RemoveRenderOptions } from "./background-remove";
import type { BgRemoveRequest } from "./background-remove.worker";

/**
 * 背景除去の「推論」と「書き出し」を、できれば Worker で、使えなければ従来どおり画面側で行う（ロードマップC 工程3）。
 * - AIのモデルは Worker の中に読み込んだまま、同じページの中で使い回す（1枚ごとに約19MBを読み直さないため）。
 *   画面を離れるとき（dispose）に Worker を終了させ、モデルのメモリも解放する。
 * - 書き出しを止めると、Worker ごと終了させる（AIの計算・全画素の計算は途中で止められないため）。次の依頼では作り直す。
 * - Worker が使えないと分かったら、それ以降は画面側で行う（結果は同じ。同じ関数を使っている）。
 */

export type RemoveEngineKind = "worker" | "main";

export class BgRemoveEngine {
  private channel: WorkerChannel<BgRemoveRequest> | null = null;
  private workerUsable: boolean;
  /** 最後にどちらで処理したか（テスト・調査用） */
  lastEngine: RemoveEngineKind | null = null;

  constructor() {
    this.workerUsable =
      typeof Worker !== "undefined" &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof createImageBitmap === "function" &&
      (globalThis as { __mrsattoNoWorker?: boolean }).__mrsattoNoWorker !== true;
  }

  private getChannel() {
    this.channel ??= new WorkerChannel<BgRemoveRequest>(
      () => new Worker(new URL("./background-remove.worker.ts", import.meta.url), { type: "module", name: "mrsatto-bg-remove" })
    );
    return this.channel;
  }

  /** 画像からAIマスク（320×320）を推論する */
  async predict(source: CanvasImageSource, signal?: AbortSignal): Promise<Uint8ClampedArray> {
    const input = modelInputFrom(source);
    if (this.workerUsable) {
      try {
        const mask = await this.getChannel().request<Uint8ClampedArray>({ type: "predict", input }, { transfer: [input.buffer], signal });
        this.lastEngine = "worker";
        return mask;
      } catch (e) {
        if (!(e instanceof WorkerUnavailableError)) throw e;
        this.workerUsable = false;
        // input は Worker に渡して使えなくなっている可能性があるので、作り直す
        return this.predictOnMain(source, signal);
      }
    }
    return this.predictOnMain(source, signal);
  }

  private async predictOnMain(source: CanvasImageSource, signal?: AbortSignal) {
    if (signal?.aborted) throw new WorkerCanceledError();
    const mask = await runMaskModel(modelInputFrom(source));
    if (signal?.aborted) throw new WorkerCanceledError();
    this.lastEngine = "main";
    return mask;
  }

  /** 元の解像度で背景を透明にした PNG を作る */
  async render(img: HTMLImageElement, opts: RemoveRenderOptions, signal?: AbortSignal): Promise<Blob> {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (this.workerUsable) {
      // 画像は、向き（EXIF）を反映した表示どおりの絵として渡す（画面側の描き方と同じ）。渡したあとは画面側では使わない
      const bitmap = await createImageBitmap(img);
      try {
        const blob = await this.getChannel().request<Blob>({ type: "render", bitmap, opts }, { transfer: [bitmap], signal });
        this.lastEngine = "worker";
        return blob;
      } catch (e) {
        if (!(e instanceof WorkerUnavailableError)) throw e;
        this.workerUsable = false;
      } finally {
        bitmap.close();
      }
    }
    if (signal?.aborted) throw new WorkerCanceledError();
    const blob = await renderRemovedPng(img, w, h, opts);
    if (signal?.aborted) throw new WorkerCanceledError();
    this.lastEngine = "main";
    return blob;
  }

  /** 使い終わったら呼ぶ（Worker と、その中のAIのモデルを解放する） */
  dispose() {
    this.channel?.dispose();
    this.channel = null;
  }
}
