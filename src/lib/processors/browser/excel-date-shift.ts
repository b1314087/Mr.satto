import { BrowserProcessor } from "../types";
import { readXlsxSheets, writeXlsxSheets, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

/**
 * Excel日付一括変更（次工程・軽量便利ツール一括追加 Tool 8）。
 *
 * read-excel-file は、Excel上で「日付」として書式設定されたセル（内部的には
 * シリアル値）を自動的にJSのDateへ変換して返す。そのため「日付シリアル値の
 * 安全な扱い」はread-excel-file側にすでに委ねられている。
 * 一方、"2026/10/01" のようにセルが「文字列」として入力されている場合は
 * Dateとして返らずstringのまま返るため、こちらも明確なパターン（YYYY/MM/DD・
 * YYYY-MM-DD）に一致する場合に限り、安全に検出して変換する。
 *
 * 日付として認識できないセル（数値・通常の文字列など）は一切変更しない。
 */
export type DateShiftMode = "set-year" | "set-month" | "set-day" | "add-days" | "subtract-days";

export interface ExcelDateShiftInput {
  file: File;
  mode: DateShiftMode;
  /** set-year: 西暦年。set-month: 1〜12。set-day: 1〜31。add-days/subtract-days: 日数(0以上) */
  value: number;
}

export interface ExcelDateShiftOutput {
  blob: Blob;
  changedCellCount: number;
}

interface ParsedDateCell {
  date: Date;
  isString: boolean;
  separator: "/" | "-";
}

const STRING_DATE_RE = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/;

function tryParseDateCell(cell: XlsxCellValue): ParsedDateCell | null {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return { date: cell, isString: false, separator: "/" };
  }
  if (typeof cell === "string") {
    const m = STRING_DATE_RE.exec(cell.trim());
    if (!m) return null;
    const [, y, sep, mo, d] = m;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const date = new Date(year, month - 1, day);
    // ロールオーバー（例: 2/30）していないか確認し、実在しない日付は対象外にする
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return { date, isString: true, separator: sep === "-" ? "-" : "/" };
  }
  return null;
}

function applyShift(date: Date, mode: DateShiftMode, value: number): Date {
  const result = new Date(date.getTime());
  switch (mode) {
    case "set-year":
      result.setFullYear(value);
      break;
    case "set-month":
      result.setMonth(value - 1);
      break;
    case "set-day":
      result.setDate(value);
      break;
    case "add-days":
      result.setDate(result.getDate() + value);
      break;
    case "subtract-days":
      result.setDate(result.getDate() - value);
      break;
    default:
      throw new Error("不明なモードです");
  }
  return result;
}

function formatDateString(date: Date, separator: "/" | "-"): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${separator}${m}${separator}${d}`;
}

function validateInput(input: ExcelDateShiftInput) {
  if (!Number.isFinite(input.value)) throw new Error("値を入力してください");
  if (input.mode === "set-month" && (input.value < 1 || input.value > 12)) {
    throw new Error("月は1〜12の範囲で入力してください");
  }
  if (input.mode === "set-day" && (input.value < 1 || input.value > 31)) {
    throw new Error("日は1〜31の範囲で入力してください");
  }
  if ((input.mode === "add-days" || input.mode === "subtract-days") && input.value < 0) {
    throw new Error("日数は0以上で入力してください");
  }
  if (input.mode === "set-year" && (input.value < 1900 || input.value > 2200)) {
    throw new Error("年は1900〜2200の範囲で入力してください");
  }
}

export class ExcelDateShiftProcessor extends BrowserProcessor<ExcelDateShiftInput, ExcelDateShiftOutput> {
  async process(input: ExcelDateShiftInput): Promise<ExcelDateShiftOutput> {
    validateInput(input);
    const sheets = await readXlsxSheets(input.file);
    let changedCellCount = 0;

    const outputSheets = sheets.map((sheet) => {
      const rows: XlsxCellValue[][] = sheet.rows.map((row) =>
        row.map((cell) => {
          const parsed = tryParseDateCell(cell);
          if (!parsed) return cell;
          const shifted = applyShift(parsed.date, input.mode, input.value);
          changedCellCount++;
          return parsed.isString ? formatDateString(shifted, parsed.separator) : shifted;
        })
      );
      return { name: sheet.name, rows };
    });

    const blob = await writeXlsxSheets(outputSheets);
    return { blob, changedCellCount };
  }
}
