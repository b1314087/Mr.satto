/// <reference lib="webworker" />
import { csvFileToXlsx, xlsxFileToSheets } from "./csv-excel-core";
import { serveWorker } from "@/lib/workers/worker-serve";

/**
 * 大きなCSV・Excelの変換を、画面とは別の処理（Web Worker）で行う（ロードマップC 工程3）。
 * 画面からはファイル（File）だけを受け取り、読み取り・セルの文字の整形・Excelファイルの作成をすべてここで行い、
 * 結果（Excelファイル、またはシートごとの行）だけを返す。変換の方法は画面側とまったく同じ関数を使う。
 */

export type ExcelWorkerRequest = { type: "csv-to-xlsx"; file: File } | { type: "xlsx-to-csv"; file: File };

serveWorker<ExcelWorkerRequest>(async (req) => {
  if (req.type === "csv-to-xlsx") return { value: await csvFileToXlsx(req.file) };
  return { value: await xlsxFileToSheets(req.file) };
});
