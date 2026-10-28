import { zip, type Zippable } from "fflate";
import { dedupeFileNames, sanitizeFileName } from "@/lib/utils/format";

/**
 * 複数ファイルをまとめてダウンロードするための共通ZIP生成ユーティリティ。
 * バッチ画像変換・PDF分割・PDF→画像など、複数ファイルを出力するツールが
 * それぞれ独自にZIP実装を持たずに済むよう共通化する。
 *
 * ZIP生成はワーカーを使わず同一スレッドで行われるが、fflateは高速なため
 * 現実的なファイル数・サイズであれば体感できるほどのブロッキングは発生しない。
 */
export interface ZipEntry {
  /** ZIP内でのファイル名（重複しないよう呼び出し側で保証すること） */
  name: string;
  blob: Blob;
}

export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  if (entries.length === 0) {
    throw new Error("ZIPに含めるファイルがありません");
  }

  // ZIP内のファイル名も、最後の砦として無害化する（"../" などで展開先の外へ出る名前を作らない）。
  // すでに無害な名前は変わらない。無害化の結果、同名になったものは、番号を付けて区別する。
  const safeNames = dedupeFileNames(entries.map((entry) => sanitizeFileName(entry.name)));

  const zippable: Zippable = {};
  for (const [index, entry] of entries.entries()) {
    zippable[safeNames[index]] = new Uint8Array(await entry.blob.arrayBuffer());
  }

  const data = await new Promise<Uint8Array>((resolve, reject) => {
    zip(zippable, { level: 6 }, (err, result) => {
      if (err || !result) {
        reject(new Error("ZIPファイルの作成に失敗しました"));
        return;
      }
      resolve(result);
    });
  });

  return new Blob([new Uint8Array(data)], { type: "application/zip" });
}
