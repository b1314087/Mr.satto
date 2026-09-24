import { BrowserProcessor } from "../types";
import { parseCsv, isBlankRow, serializeCsv } from "@/lib/utils/csv";

/**
 * CSV⇄JSON変換Processor（Phase 6）。
 *
 * CSVの読み込み・書き出しは既存の共通ユーティリティ src/lib/utils/csv.ts
 * （RFC4180対応パーサー/シリアライザ）をそのまま再利用し、独自のCSV処理を
 * 追加しない（既存のCSV系5ツールと同じ土台）。
 *
 * 数値の自動number化について: 既存のCSV→Excel変換（csv-excel.ts）も
 * セルの値を数値へ自動変換せず文字列のまま扱っている。先頭ゼロの番号
 * （郵便番号・電話番号等）を意図せず数値化してしまう事故を避けるため、
 * CSV→JSONでも既存の方針を踏襲し、値はすべて文字列として出力する
 * （仕様を勝手に変更しない）。
 */

// ---------------------------------------------------------------------------
// CSV → JSON
// ---------------------------------------------------------------------------
export interface CsvToJsonInput {
  file: File;
}

export interface CsvToJsonOutput {
  json: string;
  blob: Blob;
  objectCount: number;
}

export class CsvToJsonProcessor extends BrowserProcessor<CsvToJsonInput, CsvToJsonOutput> {
  async process({ file }: CsvToJsonInput): Promise<CsvToJsonOutput> {
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

    const [header, ...dataRows] = rows;
    const emptyHeaderIndex = header.findIndex((cell) => cell.trim() === "");
    if (emptyHeaderIndex !== -1) {
      throw new Error(
        `1行目（ヘッダー）の${emptyHeaderIndex + 1}列目が空です。すべての列に見出しを付けてください。`
      );
    }
    const duplicated = header.find((name, i) => header.indexOf(name) !== i);
    if (duplicated) {
      throw new Error(`ヘッダーに同じ名前が重複しています（${duplicated}）。列名を一意にしてください。`);
    }

    dataRows.forEach((row, index) => {
      if (row.length !== header.length) {
        throw new Error(
          `${index + 2}行目の列数がヘッダー（${header.length}列）と一致しません（${row.length}列）。CSVの内容を確認してください。`
        );
      }
    });

    const objects = dataRows.map((row) => {
      const obj: Record<string, string> = {};
      header.forEach((key, i) => {
        obj[key] = row[i];
      });
      return obj;
    });

    const json = JSON.stringify(objects, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    return { json, blob, objectCount: objects.length };
  }
}

// ---------------------------------------------------------------------------
// JSON → CSV
// ---------------------------------------------------------------------------
export interface JsonToCsvInput {
  text: string;
}

export interface JsonToCsvOutput {
  blob: Blob;
  csvText: string;
  rowCount: number;
  columnCount: number;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export class JsonToCsvProcessor extends BrowserProcessor<JsonToCsvInput, JsonToCsvOutput> {
  async process({ text }: JsonToCsvInput): Promise<JsonToCsvOutput> {
    if (!text.trim()) {
      throw new Error("JSON文字列を入力してください");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSONの形式が正しくありません。構文を確認してください。");
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        'JSONの配列（例: [{"name":"A","age":20}, ...]）を入力してください。オブジェクト単体はCSVへ変換できません。'
      );
    }
    if (parsed.length === 0) {
      throw new Error("配列の中身が空です。1件以上のオブジェクトを含めてください。");
    }

    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);

    parsed.forEach((item, index) => {
      if (!isPlainObject(item)) {
        throw new Error(
          `${index + 1}番目の要素がオブジェクトではありません。配列の各要素は {"key":"value"} の形にしてください。`
        );
      }
    });
    const objects = parsed as Record<string, unknown>[];

    // 最初のオブジェクトのキーだけでなく、全オブジェクトのキーを収集する
    // （オブジェクトごとにキーが異なっていても、欠けている項目は空欄として扱う）。
    const columns: string[] = [];
    const columnSet = new Set<string>();
    for (const obj of objects) {
      for (const key of Object.keys(obj)) {
        if (!columnSet.has(key)) {
          columnSet.add(key);
          columns.push(key);
        }
      }
    }
    if (columns.length === 0) {
      throw new Error("オブジェクトにキーがありません。変換できる項目がありませんでした。");
    }

    // ネストしたobject/arrayは無理に文字列化せず、明確なエラーにする
    for (let i = 0; i < objects.length; i++) {
      const obj = objects[i];
      for (const key of columns) {
        const value = obj[key];
        if (typeof value === "object" && value !== null) {
          throw new Error(
            `${i + 1}番目の要素の "${key}" がネストしたオブジェクト/配列のため、表形式に変換できません。ネストのないデータに整えてから再度お試しください。`
          );
        }
      }
    }

    const rows: string[][] = [columns, ...objects.map((obj) => columns.map((key) => cellToString(obj[key])))];
    const csvText = serializeCsv(rows, { includeBom: true });
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    return { blob, csvText, rowCount: objects.length, columnCount: columns.length };
  }
}
