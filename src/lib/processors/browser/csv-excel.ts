import { BrowserProcessor } from "../types";
import { serializeCsv } from "@/lib/utils/csv";
import { WorkerCanceledError, WorkerChannel, WorkerUnavailableError } from "@/lib/workers/worker-channel";
import type { ExcelWorkerRequest } from "./csv-excel.worker";
import { csvFileToXlsx, xlsxFileToSheets, type CsvToExcelOutput, type ExcelSheet, type ExcelToCsvOutput } from "./csv-excel-core";

export type { CsvToExcelOutput, ExcelSheet, ExcelToCsvOutput };

/**
 * CSV⇄Excel変換Processor（Phase 2-B）。
 *
 * Excel処理ライブラリとして read-excel-file / write-excel-file を採用した。
 * 既存依存（pdf-lib/pdfjs-dist/fflate/qrcode）とは重複しない新規領域であり、
 * 導入前に xlsx(SheetJS) と exceljs も検討したが、
 *  - xlsx@0.18.5（npmの最新版）は Prototype Pollution / ReDoS の
 *    高深刻度脆弱性が未修正（SheetJSがnpmへの修正版公開を停止したため）
 *  - exceljs@4.4.0 は推移的依存が95パッケージと重く、
 *    非推奨パッケージ（rimraf@2.7.1等）や中程度の脆弱性を含む
 * という理由でどちらも見送った（詳細は最終報告参照）。
 * read-excel-file/write-excel-file はどちらもブラウザ向けの
 * サブパス（/universal）が用意されており、依存パッケージも
 * 最小限（6パッケージ追加のみ）で `npm audit` も0件だったため採用した。
 *
 * /universal サブパスは Web Worker を使わない実装のため、
 * pdfjs-dist の pdf.worker.min.mjs のような静的Workerアセットの
 * 配置が不要で、導入・保守がシンプルになる利点もある。
 *
 * これらのライブラリは実際にCSV⇄Excelツールが使われるまで
 * バンドルへ含めないよう、process() 内で動的importする。
 */

// ---------------------------------------------------------------------------
// CSV → Excel
// ---------------------------------------------------------------------------
export interface CsvToExcelInput {
  file: File;
  /** 止めたいときに abort する（大きなファイルを Worker で処理しているときは、Worker ごと終了させる） */
  cancelSignal?: AbortSignal;
}

/**
 * これより大きいファイルは、画面とは別の処理（Worker）で変換する（ロードマップC 工程3）。
 * 小さいファイルは、Worker を作る手間（約0.1秒）のほうが大きいため、従来どおり画面側で変換する。
 * 目安：CSVは1MBで約1.5万行（10万行の約6.6MBでは、画面側だと最大約2秒画面が止まっていた）。
 */
export const CSV_WORKER_MIN_BYTES = 1024 * 1024;
export const XLSX_WORKER_MIN_BYTES = 512 * 1024;

/** 最後の変換を、どちらで行ったか（テスト・調査用） */
export let lastExcelEngine: "worker" | "main" | null = null;

function workerAvailable(): boolean {
  return typeof Worker !== "undefined" && (globalThis as { __mrsattoNoWorker?: boolean }).__mrsattoNoWorker !== true;
}

/**
 * 大きなファイルを Worker で変換する。ファイルそのもの（File）を渡し、結果だけを受け取る（大量の行のデータを画面との間で受け渡さない）。
 * 終わったら（成功・失敗・停止のどれでも）Worker を終了させ、メモリを解放する。Worker が使えなければ null を返す（画面側で変換する）。
 */
async function runInExcelWorker<T>(req: ExcelWorkerRequest, signal?: AbortSignal): Promise<T | null> {
  if (!workerAvailable()) return null;
  const channel = new WorkerChannel<ExcelWorkerRequest>(
    () => new Worker(new URL("./csv-excel.worker.ts", import.meta.url), { type: "module", name: "mrsatto-csv-excel" })
  );
  try {
    const value = await channel.request<T>(req, { signal });
    lastExcelEngine = "worker";
    return value;
  } catch (e) {
    if (e instanceof WorkerUnavailableError) return null;
    if (e instanceof WorkerCanceledError) throw e;
    throw e;
  } finally {
    channel.dispose();
  }
}

export class CsvToExcelProcessor extends BrowserProcessor<CsvToExcelInput, CsvToExcelOutput> {
  async process({ file, cancelSignal }: CsvToExcelInput): Promise<CsvToExcelOutput> {
    if (cancelSignal?.aborted) throw new WorkerCanceledError();
    if (file.size >= CSV_WORKER_MIN_BYTES) {
      const out = await runInExcelWorker<CsvToExcelOutput>({ type: "csv-to-xlsx", file }, cancelSignal);
      if (out) return out;
    }
    const out = await csvFileToXlsx(file);
    if (cancelSignal?.aborted) throw new WorkerCanceledError();
    lastExcelEngine = "main";
    return out;
  }
}

// ---------------------------------------------------------------------------
// Excel → CSV
// ---------------------------------------------------------------------------
export interface ExcelToCsvInput {
  file: File;
  cancelSignal?: AbortSignal;
}

export class ExcelToCsvProcessor extends BrowserProcessor<ExcelToCsvInput, ExcelToCsvOutput> {
  async process({ file, cancelSignal }: ExcelToCsvInput): Promise<ExcelToCsvOutput> {
    if (cancelSignal?.aborted) throw new WorkerCanceledError();
    if (file.size >= XLSX_WORKER_MIN_BYTES) {
      const out = await runInExcelWorker<ExcelToCsvOutput>({ type: "xlsx-to-csv", file }, cancelSignal);
      if (out) return out;
    }
    const out = await xlsxFileToSheets(file);
    if (cancelSignal?.aborted) throw new WorkerCanceledError();
    lastExcelEngine = "main";
    return out;
  }
}

/** シートのCSV行データからダウンロード用CSV Blobを生成する（BOM付きUTF-8） */
export function sheetRowsToCsvBlob(rows: string[][]): Blob {
  const text = serializeCsv(rows, { includeBom: true });
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
