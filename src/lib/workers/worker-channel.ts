/**
 * 重い計算を、画面とは別の処理（Web Worker）で行うための、画面側の共通の呼び出し（ロードマップC 工程3）。
 *
 * 動画モザイク（工程4・track-client.ts）と同じ考え方で、次をまとめて扱う：
 * - Worker を作る・終わらせる（dispose。使い終わったら必ず呼ぶ）
 * - 依頼（request）ごとに番号を付け、その返事だけを受け取る
 * - 進み具合の受け取り
 * - キャンセル：Worker ごと終了させる（AIの計算やExcelの作成は途中で止められないため、その場で終わらせるのがいちばん確実）
 * - Worker が使えない（作れない・読み込めない・中で必要な機能がない）ときは WorkerUnavailableError を投げる。
 *   呼び出し側は、これを受けたら従来どおり画面側で処理する
 * Worker の中身（何を計算するか）は、用途ごとに別のファイルにする（共通にするのは、この呼び出し方だけ）。
 */

export class WorkerUnavailableError extends Error {
  constructor(message = "この環境では、別の処理（Worker）を使えません。") {
    super(message);
    this.name = "WorkerUnavailableError";
  }
}

export class WorkerCanceledError extends Error {
  constructor(message = "処理を止めました。") {
    super(message);
    this.name = "WorkerCanceledError";
  }
}

/** Worker から画面への返事の形（worker-serve.ts と同じ） */
export type WorkerReply =
  | { id: number; type: "progress"; progress: number }
  | { id: number; type: "done"; value: unknown }
  | { id: number; type: "error"; message: string }
  | { id: number; type: "unsupported"; reason: string };

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number) => void;
}

export class WorkerChannel<Req> {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** 一度でも返事が来たか（来る前に Worker 自体が壊れたら「使えない」とみなす） */
  private answered = false;
  private disposed = false;

  constructor(private create: () => Worker) {}

  private ensure(): Worker {
    if (this.disposed) throw new WorkerCanceledError();
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") throw new WorkerUnavailableError();
    let w: Worker;
    try {
      w = this.create();
    } catch {
      throw new WorkerUnavailableError();
    }
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") {
        p.onProgress?.(m.progress);
        return;
      }
      this.answered = true;
      this.pending.delete(m.id);
      if (m.type === "done") p.resolve(m.value);
      else if (m.type === "unsupported") p.reject(new WorkerUnavailableError(m.reason));
      else p.reject(new Error(m.message));
    };
    w.onerror = (e) => {
      e.preventDefault();
      // 返事が来る前の失敗（読み込みに失敗など）は「使えない」。来たあとの失敗は、エラーとして伝える
      const err = this.answered ? new Error("処理の途中で問題が起きました。もう一度お試しください。") : new WorkerUnavailableError();
      this.failAll(err);
      this.terminate();
    };
    this.worker = w;
    return w;
  }

  /** Worker に依頼する。transfer に入れた物（ArrayBuffer・ImageBitmap など）は、渡したあと画面側では使えなくなる */
  request<Res>(req: Req, options: { transfer?: Transferable[]; signal?: AbortSignal; onProgress?: (p: number) => void } = {}): Promise<Res> {
    const { transfer = [], signal, onProgress } = options;
    if (signal?.aborted) return Promise.reject(new WorkerCanceledError());
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      const onAbort = () => {
        // 途中で止められない計算のため、Worker ごと終了させる（残りの依頼も止める）
        this.failAll(new WorkerCanceledError());
        this.terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v as Res);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        onProgress,
      });
      try {
        w.postMessage({ id, req }, transfer);
      } catch {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new WorkerUnavailableError());
      }
    });
  }

  private failAll(err: Error) {
    const list = [...this.pending.values()];
    this.pending.clear();
    for (const p of list) p.reject(err);
  }

  private terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.answered = false;
  }

  /** 使い終わったら呼ぶ。Worker を終了させ、中のメモリ（AIのモデルなど）を解放する。処理中の依頼は止める */
  dispose() {
    this.disposed = true;
    this.failAll(new WorkerCanceledError());
    this.terminate();
  }
}
