import { WorkerCanceledError, WorkerChannel, WorkerUnavailableError } from "@/lib/workers/worker-channel";
import { renderRemovedPng, type RemoveRenderOptions } from "./background-remove";
import type { BgRemoveRequest } from "./background-remove.worker";

/**
 * 背景除去の「書き出し」（元の解像度での全画素の計算・PNG化）を、できれば Worker で、使えなければ従来どおり画面側で行う（ロードマップC 工程3）。
 * - 画面を離れるとき（dispose）に Worker を終了させる。
 * - 書き出しを止めると、Worker ごと終了させる（全画素の計算は途中で止められないため）。次の依頼では作り直す。
 * - Worker が使えないと分かったら、それ以降は画面側で行う（結果は同じ。同じ関数を使っている）。
 * （AIによる背景の判定は、工程2で削除した）
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

  /** 使い終わったら呼ぶ（Worker を終了させる） */
  dispose() {
    this.channel?.dispose();
    this.channel = null;
  }
}
