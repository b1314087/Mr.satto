import { BrowserProcessor } from "../types";
import { readXlsxSheets, writeXlsxSheets, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

/**
 * Excel横セル結合・中央揃え（次工程・軽量便利ツール一括追加 Tool 7）。
 *
 * 座標（行・列番号）を扱う都合上、シートごとに構造が大きく異なる可能性がある
 * 複数シートへ同じ座標を一律適用するのは事故のもとになるため、
 * このツールは「対象シートを1つ選ぶ」設計にする（他のシートはそのまま出力に含める）。
 *
 * 結合時は、Excelの標準的な挙動に合わせて「範囲内の一番左のセルの値を残し、
 * 他のセルの値は破棄する」。write-excel-fileの仕様上、結合された（seされた）
 * セルのうち先頭以外は null として出力する必要がある（既存のpdf-to-excel.tsと同じ手法）。
 *
 * 複数行をまとめて処理できるよう、対象行は「開始行〜終了行」の範囲で指定する
 * （各行に同じ列範囲の結合/中央揃えを適用する）。
 */
export interface ExcelMergeCenterInput {
  file: File;
  sheetIndex: number;
  /** 対象行の範囲（1始まり・両端を含む） */
  startRow: number;
  endRow: number;
  /** 対象列の範囲（1始まり・両端を含む） */
  startCol: number;
  endCol: number;
  /** true: セルを結合する。false: 結合せず中央揃えだけを行う */
  merge: boolean;
  horizontalCenter: boolean;
  verticalCenter: boolean;
}

export interface ExcelMergeCenterOutput {
  blob: Blob;
  processedRowCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WritableCell = any;

function styledCell(
  value: XlsxCellValue,
  horizontalCenter: boolean,
  verticalCenter: boolean,
  columnSpan?: number
): WritableCell {
  if (value === null || value === undefined) {
    // write-excel-fileの Value 型は null を許容しないため、空セルはスタイル付けを諦めて
    // そのまま null で出力する（結合の先頭セルの場合はcolumnSpanのみ付けたいところだが、
    // 値が無いセルへの結合適用は稀なケースとして許容する）。
    if (columnSpan) return { value: "", columnSpan };
    return null;
  }
  const cell: Record<string, unknown> = { value };
  if (horizontalCenter) cell.align = "center";
  if (verticalCenter) cell.alignVertical = "center";
  if (columnSpan) cell.columnSpan = columnSpan;
  return cell;
}

export class ExcelMergeCenterProcessor extends BrowserProcessor<ExcelMergeCenterInput, ExcelMergeCenterOutput> {
  async process(input: ExcelMergeCenterInput): Promise<ExcelMergeCenterOutput> {
    const sheets = await readXlsxSheets(input.file);
    if (input.sheetIndex < 0 || input.sheetIndex >= sheets.length) {
      throw new Error("対象のシートが見つかりません");
    }
    if (input.startRow < 1 || input.endRow < input.startRow) {
      throw new Error("対象行の範囲が正しくありません");
    }
    if (input.startCol < 1 || input.endCol < input.startCol) {
      throw new Error("対象列の範囲が正しくありません");
    }
    if (!input.merge && !input.horizontalCenter && !input.verticalCenter) {
      throw new Error("結合するか、中央揃えのいずれかを選択してください");
    }

    const rStart = input.startRow - 1;
    const rEnd = input.endRow - 1;
    const cStart = input.startCol - 1;
    const cEnd = input.endCol - 1;
    const span = cEnd - cStart + 1;

    let processedRowCount = 0;

    const outputSheets = sheets.map((sheet, sheetIdx) => {
      if (sheetIdx !== input.sheetIndex) return { name: sheet.name, rows: sheet.rows };

      const rows: WritableCell[][] = sheet.rows.map((row, rowIndex) => {
        if (rowIndex < rStart || rowIndex > rEnd) return row;
        processedRowCount++;
        const newRow: WritableCell[] = [...row];
        // 対象列範囲を超える行の場合に備え、必要な列数まで埋める
        while (newRow.length <= cEnd) newRow.push(null);

        if (input.merge) {
          const leadValue = row[cStart] ?? null;
          newRow[cStart] = styledCell(leadValue, input.horizontalCenter, input.verticalCenter, span);
          for (let c = cStart + 1; c <= cEnd; c++) {
            newRow[c] = null;
          }
        } else {
          for (let c = cStart; c <= cEnd; c++) {
            newRow[c] = styledCell(row[c] ?? null, input.horizontalCenter, input.verticalCenter);
          }
        }
        return newRow;
      });

      return { name: sheet.name, rows };
    });

    const blob = await writeXlsxSheets(outputSheets);
    return { blob, processedRowCount };
  }
}
