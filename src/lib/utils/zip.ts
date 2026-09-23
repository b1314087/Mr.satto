import { zip, type Zippable } from "fflate";

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

  const zippable: Zippable = {};
  for (const entry of entries) {
    zippable[entry.name] = new Uint8Array(await entry.blob.arrayBuffer());
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
