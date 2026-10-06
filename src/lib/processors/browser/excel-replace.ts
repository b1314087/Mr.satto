import { BrowserProcessor } from "../types";
import { readXlsxSheets, writeXlsxSheets, columnLetterToIndex, type XlsxCellValue, type XlsxSheet } from "@/lib/excel/xlsx-simple-io";

/**
 * Excel文字削除・置換（次工程・軽量便利ツール一括追加 Tool 6）。
 * 削除・置換を1つのツールにまとめる（削除 = 置換後の文字列を空文字にする処理として扱う）。
 *
 * 文字列セルのみを対象にする（数値・日付・真偽値セルは変更しない）。
 * 対象範囲は「シート全体」「指定列」「指定範囲」から選べる。複数シートを
 * 含むブックの場合、同じ設定をすべてのシートへ一律に適用する
 * （シートごとに異なる範囲を指定する機能は今回のスコープ外）。
 * 既存のCSV置換機能（csv-ops.ts）とは別実装だが、置換ロジック自体は単純な
 * 文字列置換のため重複コードは最小限にしている。
 */
export type ExcelReplaceScope = "all" | "column" | "range";

export interface ExcelReplaceInput {
  file: File;
  find: string;
  /** 削除モードの場合は無視され、常に空文字への置換として扱われる */
  replaceWith: string;
  mode: "delete" | "replace";
  caseSensitive: boolean;
  scope: ExcelReplaceScope;
  /** scope: "column" の場合の対象列（例: "B"） */
  columnLetter?: string;
  /** scope: "range" の場合の範囲（1始まり・両端を含む） */
  rangeStartRow?: number;
  rangeEndRow?: number;
  rangeStartCol?: number;
  rangeEndCol?: number;
}

export interface ExcelReplaceOutput {
  blob: Blob;
  replacedCount: number;
}

function buildFinder(find: string, caseSensitive: boolean): (value: string) => number {
  if (caseSensitive) {
    return (value) => value.split(find).length - 1;
  }
  const lowerFind = find.toLowerCase();
  return (value) => value.toLowerCase().split(lowerFind).length - 1;
}

function replaceInString(value: string, find: string, replaceWith: string, caseSensitive: boolean): string {
  if (find === "") return value;
  if (caseSensitive) {
    return value.split(find).join(replaceWith);
  }
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(escaped, "gi"), replaceWith);
}

function isTargetCell(rowIndex: number, colIndex: number, input: Omit<ExcelReplaceInput, "file">): boolean {
  if (input.scope === "all") return true;
  if (input.scope === "column") {
    if (!input.columnLetter) return false;
    return colIndex === columnLetterToIndex(input.columnLetter);
  }
  // scope === "range"
  const rStart = input.rangeStartRow ? input.rangeStartRow - 1 : 0;
  const rEnd = input.rangeEndRow ? input.rangeEndRow - 1 : Infinity;
  const cStart = input.rangeStartCol ? input.rangeStartCol - 1 : 0;
  const cEnd = input.rangeEndCol ? input.rangeEndCol - 1 : Infinity;
  return rowIndex >= rStart && rowIndex <= rEnd && colIndex >= cStart && colIndex <= cEnd;
}

/**
 * 検索・置換の入力検証(出力とプレビューで共通)。問題があれば日本語のエラーを throw する。
 */
export function validateExcelReplaceInput(input: Pick<ExcelReplaceInput, "find" | "scope" | "columnLetter">) {
  if (input.find === "") {
    throw new Error("検索する文字列を入力してください");
  }
  if (input.scope === "column" && !input.columnLetter) {
    throw new Error("対象の列を指定してください（例: B）");
  }
}

/**
 * 全シートに同じ置換を適用する(出力とプレビューで共通)。
 * 入力 sheets は変更せず、新しいシートの配列と置換件数を返す。
 */
export function replaceInSheets(
  sheets: XlsxSheet[],
  input: Omit<ExcelReplaceInput, "file">
): { sheets: XlsxSheet[]; replacedCount: number } {
  validateExcelReplaceInput(input);

  const replaceWith = input.mode === "delete" ? "" : input.replaceWith;
  const countOccurrences = buildFinder(input.find, input.caseSensitive);
  let replacedCount = 0;

  const outputSheets = sheets.map((sheet) => {
    const rows: XlsxCellValue[][] = sheet.rows.map((row, rowIndex) =>
      row.map((cell, colIndex) => {
        if (typeof cell !== "string") return cell;
        if (!isTargetCell(rowIndex, colIndex, input)) return cell;
        const occurrences = countOccurrences(cell);
        if (occurrences === 0) return cell;
        replacedCount += occurrences;
        return replaceInString(cell, input.find, replaceWith, input.caseSensitive);
      })
    );
    return { name: sheet.name, rows };
  });
  return { sheets: outputSheets, replacedCount };
}

export class ExcelReplaceProcessor extends BrowserProcessor<ExcelReplaceInput, ExcelReplaceOutput> {
  async process(input: ExcelReplaceInput): Promise<ExcelReplaceOutput> {
    validateExcelReplaceInput(input);

    const sheets = await readXlsxSheets(input.file);
    const { sheets: outputSheets, replacedCount } = replaceInSheets(sheets, input);

    const blob = await writeXlsxSheets(outputSheets);
    return { blob, replacedCount };
  }
}
