/**
 * CSV共通ユーティリティ（Phase 2-B）。
 *
 * src/lib/processors/browser/text.ts の CsvFormatProcessor は
 * `line.split(",")` ベースの簡易整形であり、セル内にカンマ・改行・
 * ダブルクォートを含むCSVを正しく扱えない。
 * Phase 2-Bで追加するCSV/Excel系5ツール（CSV→Excel・Excel→CSV・CSV結合・
 * CSV重複削除・CSV文字置換）はすべて、この共通パーサー/シリアライザを
 * 経由してCSVを読み書きする（各ツールで同じパーサーを再実装しない）。
 *
 * RFC4180を基本としつつ、実務でよく見る「\r\nでも\nでも読める」
 * 「引用符なしフィールドも許容する」といった寛容な読み込みにしている。
 */

const UTF8_BOM_CHAR = "﻿";

/** 文字列先頭のUTF-8 BOMを取り除く（付いていなければそのまま返す） */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * CSV文字列を行×列の二次元配列へパースする。
 * ダブルクォートで囲まれたセル内のカンマ・改行・エスケープされた
 * ダブルクォート（""）に対応する。BOM付きUTF-8も先頭のBOMを除去してから処理する。
 */
export function parseCsv(input: string): string[][] {
  const text = stripBom(input);
  if (text === "") return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (char === "\r" && text[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    field += char;
    i += 1;
  }

  // 末尾に改行がない最終フィールド/行を追加する
  row.push(field);
  rows.push(row);

  // 末尾が改行で終わっている場合、最後に「1列だけの空行」が
  // 余分に生成されるため取り除く（例: "a,b\n" が [["a","b"],[""]] にならないように）
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last.length === 1 && last[0] === "") {
    rows.pop();
  }

  return rows;
}

/** セルの値がクォートを必要とするか（カンマ・改行・ダブルクォートを含む場合） */
function needsQuoting(value: string): boolean {
  return /[",\r\n]/.test(value);
}

function quoteField(value: string): string {
  if (!needsQuoting(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 二次元配列をCSV文字列へシリアライズする。
 * 必要なセルのみダブルクォートで囲み、内部のダブルクォートは""へエスケープする。
 * includeBom: true の場合、Excelで開いた際に日本語が文字化けしないよう
 * 先頭にUTF-8 BOMを付与する（既定でtrue）。
 */
export function serializeCsv(
  rows: string[][],
  options?: { includeBom?: boolean; newline?: "\r\n" | "\n" }
): string {
  const newline = options?.newline ?? "\r\n";
  const body = rows.map((row) => row.map(quoteField).join(",")).join(newline);
  return (options?.includeBom ?? true) ? UTF8_BOM_CHAR + body : body;
}

/** 二次元配列をダウンロード可能なCSV Blobへ変換する（BOM付きUTF-8が既定） */
export function csvRowsToBlob(rows: string[][], options?: { includeBom?: boolean }): Blob {
  const text = serializeCsv(rows, { includeBom: options?.includeBom ?? true });
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}

/** Fileを読み込んでCSVとしてパースする共通ヘルパー */
export async function readCsvFile(file: File): Promise<string[][]> {
  const text = await file.text();
  return parseCsv(text);
}

/**
 * 行が「完全な空行」かどうか（全セルが空文字、または列数0）を判定する。
 * パース結果の末尾などに残る空行の除外に使う。
 */
export function isBlankRow(row: string[]): boolean {
  return row.length === 0 || row.every((cell) => cell.trim() === "");
}
