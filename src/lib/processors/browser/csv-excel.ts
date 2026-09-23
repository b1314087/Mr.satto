import { BrowserProcessor } from "../types";
import { parseCsv, serializeCsv, isBlankRow } from "@/lib/utils/csv";

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
}

export interface CsvToExcelOutput {
  blob: Blob;
  rowCount: number;
  sizeBytes: number;
}

export class CsvToExcelProcessor extends BrowserProcessor<CsvToExcelInput, CsvToExcelOutput> {
  async process({ file }: CsvToExcelInput): Promise<CsvToExcelOutput> {
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
}

// ---------------------------------------------------------------------------
// Excel → CSV
// ---------------------------------------------------------------------------
export interface ExcelSheet {
  name: string;
  rows: string[][];
}

export interface ExcelToCsvInput {
  file: File;
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

export class ExcelToCsvProcessor extends BrowserProcessor<ExcelToCsvInput, ExcelToCsvOutput> {
  async process({ file }: ExcelToCsvInput): Promise<ExcelToCsvOutput> {
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
}

/** シートのCSV行データからダウンロード用CSV Blobを生成する（BOM付きUTF-8） */
export function sheetRowsToCsvBlob(rows: string[][]): Blob {
  const text = serializeCsv(rows, { includeBom: true });
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
