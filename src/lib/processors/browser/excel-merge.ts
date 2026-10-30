import { BrowserProcessor } from "../types";
import { readXlsxSheets, writeXlsxSheets, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";
import {
  cellToText,
  mergeTables,
  MERGE_MAX_SOURCES,
  MergeError,
  type MergeOptions,
  type MergeResult,
  type MergeSource,
} from "@/lib/excel/merge-tables";
import { decodeCsvBytes, LEGACY_EXCEL_MESSAGE } from "@/lib/calendar/event-file";
import { csvRowsToBlob, parseCsv } from "@/lib/utils/csv";

/**
 * Excel・CSVの結合（ブラウザ内だけで処理する。ファイルは外部に送らず、元のファイルも書き換えない）。
 * 列を揃える規則は src/lib/excel/merge-tables.ts にある（画面のプレビューと出力が同じ関数を使う）。
 */

export type MergeFileKind = "excel" | "csv" | "legacy-excel" | "unsupported";

/** 古い形式（.xls）も選べるようにしておく（選ばれたら、保存し直す方法を案内する。読み込みはしない） */
export const MERGE_FILE_ACCEPT =
  ".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const MERGE_UNSUPPORTED_MESSAGE = "このファイル形式には対応していません。Excel（.xlsx）またはCSVを選んでください。";
export { LEGACY_EXCEL_MESSAGE as MERGE_LEGACY_EXCEL_MESSAGE };

/** 拡張子（とMIMEタイプ）でファイルの種類を判定する。ドラッグ&ドロップではaccept属性が効かないため、ここでも見る */
export function classifyMergeFile(file: { name: string; type: string }): MergeFileKind {
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(name)) return "excel";
  if (/\.xls$/.test(name)) return "legacy-excel";
  if (/\.csv$/.test(name) || type === "text/csv") return "csv";
  return "unsupported";
}

export interface LoadedMergeFile {
  fileName: string;
  kind: "excel" | "csv";
  sheets: { name: string; rows: XlsxCellValue[][] }[];
}

const loadCache = new WeakMap<File, Promise<LoadedMergeFile>>();

/** ファイルを読み込む（同じFileは読み直さない）。Excelは全シート、CSVは1枚の表として読む */
export function loadMergeFile(file: File): Promise<LoadedMergeFile> {
  let cached = loadCache.get(file);
  if (!cached) {
    cached = readMergeFile(file);
    loadCache.set(file, cached);
  }
  return cached;
}

async function readMergeFile(file: File): Promise<LoadedMergeFile> {
  const kind = classifyMergeFile(file);
  if (kind === "legacy-excel") throw new Error(LEGACY_EXCEL_MESSAGE);
  if (kind === "unsupported") throw new Error(`${file.name}: ${MERGE_UNSUPPORTED_MESSAGE}`);
  if (kind === "excel") {
    const sheets = await readXlsxSheets(file);
    return { fileName: file.name, kind: "excel", sheets };
  }
  let text: string;
  try {
    text = decodeCsvBytes(await file.arrayBuffer());
  } catch {
    throw new Error(`${file.name} の読み込みに失敗しました`);
  }
  const rows: XlsxCellValue[][] = parseCsv(text);
  return { fileName: file.name, kind: "csv", sheets: [{ name: "CSV", rows }] };
}

/** 複数のファイルをまとめて読み込む（画面のプレビュー用。ローダーは安定した関数を渡す必要がある） */
export function loadMergeFiles(files: File[]): Promise<LoadedMergeFile[]> {
  return Promise.all(files.map(loadMergeFile));
}

/** 「結合元」の列とプレビューに出す名前。シートが複数あるExcelは、シート名も付ける */
export function mergeSourceLabel(loaded: LoadedMergeFile, sheetIndex: number): string {
  if (loaded.kind === "excel" && loaded.sheets.length > 1) {
    return `${loaded.fileName}（${loaded.sheets[sheetIndex]?.name ?? ""}）`;
  }
  return loaded.fileName;
}

/** 読み込んだファイルと、ファイルごとに選んだシートから、結合する表の一覧を作る（行数の上限があれば先頭だけ使う） */
export function buildMergeSources(
  loaded: LoadedMergeFile[],
  sheetIndexes: number[],
  maxRowsPerSource?: number
): MergeSource[] {
  return loaded.map((file, i) => {
    const index = Math.min(Math.max(sheetIndexes[i] ?? 0, 0), file.sheets.length - 1);
    const rows = file.sheets[index].rows;
    return {
      label: mergeSourceLabel(file, index),
      rows: maxRowsPerSource !== undefined && rows.length > maxRowsPerSource ? rows.slice(0, maxRowsPerSource) : rows,
    };
  });
}

export type MergeOutputFormat = "xlsx" | "csv";

export interface ExcelMergeInput {
  files: File[];
  /** ファイルごとに結合するシートの番号（0始まり）。省略したファイルは先頭のシート */
  sheetIndexes?: number[];
  options: MergeOptions;
  format: MergeOutputFormat;
}

export interface ExcelMergeOutput {
  blob: Blob;
  fileName: string;
  result: MergeResult;
}

/** 結合結果を、出力するファイルにする */
export async function mergeResultToBlob(result: MergeResult, format: MergeOutputFormat): Promise<Blob> {
  if (format === "csv") {
    return csvRowsToBlob([result.header, ...result.rows.map((row) => row.map(cellToText))]);
  }
  return writeXlsxSheets([{ name: "結合結果", rows: [result.header, ...result.rows] }]);
}

export class ExcelMergeProcessor extends BrowserProcessor<ExcelMergeInput, ExcelMergeOutput> {
  async process({ files, sheetIndexes = [], options, format }: ExcelMergeInput): Promise<ExcelMergeOutput> {
    if (files.length > MERGE_MAX_SOURCES) {
      throw new MergeError(`一度に結合できるのは${MERGE_MAX_SOURCES}件までです。件数を減らしてください。`);
    }
    const loaded = await loadMergeFiles(files);
    const result = mergeTables(buildMergeSources(loaded, sheetIndexes), options);
    const blob = await mergeResultToBlob(result, format);
    return { blob, fileName: format === "csv" ? "merged.csv" : "merged.xlsx", result };
  }
}
