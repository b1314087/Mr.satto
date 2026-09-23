import { BrowserProcessor, type NamedFileOutput } from "../types";
import { dedupeFileNames, getExtension, sanitizeFileName, stripExtension } from "@/lib/utils/format";
import { createZip } from "@/lib/utils/zip";

/**
 * ファイル系Processor（Phase 2-B）。
 *
 * 「一括リネーム」と「連番リネーム」は、どちらも実体は
 * 「各ファイルへ新しいベース名（拡張子を除く部分）を割り当てて
 * 新規ファイルを生成する」という同じ処理のため、共通の
 * FileRenameProcessor を1つだけ用意し、UI側は newBaseNames の
 * 生成方法（自由入力 or 連番生成）だけを切り替える設計にしている
 * （同じリネーム処理を2ツールへ別々に実装しない）。
 *
 * ZIP化には Phase 2-A で実装済みの createZip() をそのまま再利用する。
 */

// ---------------------------------------------------------------------------
// 連番ベース名の生成（一括リネームの「共通名＋連番」クイック生成、および
// 連番リネームツール本体の両方から使う）
// ---------------------------------------------------------------------------
export interface SequentialNameOptions {
  count: number;
  /** 接頭辞（空文字可） */
  prefix: string;
  /** 開始番号（0以上の整数） */
  startNumber: number;
  /** 連番の桁数（1〜10） */
  digits: number;
  /** 接尾辞（空文字可・省略可） */
  suffix?: string;
}

export function buildSequentialBaseNames({
  count,
  prefix,
  startNumber,
  digits,
  suffix,
}: SequentialNameOptions): string[] {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("リネームするファイルがありません");
  }
  if (!Number.isInteger(startNumber) || startNumber < 0) {
    throw new Error("開始番号は0以上の整数で指定してください");
  }
  if (!Number.isInteger(digits) || digits < 1 || digits > 10) {
    throw new Error("桁数は1〜10の範囲の整数で指定してください");
  }
  const trimmedPrefix = prefix.trim();
  const trimmedSuffix = (suffix ?? "").trim();

  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const num = String(startNumber + i).padStart(digits, "0");
    const parts = [trimmedPrefix, num, trimmedSuffix].filter((p) => p !== "");
    names.push(parts.join("_"));
  }
  return names;
}

// ---------------------------------------------------------------------------
// ファイルリネーム（一括リネーム・連番リネーム共通）
// ---------------------------------------------------------------------------
export interface FileRenameInput {
  files: File[];
  /**
   * 各ファイルに対応する新しいベース名（拡張子を除く部分）。
   * files と同じ長さである必要がある。空文字を渡した場合は元のベース名を使う。
   */
  newBaseNames: string[];
}

export class FileRenameProcessor extends BrowserProcessor<FileRenameInput, NamedFileOutput[]> {
  async process({ files, newBaseNames }: FileRenameInput): Promise<NamedFileOutput[]> {
    if (files.length === 0) {
      throw new Error("リネームするファイルを選択してください");
    }
    if (files.length !== newBaseNames.length) {
      throw new Error("ファイル数と新しい名前の数が一致しません");
    }

    const rawNames = files.map((file, i) => {
      const ext = getExtension(file.name);
      const requestedBase = newBaseNames[i]?.trim();
      const base = sanitizeFileName(requestedBase || stripExtension(file.name));
      return ext ? `${base}.${ext}` : base;
    });

    const uniqueNames = dedupeFileNames(rawNames);

    // 元のFileオブジェクトを書き換えず、新しいファイル名の情報だけを
    // 新規オブジェクトとして返す（内容Blobは共有してよい。不変なため）。
    return files.map((file, i) => ({
      blob: file,
      suggestedName: uniqueNames[i],
      sizeBytes: file.size,
    }));
  }
}

// ---------------------------------------------------------------------------
// ファイルZIP化
// ---------------------------------------------------------------------------
export interface FileZipInput {
  files: File[];
}

export interface FileZipOutput {
  blob: Blob;
  sizeBytes: number;
}

export class FileZipProcessor extends BrowserProcessor<FileZipInput, FileZipOutput> {
  async process({ files }: FileZipInput): Promise<FileZipOutput> {
    if (files.length === 0) {
      throw new Error("ZIP化するファイルを選択してください");
    }
    const names = dedupeFileNames(files.map((file) => sanitizeFileName(file.name)));
    const blob = await createZip(files.map((file, i) => ({ name: names[i], blob: file })));
    return { blob, sizeBytes: blob.size };
  }
}
