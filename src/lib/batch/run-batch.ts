/**
 * 複数ファイルを1つずつ順番に処理する（一括処理の共通部分）。
 *
 * - 同時に処理するのは1ファイルだけ（メモリの使いすぎ・ブラウザの停止を防ぐ）。
 * - 1つのファイルで失敗しても、ほかのファイルの処理は続ける。
 * - 状態が変わるたびに onUpdate を呼ぶ（ファイルごとの「待機中・処理中・完了・失敗」の表示に使う）。
 */

export type BatchItemStatus = "waiting" | "processing" | "done" | "error";

export interface BatchItem<R> {
  file: File;
  status: BatchItemStatus;
  result?: R;
  error?: string;
}

export function createBatchItems<R>(files: readonly File[]): BatchItem<R>[] {
  return files.map((file) => ({ file, status: "waiting" }));
}

export async function runBatchSequentially<R>(
  files: readonly File[],
  processOne: (file: File, index: number) => Promise<R>,
  onUpdate: (items: BatchItem<R>[]) => void
): Promise<BatchItem<R>[]> {
  let items = createBatchItems<R>(files);
  const update = (index: number, patch: Partial<BatchItem<R>>) => {
    items = items.map((item, i) => (i === index ? { ...item, ...patch } : item));
    onUpdate(items);
  };
  onUpdate(items);

  for (let i = 0; i < files.length; i++) {
    update(i, { status: "processing" });
    // 画面の表示（「処理中」）を先に反映させてから、重い処理に入る
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const result = await processOne(files[i], i);
      update(i, { status: "done", result });
    } catch (e) {
      update(i, { status: "error", error: e instanceof Error ? e.message : "処理に失敗しました" });
    }
  }
  return items;
}
