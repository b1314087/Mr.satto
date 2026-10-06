import { BrowserProcessor } from "../types";
import { readXlsxSheets, writeXlsxSheets, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

/**
 * Excel行列入れ替え（次工程・軽量便利ツール一括追加 Tool 4）。
 * 各シートを独立して行列を入れ替える（複数シートあればすべて変換する）。
 * セルの値（文字列・数値・日付・真偽値）はそのまま維持する。
 * 罫線・色などの高度な書式は read-excel-file の制約により維持されない
 * （xlsx-simple-io.ts のコメント参照。指示書8章で許容される範囲）。
 */
export interface ExcelTransposeInput {
  file: File;
}

export interface ExcelTransposeOutput {
  blob: Blob;
  sheetCount: number;
}

/** 行と列を入れ替える(出力とプレビューで共通) */
export function transposeRows(rows: XlsxCellValue[][]): XlsxCellValue[][] {
  if (rows.length === 0) return [];
  const maxCols = Math.max(...rows.map((r) => r.length));
  const transposed: XlsxCellValue[][] = [];
  for (let c = 0; c < maxCols; c++) {
    const newRow: XlsxCellValue[] = [];
    for (let r = 0; r < rows.length; r++) {
      newRow.push(rows[r][c] ?? null);
    }
    transposed.push(newRow);
  }
  return transposed;
}

export class ExcelTransposeProcessor extends BrowserProcessor<ExcelTransposeInput, ExcelTransposeOutput> {
  async process(input: ExcelTransposeInput): Promise<ExcelTransposeOutput> {
    const sheets = await readXlsxSheets(input.file);
    const transposedSheets = sheets.map((sheet) => ({
      name: sheet.name,
      rows: transposeRows(sheet.rows),
    }));
    const blob = await writeXlsxSheets(transposedSheets);
    return { blob, sheetCount: sheets.length };
  }
}
