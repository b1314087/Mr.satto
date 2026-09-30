import { BrowserProcessor } from "../types";
import { readXlsxSheets, writeXlsxSheets, isBlankRow, isBlankColumn, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

/**
 * Excel空白行・空白列削除（次工程・軽量便利ツール一括追加 Tool 5）。
 *
 * 「空白」の定義: セルに値・数式・文字列が一切ない状態（null/undefined/空文字）。
 * 見た目だけ空白（数式の結果が空文字など）は読み取り時点で判定できないため
 * 対象外（read-excel-fileが返す値ベースでの判定に限定する、という制約を許容する）。
 *
 * 範囲指定（rangeStartRow〜rangeEndCol、いずれも1始まり・両端を含む）が
 * 指定された場合は、その範囲内だけを対象に抽出・削除処理を行う
 * （範囲外の行・列は出力に含めない、という単純な仕様にする）。
 */
export type BlankRemoveMode = "rows" | "columns" | "both";

export interface ExcelBlankRemoveInput {
  file: File;
  mode: BlankRemoveMode;
  rangeStartRow?: number;
  rangeEndRow?: number;
  rangeStartCol?: number;
  rangeEndCol?: number;
}

export interface ExcelBlankRemoveOutput {
  blob: Blob;
  removedRows: number;
  removedColumns: number;
}

function sliceRange(
  rows: XlsxCellValue[][],
  rangeStartRow?: number,
  rangeEndRow?: number,
  rangeStartCol?: number,
  rangeEndCol?: number
): XlsxCellValue[][] {
  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const rStart = rangeStartRow ? Math.max(0, rangeStartRow - 1) : 0;
  const rEnd = rangeEndRow ? Math.min(rows.length, rangeEndRow) : rows.length;
  const cStart = rangeStartCol ? Math.max(0, rangeStartCol - 1) : 0;
  const cEnd = rangeEndCol ? Math.min(maxCols, rangeEndCol) : maxCols;

  if (rStart >= rEnd || cStart >= cEnd) {
    throw new Error("指定した範囲が正しくありません");
  }

  const sliced: XlsxCellValue[][] = [];
  for (let r = rStart; r < rEnd; r++) {
    const row = rows[r] ?? [];
    const newRow: XlsxCellValue[] = [];
    for (let c = cStart; c < cEnd; c++) {
      newRow.push(row[c] ?? null);
    }
    sliced.push(newRow);
  }
  return sliced;
}

function removeBlanks(rows: XlsxCellValue[][], mode: BlankRemoveMode) {
  let result = rows;
  let removedRows = 0;
  let removedColumns = 0;

  if (mode === "rows" || mode === "both") {
    const before = result.length;
    result = result.filter((row) => !isBlankRow(row));
    removedRows = before - result.length;
  }

  if (mode === "columns" || mode === "both") {
    const maxCols = result.reduce((max, r) => Math.max(max, r.length), 0);
    const keepCols: number[] = [];
    for (let c = 0; c < maxCols; c++) {
      if (!isBlankColumn(result, c)) keepCols.push(c);
    }
    removedColumns = maxCols - keepCols.length;
    result = result.map((row) => keepCols.map((c) => row[c] ?? null));
  }

  return { rows: result, removedRows, removedColumns };
}

export class ExcelBlankRemoveProcessor extends BrowserProcessor<ExcelBlankRemoveInput, ExcelBlankRemoveOutput> {
  async process(input: ExcelBlankRemoveInput): Promise<ExcelBlankRemoveOutput> {
    const sheets = await readXlsxSheets(input.file);
    let totalRemovedRows = 0;
    let totalRemovedColumns = 0;

    const outputSheets = sheets.map((sheet) => {
      const hasRange =
        input.rangeStartRow !== undefined ||
        input.rangeEndRow !== undefined ||
        input.rangeStartCol !== undefined ||
        input.rangeEndCol !== undefined;
      const source = hasRange
        ? sliceRange(sheet.rows, input.rangeStartRow, input.rangeEndRow, input.rangeStartCol, input.rangeEndCol)
        : sheet.rows;
      const { rows, removedRows, removedColumns } = removeBlanks(source, input.mode);
      totalRemovedRows += removedRows;
      totalRemovedColumns += removedColumns;
      return { name: sheet.name, rows };
    });

    const blob = await writeXlsxSheets(outputSheets);
    return { blob, removedRows: totalRemovedRows, removedColumns: totalRemovedColumns };
  }
}
