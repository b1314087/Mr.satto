import { parseCsv } from "@/lib/utils/csv";
import { readCsvText } from "@/lib/utils/csv-encoding";

/**
 * PDF差し込み印刷のデータの読み込み（工程4：データソースの拡張）。
 *
 * これまでの「CSV」「Excelの最初のシート」に加えて、次を読めるようにした。
 * - Excel の2枚目以降のシート（シートを選べる）
 * - タブ区切りのテキスト（.tsv・.txt）
 * - 表計算ソフトやWebの表からコピーした内容の貼り付け（タブ区切り。カンマ区切りのCSVの貼り付けも読める）
 * - 見出しの行が1行目でない表（見出しの行を選べる。上にタイトル行がある表など）
 *
 * - CSV・テキストの文字コードは、ほかのCSVツールと同じ判定・選び直しの仕組み（readCsvText）を使う（文字化け対策）。
 * - Excel の日付は、表示がずれないよう、UTC で読んで「2026/04/01」の形にする（read-excel-file は UTC の日付を返す）。
 * - すべてブラウザの中だけで読み、ファイルは送信しない。
 */

export interface FormDataSheet {
  name: string;
  rows: string[][];
}

export interface FormDataSource {
  /** どこから読んだか（画面の表示用） */
  kind: "csv" | "tsv" | "xlsx" | "paste";
  sheets: FormDataSheet[];
}

/** 見出しとデータの行（PDF差し込み印刷の ParsedTable と同じ形） */
export interface FormDataTable {
  headers: string[];
  rows: string[][];
}

/** 見出しの行として選べる行数（上から何行目までを候補にするか） */
export const FORM_DATA_HEADER_ROW_CANDIDATES = 10;
/** これより多い行数のときは、時間とメモリがかかることを知らせる */
export const FORM_DATA_LARGE_ROW_COUNT = 500;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Excel のセルの値を文字にする（日付は UTC で読み、時刻があるときだけ時刻も付ける） */
export function formDataCellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const date = `${value.getUTCFullYear()}/${pad2(value.getUTCMonth() + 1)}/${pad2(value.getUTCDate())}`;
    const h = value.getUTCHours();
    const m = value.getUTCMinutes();
    const s = value.getUTCSeconds();
    if (h === 0 && m === 0 && s === 0) return date;
    return `${date} ${pad2(h)}:${pad2(m)}${s ? `:${pad2(s)}` : ""}`;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    // 0.1+0.2 のような計算の誤差の桁を出さない（15桁に丸める）
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  }
  return String(value);
}

/** タブ区切りの文字を表にする（"..." で囲まれたセルの中の改行・タブにも対応） */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let atCellStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && atCellStart) {
      inQuotes = true;
      atCellStart = false;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      atCellStart = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
      continue;
    }
    cell += ch;
    atCellStart = false;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 貼り付けた文字を表にする。タブがあればタブ区切り、なければカンマ区切り（CSV）として読む */
export function parsePastedTable(text: string): string[][] {
  const normalized = text.replace(/^﻿/, "");
  return normalized.includes("\t") ? parseTsv(normalized) : parseCsv(normalized);
}

function isBlank(row: readonly string[]): boolean {
  return row.every((c) => c.trim() === "");
}

/**
 * 表（行の並び）から、見出しの行を選んで、見出しとデータの行に分ける。
 * - 見出しの行より上の行は使わない。データの行のうち、すべてのセルが空の行は除く。
 * - 見出しが空の列は「列3」のような名前にし、同じ見出しが重なるときは「氏名(2)」のように区別する
 *   （列の対応付けで、どの列か分からなくならないように）。
 * - データの行の長さは、見出しの列数にそろえる。
 */
export function buildFormDataTable(rows: readonly string[][], headerRowIndex: number): FormDataTable {
  const start = Math.max(0, Math.min(headerRowIndex, rows.length - 1));
  const headerRow = rows[start] ?? [];
  const body = rows.slice(start + 1).filter((r) => !isBlank(r));
  const width = body.reduce((m, r) => Math.max(m, r.length), headerRow.length);
  const used = new Map<string, number>();
  const headers: string[] = [];
  for (let c = 0; c < width; c++) {
    let name = (headerRow[c] ?? "").trim() || `列${c + 1}`;
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    if (n > 1) name = `${name}(${n})`;
    headers.push(name);
  }
  return {
    headers,
    rows: body.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? "")),
  };
}

/**
 * 最初の空でない行を、見出しの行の候補として返す（上に空行がある表のため）
 */
export function guessHeaderRowIndex(rows: readonly string[][]): number {
  const i = rows.findIndex((r) => !isBlank(r));
  return i === -1 ? 0 : Math.min(i, FORM_DATA_HEADER_ROW_CANDIDATES - 1);
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** ファイル（CSV・タブ区切り・Excel）を読む */
export async function readFormDataFile(file: File): Promise<FormDataSource> {
  const ext = extensionOf(file.name);
  if (ext === "xlsx") {
    const { default: readXlsxFile } = await import("read-excel-file/universal");
    let sheetsData: { sheet: string; data: unknown[][] }[];
    try {
      sheetsData = await readXlsxFile(file);
    } catch {
      throw new Error("Excelファイルの読み込みに失敗しました。破損しているか、対応していない形式(.xls等)の可能性があります。");
    }
    const sheets = (sheetsData ?? []).map((s) => ({ name: s.sheet, rows: s.data.map((row) => row.map(formDataCellToString)) }));
    if (sheets.length === 0 || sheets.every((s) => s.rows.length === 0)) throw new Error("Excelファイルにデータがありません");
    return { kind: "xlsx", sheets };
  }
  const { text } = await readCsvText(file);
  if (ext === "tsv" || ext === "txt") {
    const rows = parseTsv(text.replace(/^﻿/, ""));
    if (rows.length === 0) throw new Error("ファイルにデータがありません");
    return { kind: "tsv", sheets: [{ name: file.name, rows }] };
  }
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error("CSVにデータがありません");
  return { kind: "csv", sheets: [{ name: file.name, rows }] };
}
