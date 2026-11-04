/// <reference lib="webworker" />
/**
 * Worker の中で、画面からの依頼を受けて返事をする共通の仕組み（ロードマップC 工程3。worker-channel.ts と組で使う）。
 * handler が { value, transfer } を返すと、transfer に入れた物（ArrayBuffer・Blob 以外の大きなデータ）を複製せずに画面へ渡す。
 * handler が WorkerUnsupported を投げると「この環境の Worker ではできない」と返し、画面側の処理に切り替えてもらう。
 */

export class WorkerUnsupported extends Error {}

export interface ServeResult {
  value: unknown;
  transfer?: Transferable[];
}

export function serveWorker<Req>(handler: (req: Req, progress: (p: number) => void) => Promise<ServeResult>) {
  const ctx = self as unknown as DedicatedWorkerGlobalScope;
  ctx.onmessage = async (e: MessageEvent<{ id: number; req: Req }>) => {
    const { id, req } = e.data;
    try {
      const { value, transfer = [] } = await handler(req, (p) => ctx.postMessage({ id, type: "progress", progress: p }));
      ctx.postMessage({ id, type: "done", value }, transfer);
    } catch (err) {
      if (err instanceof WorkerUnsupported) ctx.postMessage({ id, type: "unsupported", reason: err.message });
      else ctx.postMessage({ id, type: "error", message: err instanceof Error ? err.message : "処理に失敗しました。" });
    }
  };
}
