/// <reference lib="webworker" />
import { serveWorker } from "@/lib/workers/worker-serve";
import { convertXlsFile } from "./xls-to-xlsx";
import { convertDocFile } from "./doc-to-docx";

/**
 * Office旧形式→新形式の変換（.xls→.xlsx・.doc→.docx）を、画面とは別の処理（Web Worker）で行う。
 * 大きなファイルでも画面が固まらないようにする。変換の方法は画面側とまったく同じ関数を使う。
 */

export type LegacyConvertRequest = { type: "xls"; file: File } | { type: "doc"; file: File };

serveWorker<LegacyConvertRequest>(async (req) => {
  if (req.type === "xls") return { value: await convertXlsFile(req.file) };
  return { value: await convertDocFile(req.file) };
});
