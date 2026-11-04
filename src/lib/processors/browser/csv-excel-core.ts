import { parseCsv, isBlankRow } from "@/lib/utils/csv";

/**
 * CSV⇄Excel変換の中身（ロードマップC 工程3で csv-excel.ts から分けた）。
 * 画面側（csv-excel.ts の Processor）と、別の処理（csv-excel.worker.ts）の両方が、この同じ関数を使う。
 * 画面の部品（document など）を使わないので、Worker の中でも動く。
 */

export interface CsvToExcelOutput {
  blob: Blob;
  rowCount: number;
  sizeBytes: number;
}

export interface ExcelSheet {
  name: string;
  rows: string[][];
}

export interface ExcelToCsvOutput {
  sheets: ExcelSheet[];
}

/**
 * Excelのセル値（string/number/boolean/Date/null）をCSV向けの文字列へ変換する。
 * 「見た目を完全にExcelと同じにする」ことは目的とせず、セルデータを
 * CSVとして失わずに表現することを優先する。
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    const hh = value.getHours();
    const mm = value.getMinutes();
    const ss = value.getSeconds();
    const datePart = `${y}-${m}-${d}`;
    if (hh === 0 && mm === 0 && ss === 0) return datePart;
    return `${datePart} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

/** CSVファイルを読み、Excelファイルにする（画面側・Worker の中のどちらでも同じ処理） */
export async function csvFileToXlsx(file: File): Promise<CsvToExcelOutput> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new Error("ファイルの読み込みに失敗しました");
  }
  const rows = parseCsv(text).filter((row) => !isBlankRow(row));
  if (rows.length === 0) {
    throw new Error("CSVの内容が空です。ファイルを確認してください。");
  }

  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  let blob: Blob;
  try {
    blob = await writeXlsxFile(rows).toBlob();
  } catch {
    throw new Error("Excelファイルの生成に失敗しました");
  }
  return { blob, rowCount: rows.length, sizeBytes: blob.size };
}

/** Excelファイルを読み、シートごとのCSV用の行（文字）にする（画面側・Worker の中のどちらでも同じ処理） */
export async function xlsxFileToSheets(file: File): Promise<ExcelToCsvOutput> {
  const { default: readXlsxFile } = await import("read-excel-file/universal");

  let sheetsData: { sheet: string; data: unknown[][] }[];
  try {
    sheetsData = await readXlsxFile(file);
  } catch {
    throw new Error(
      `${file.name} の読み込みに失敗しました。Excelファイルが破損しているか、対応していない形式の可能性があります。`
    );
  }
  if (!sheetsData || sheetsData.length === 0) {
    throw new Error("このExcelファイルには読み取れるシートがありません");
  }

  const sheets: ExcelSheet[] = sheetsData.map((s) => ({
    name: s.sheet,
    rows: s.data.map((row) => row.map(cellToString)),
  }));
  return { sheets };
}

