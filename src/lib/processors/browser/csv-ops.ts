import { BrowserProcessor } from "../types";
import { parseCsv, isBlankRow, csvRowsToBlob } from "@/lib/utils/csv";

/**
 * CSV結合・CSV重複削除・CSV文字置換のProcessor（Phase 2-B）。
 *
 * 3ツールとも、CSVの読み込み・パース・出力はすべて共通ユーティリティ
 * src/lib/utils/csv.ts（parseCsv/csvRowsToBlob）を経由する。
 * 単純な文字列split(",")によるCSV処理は行わない
 * （セル内のカンマ・改行・ダブルクォートを壊さないため）。
 */

async function readTextOrThrow(file: File): Promise<string> {
  try {
    return await file.text();
  } catch {
    throw new Error(`${file.name} の読み込みに失敗しました`);
  }
}

function rowsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---------------------------------------------------------------------------
// CSV結合
// ---------------------------------------------------------------------------
export interface CsvMergeInput {
  files: File[];
}

export interface CsvMergeOutput {
  blob: Blob;
  rowCount: number;
  fileCount: number;
}

export class CsvMergeProcessor extends BrowserProcessor<CsvMergeInput, CsvMergeOutput> {
  async process({ files }: CsvMergeInput): Promise<CsvMergeOutput> {
    if (files.length < 2) {
      throw new Error("結合するには2つ以上のCSVファイルを選択してください");
    }

    const parsedFiles: { name: string; rows: string[][] }[] = [];
    for (const file of files) {
      const text = await readTextOrThrow(file);
      const rows = parseCsv(text).filter((row) => !isBlankRow(row));
      if (rows.length === 0) {
        throw new Error(`${file.name} の内容が空です。ファイルを確認してください。`);
      }
      parsedFiles.push({ name: file.name, rows });
    }

    const header = parsedFiles[0].rows[0];
    const expectedColumns = header.length;

    for (const { name, rows } of parsedFiles) {
      const actualColumns = rows[0].length;
      if (actualColumns !== expectedColumns) {
        throw new Error(
          `列数が一致しないため結合できません（${parsedFiles[0].name}: ${expectedColumns}列 / ${name}: ${actualColumns}列）。列構成をそろえてから再度お試しください。`
        );
      }
    }

    const merged: string[][] = [header];
    parsedFiles.forEach(({ rows }, index) => {
      if (index === 0) {
        merged.push(...rows.slice(1));
        return;
      }
      // 2個目以降は、先頭行が1個目のヘッダーと完全一致する場合のみ
      // 「ヘッダー行」とみなして重複追加しない。一致しない場合は
      // データを失わないよう、先頭行も含めてすべて結合する。
      const dataRows = rowsEqual(rows[0], header) ? rows.slice(1) : rows;
      merged.push(...dataRows);
    });

    const blob = csvRowsToBlob(merged);
    return { blob, rowCount: merged.length, fileCount: files.length };
  }
}

// ---------------------------------------------------------------------------
// CSV重複削除
// ---------------------------------------------------------------------------
export interface CsvDedupeInput {
  file: File;
}

export interface CsvDedupeOutput {
  blob: Blob;
  beforeCount: number;
  afterCount: number;
  removedCount: number;
}

export class CsvDedupeProcessor extends BrowserProcessor<CsvDedupeInput, CsvDedupeOutput> {
  async process({ file }: CsvDedupeInput): Promise<CsvDedupeOutput> {
    const text = await readTextOrThrow(file);
    const rows = parseCsv(text).filter((row) => !isBlankRow(row));
    if (rows.length === 0) {
      throw new Error("CSVの内容が空です。ファイルを確認してください。");
    }

    const [header, ...dataRows] = rows;
    const seen = new Set<string>();
    const deduped: string[][] = [];
    for (const row of dataRows) {
      const key = JSON.stringify(row);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(row);
      }
    }

    const blob = csvRowsToBlob([header, ...deduped]);
    return {
      blob,
      beforeCount: dataRows.length,
      afterCount: deduped.length,
      removedCount: dataRows.length - deduped.length,
    };
  }
}

// ---------------------------------------------------------------------------
// CSV文字置換
// ---------------------------------------------------------------------------
export interface CsvReplaceInput {
  file: File;
  search: string;
  replace: string;
}

export interface CsvReplaceOutput {
  blob: Blob;
  replacedCount: number;
  rowCount: number;
}

export class CsvReplaceProcessor extends BrowserProcessor<CsvReplaceInput, CsvReplaceOutput> {
  async process({ file, search, replace }: CsvReplaceInput): Promise<CsvReplaceOutput> {
    if (search === "") {
      throw new Error("検索する文字列を入力してください");
    }
    const text = await readTextOrThrow(file);
    const rows = parseCsv(text).filter((row) => !isBlankRow(row));
    if (rows.length === 0) {
      throw new Error("CSVの内容が空です。ファイルを確認してください。");
    }

    let replacedCount = 0;
    const resultRows = rows.map((row) =>
      row.map((cell) => {
        if (!cell.includes(search)) return cell;
        const parts = cell.split(search);
        replacedCount += parts.length - 1;
        return parts.join(replace);
      })
    );

    const blob = csvRowsToBlob(resultRows);
    return { blob, replacedCount, rowCount: rows.length };
  }
}
