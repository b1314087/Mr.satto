/**
 * フォーム回答（CSV/Excel）の「写真の識別子（ファイル名など）」列の値と、
 * 実際にアップロードされた画像ファイル群を安全に対応付ける
 * （開発指示書19章・23章）。
 *
 * ファイル名一致に失敗した場合、絶対に別人の写真を代わりに割り当てない。
 * 一致しない行は「写真なし」として扱い、UI側で手動対応（手動マッピング）
 * できるようにする。
 */
export interface PhotoLookupEntry {
  file: File;
  /** 拡張子付きのファイル名（そのまま） */
  fileName: string;
  /** 拡張子を除いた小文字化済みファイル名（照合用） */
  normalizedStem: string;
}

export function buildPhotoLookup(files: File[]): PhotoLookupEntry[] {
  return files.map((file) => {
    const dot = file.name.lastIndexOf(".");
    const stem = dot === -1 ? file.name : file.name.slice(0, dot);
    return { file, fileName: file.name, normalizedStem: stem.trim().toLowerCase() };
  });
}

/**
 * 識別子（CSV/Excelのセルの値）に対応する画像ファイルを探す。
 * 完全一致（拡張子あり・なしのどちらでも許容）のみを対象とし、
 * 部分一致・あいまい検索は行わない。
 */
export function resolvePhotoForIdentifier(identifier: string, lookup: PhotoLookupEntry[]): File | null {
  const trimmed = identifier.trim();
  if (trimmed === "") return null;
  const normalized = trimmed.toLowerCase();

  const exact = lookup.find((entry) => entry.fileName.toLowerCase() === normalized);
  if (exact) return exact.file;

  const byStem = lookup.find((entry) => entry.normalizedStem === normalized);
  if (byStem) return byStem.file;

  return null;
}
