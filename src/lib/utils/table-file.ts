/**
 * CSV/Excelファイルから見出し行+データ行を読み取る共通ユーティリティ
 * （Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * 封筒宛名作成（複数宛先の読み込み）と名簿テンプレート作成（元データの読み込み）の
 * 2ツールが、拡張子(.csv / .xlsx等)に応じてCSVパーサーとExcel読み込みのどちらを
 * 使うかを個別に実装せずに済むよう、ここへ共通化する。
 *
 * 既存の parseCsv（src/lib/utils/csv.ts）と readXlsxSheets（src/lib/excel/xlsx-simple-io.ts）
 * をそのまま呼び出すだけで、新しいCSV/Excelパーサーは追加しない。
 */
import { parseCsv } from "./csv";
import { readXlsxSheets } from "@/lib/excel/xlsx-simple-io";

export interface ParsedTableFile {
  headers: string[];
  rows: string[][];
}

function isCsvFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".csv") || file.type === "text/csv";
}

/** セル値を表示用の文字列へ変換する（Excelの日付・数値セルも文字列化する） */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

/**
 * CSV または Excel ファイルを読み込み、見出し行（1行目）とデータ行に分けて返す。
 * Excelファイルは1つ目のシートのみを対象とする（複数宛先・名簿データという
 * 用途上、単一の表であることを前提とするため）。
 */
export async function parseTableFile(file: File): Promise<ParsedTableFile> {
  if (isCsvFile(file)) {
    const text = await file.text();
    const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim() !== ""));
    if (rows.length === 0) {
      throw new Error("このCSVファイルには読み取れるデータがありません");
    }
    return { headers: rows[0], rows: rows.slice(1) };
  }

  const sheets = await readXlsxSheets(file);
  const first = sheets[0];
  const rows = first.rows
    .map((row) => row.map(cellToString))
    .filter((row) => row.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) {
    throw new Error("このExcelファイルには読み取れるデータがありません");
  }
  return { headers: rows[0], rows: rows.slice(1) };
}
