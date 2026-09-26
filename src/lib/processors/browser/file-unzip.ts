import { unzipSync, type UnzipFileInfo } from "fflate";
import { BrowserProcessor } from "../types";
import { sanitizeFileName, dedupeFileNames } from "@/lib/utils/format";

/**
 * ZIP解凍（Phase 8）。
 *
 * 既存のcreateZip()（src/lib/utils/zip.ts）と同じfflateをそのまま再利用し、
 * 新しいZIPライブラリは追加しない（開発指示書■5）。
 *
 * セキュリティ（開発指示書■2-1・■6）:
 *  - ZIP内のエントリ名を直接HTML/DOM/ファイルシステムパスとして使わず、
 *    既存のsanitizeFileName()を必ず通す。sanitizeFileName()は"/"を含む
 *    禁止文字をすべて"_"へ置換するため、"../../etc/passwd"のような
 *    パストラバーサルを狙った名前も、スラッシュが失われて単一の
 *    無害なファイル名（".._.._etc_passwd"）に変換される。
 *  - fflateのunzipSync()は、展開（inflate）される「前」に呼ばれる
 *    filterコールバックでエントリごとのサイズ・件数を確認できるため、
 *    実際に展開する前に「ファイル数上限」「単一ファイルサイズ上限」
 *    「合計展開サイズ上限」を強制し、悪意のある/巨大な圧縮ファイル
 *    （ZIP爆弾）による極端なメモリ消費を防ぐ。
 *  - fflateの同期unzip実装が対応する圧縮方式（無圧縮=0 / deflate=8）以外の
 *    エントリはスキップする。
 */

const MAX_ENTRIES = 2000;
const MAX_PER_FILE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_TOTAL_UNCOMPRESSED_BYTES = 300 * 1024 * 1024; // 300MB

export interface FileUnzipInput {
  file: File;
}

export interface UnzippedFileEntry {
  /** sanitizeFileName適用済み・重複解消済みのファイル名 */
  name: string;
  blob: Blob;
  sizeBytes: number;
}

export interface FileUnzipOutput {
  entries: UnzippedFileEntry[];
  /** サイズ・件数上限や非対応の圧縮方式によりスキップされたエントリ数 */
  skippedEntryCount: number;
  totalUncompressedBytes: number;
}

export class FileUnzipProcessor extends BrowserProcessor<FileUnzipInput, FileUnzipOutput> {
  async process({ file }: FileUnzipInput): Promise<FileUnzipOutput> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new Error("ファイルの読み込みに失敗しました");
    }

    let acceptedCount = 0;
    let skippedEntryCount = 0;
    let totalUncompressed = 0;

    const filter = (info: UnzipFileInfo): boolean => {
      // ディレクトリエントリ（末尾が"/"）は中身が無いため展開不要
      if (info.name.endsWith("/")) return false;
      if (info.compression !== 0 && info.compression !== 8) {
        skippedEntryCount += 1;
        return false;
      }
      if (acceptedCount >= MAX_ENTRIES) {
        skippedEntryCount += 1;
        return false;
      }
      if (info.originalSize > MAX_PER_FILE_UNCOMPRESSED_BYTES) {
        skippedEntryCount += 1;
        return false;
      }
      if (totalUncompressed + info.originalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        skippedEntryCount += 1;
        return false;
      }
      acceptedCount += 1;
      totalUncompressed += info.originalSize;
      return true;
    };

    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(bytes, { filter });
    } catch {
      throw new Error(
        "このZIPファイルは読み込めませんでした。ファイルが破損しているか、対応していない形式の可能性があります。"
      );
    }

    const originalNames = Object.keys(unzipped);
    if (originalNames.length === 0) {
      if (skippedEntryCount > 0) {
        throw new Error(
          "すべてのファイルが上限（件数・サイズ）を超えたためスキップされました。より小さいZIPファイルでお試しください。"
        );
      }
      throw new Error("このZIPファイルにはファイルが含まれていません。");
    }

    const uniqueNames = dedupeFileNames(originalNames.map((name) => sanitizeFileName(name)));
    const entries: UnzippedFileEntry[] = originalNames.map((originalName, i) => {
      const data = unzipped[originalName];
      const blob = new Blob([new Uint8Array(data)]);
      return { name: uniqueNames[i], blob, sizeBytes: blob.size };
    });

    return { entries, skippedEntryCount, totalUncompressedBytes: totalUncompressed };
  }
}
