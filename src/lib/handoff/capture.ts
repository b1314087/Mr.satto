/**
 * 「ほかのツールで使う」のための、ダウンロード結果の受け取り口（工程16）。
 *
 * 各ツールは処理結果を共通の downloadBlob()（src/lib/utils/format.ts）で保存する。受け渡しのときは、
 * ツールのダウンロード処理（onDownload）を「受け取りモード」で呼び、downloadBlob() に渡されたファイルを
 * 保存せずにここで受け取る。これで、各ツールに受け渡し専用のコードを書かずに、ダウンロードと同じ結果を渡せる。
 *
 * 受け取りモードの間の downloadBlob() は、保存も広告の確認もしない（受け渡しを実行するときに、
 * ダウンロードと同じ広告の確認を通す。src/components/handoff/handoff-send.tsx）。
 */

export interface CapturedDownload {
  blob: Blob;
  filename: string;
}

let sink: CapturedDownload[] | null = null;

/** downloadBlob() から呼ぶ。受け取りモードなら受け取って true を返す（呼び出し元は保存しない） */
export function captureIfActive(blob: Blob, filename: string): boolean {
  if (!sink) return false;
  sink.push({ blob, filename });
  return true;
}

/** run（ツールのダウンロード処理）を受け取りモードで実行し、渡されたファイルを順番どおりに返す */
export async function captureDownloads(run: () => void | Promise<void>): Promise<CapturedDownload[]> {
  if (sink) throw new Error("capture already active");
  const collected: CapturedDownload[] = [];
  sink = collected;
  try {
    await run();
  } finally {
    sink = null;
  }
  return collected;
}
