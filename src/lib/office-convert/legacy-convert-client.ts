import { WorkerChannel, WorkerUnavailableError } from "@/lib/workers/worker-channel";
import type { LegacyConvertRequest } from "./legacy-convert.worker";
import type { XlsToXlsxOutput } from "./xls-to-xlsx";
import type { DocToDocxOutput } from "./doc-to-docx";

/**
 * Office旧形式→新形式の変換の入口。Web Worker が使えるときは Worker で、使えないときは画面側で変換する（結果は同じ）。
 */

function workerAvailable(): boolean {
  return typeof Worker !== "undefined" && (globalThis as { __mrsattoNoWorker?: boolean }).__mrsattoNoWorker !== true;
}

async function runInWorker<T>(req: LegacyConvertRequest): Promise<T | null> {
  if (!workerAvailable()) return null;
  const channel = new WorkerChannel<LegacyConvertRequest>(
    () => new Worker(new URL("./legacy-convert.worker.ts", import.meta.url), { type: "module", name: "mrsatto-legacy-office" })
  );
  try {
    return await channel.request<T>(req);
  } catch (e) {
    if (e instanceof WorkerUnavailableError) return null;
    throw e;
  } finally {
    channel.dispose();
  }
}

export async function convertLegacyXls(file: File): Promise<XlsToXlsxOutput> {
  const out = await runInWorker<XlsToXlsxOutput>({ type: "xls", file });
  if (out) return out;
  const { convertXlsFile } = await import("./xls-to-xlsx");
  return convertXlsFile(file);
}

export async function convertLegacyDoc(file: File): Promise<DocToDocxOutput> {
  const out = await runInWorker<DocToDocxOutput>({ type: "doc", file });
  if (out) return out;
  const { convertDocFile } = await import("./doc-to-docx");
  return convertDocFile(file);
}
