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

/**
 * 展開するエントリを選ぶフィルタ（実際の解凍とプレビュー用の一覧取得で共通）。
 * ディレクトリ・非対応の圧縮方式・件数／サイズの上限を超えるものを除外し、
 * 通過したエントリについて onAccepted が true を返したものだけを実際に展開する。
 */
function createUnzipFilter(onAccepted: (info: UnzipFileInfo) => boolean) {
  const stats = { accepted: 0, skipped: 0, total: 0 };
  const filter = (info: UnzipFileInfo): boolean => {
    // ディレクトリエントリ（末尾が"/"）は中身が無いため展開不要
    if (info.name.endsWith("/")) return false;
    if (info.compression !== 0 && info.compression !== 8) {
      stats.skipped += 1;
      return false;
    }
    if (stats.accepted >= MAX_ENTRIES) {
      stats.skipped += 1;
      return false;
    }
    if (info.originalSize > MAX_PER_FILE_UNCOMPRESSED_BYTES) {
      stats.skipped += 1;
      return false;
    }
    if (stats.total + info.originalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      stats.skipped += 1;
      return false;
    }
    stats.accepted += 1;
    stats.total += info.originalSize;
    return onAccepted(info);
  };
  return { filter, stats };
}

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

    const { filter, stats } = createUnzipFilter(() => true);

    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(bytes, { filter });
    } catch {
      throw new Error(
        "このZIPファイルは読み込めませんでした。ファイルが破損しているか、対応していない形式の可能性があります。"
      );
    }

    const originalNames = Object.keys(unzipped);
    const skippedEntryCount = stats.skipped;
    const totalUncompressed = stats.total;
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

// ---------------------------------------------------------------------------
// プレビュー用: ZIPの中身一覧（画像のサムネイル・テキストの先頭数行つき）
// ---------------------------------------------------------------------------
const PREVIEW_MAX_FILES = 12;
const PREVIEW_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const PREVIEW_TEXT_MAX_BYTES = 1024 * 1024;
const PREVIEW_TEXT_LINES = 4;

const PREVIEW_IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const PREVIEW_TEXT_EXT = new Set(["txt", "csv", "tsv", "md", "json", "log", "xml", "html", "css", "js"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export interface ZipListingEntry {
  /** 解凍時と同じ（sanitizeFileName適用済み・重複解消済み）ファイル名 */
  name: string;
  sizeBytes: number;
  imageBlob?: Blob;
  textHead?: string[];
}

export interface ZipListing {
  entries: ZipListingEntry[];
  skippedEntryCount: number;
}

/**
 * ZIPの中身を、実際に全部は展開せずに一覧にする。
 * 件数・サイズ上限のルールと名前の決め方は FileUnzipProcessor と同じ
 * （createUnzipFilter / sanitizeFileName / dedupeFileNames を共用）。
 * 小さな画像とテキストだけ先頭 PREVIEW_MAX_FILES 件までプレビュー用に展開する。
 */
export async function listZipContents(file: File): Promise<ZipListing> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error("ファイルの読み込みに失敗しました");
  }

  const accepted: { originalName: string; size: number }[] = [];
  let previewCount = 0;
  const { filter, stats } = createUnzipFilter((info) => {
    accepted.push({ originalName: info.name, size: info.originalSize });
    if (previewCount >= PREVIEW_MAX_FILES) return false;
    const ext = extOf(info.name);
    const isImage = ext in PREVIEW_IMAGE_MIME && info.originalSize <= PREVIEW_IMAGE_MAX_BYTES;
    const isText = PREVIEW_TEXT_EXT.has(ext) && info.originalSize <= PREVIEW_TEXT_MAX_BYTES;
    if (isImage || isText) {
      previewCount += 1;
      return true;
    }
    return false;
  });

  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, { filter });
  } catch {
    throw new Error(
      "このZIPファイルは読み込めませんでした。ファイルが破損しているか、対応していない形式の可能性があります。"
    );
  }

  if (accepted.length === 0) {
    throw new Error(
      stats.skipped > 0
        ? "すべてのファイルが上限（件数・サイズ）を超えたためスキップされました。"
        : "このZIPファイルにはファイルが含まれていません。"
    );
  }

  const uniqueNames = dedupeFileNames(accepted.map((a) => sanitizeFileName(a.originalName)));
  const decoder = new TextDecoder("utf-8");
  const entries: ZipListingEntry[] = accepted.map((a, i) => {
    const entry: ZipListingEntry = { name: uniqueNames[i], sizeBytes: a.size };
    const data = extracted[a.originalName];
    if (!data) return entry;
    const ext = extOf(a.originalName);
    if (ext in PREVIEW_IMAGE_MIME) {
      entry.imageBlob = new Blob([new Uint8Array(data)], { type: PREVIEW_IMAGE_MIME[ext] });
    } else {
      const head = data.subarray(0, 2048);
      if (!head.includes(0)) {
        entry.textHead = decoder
          .decode(head)
          .split(/\r?\n/)
          .slice(0, PREVIEW_TEXT_LINES)
          .map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line));
      }
    }
    return entry;
  });

  return { entries, skippedEntryCount: stats.skipped };
}
