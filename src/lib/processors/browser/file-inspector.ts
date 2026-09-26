import { BrowserProcessor } from "../types";
import { loadImage } from "./image";
import { getPdfPageCount } from "./pdf";
import { parseCsv, isBlankRow } from "@/lib/utils/csv";
import { getExtension } from "@/lib/utils/format";

/**
 * ファイル情報確認（Phase 8）。
 *
 * 重要な注意（開発指示書■7）: 「不必要にファイル全体を読み込まない」ことを
 * 徹底する。
 *  - 画像: File→Object URL→<img>にデコードさせて幅・高さだけを取得する
 *    （画像データを文字列化することはしない。既存のloadImage()をそのまま再利用）。
 *  - PDF: 既存のgetPdfPageCount()（pdf-lib）でページ数だけを取得する
 *    （全ページのレンダリングは行わない）。
 *  - CSV/TXT: TEXT_INSPECT_MAX_BYTESを超える大きなファイルは、行数・列数の
 *    集計自体をスキップする（「巨大ファイルを無条件に全文字列化する」ことを避ける）。
 *    それ未満のファイルはシンプルに全文読み込んで集計する
 *    （開発指示書が許容する「小さいファイルを対象とした単純な実装」に相当）。
 */

const TEXT_INSPECT_MAX_BYTES = 20 * 1024 * 1024; // 20MB

export interface FileInspectorInput {
  file: File;
}

export interface FileInspectorTextInfo {
  lines: number;
  /** CSVの場合のみ列数を返す（TXTはnull） */
  columns: number | null;
  /** ファイルサイズが大きく、内容の集計をスキップした場合true */
  skippedLargeFile: boolean;
}

export interface FileInspectorOutput {
  name: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  lastModifiedMs: number;
  imageDimensions: { width: number; height: number } | null;
  pdfPageCount: number | null;
  textInfo: FileInspectorTextInfo | null;
}

export class FileInspectorProcessor extends BrowserProcessor<
  FileInspectorInput,
  FileInspectorOutput
> {
  async process({ file }: FileInspectorInput): Promise<FileInspectorOutput> {
    const extension = getExtension(file.name).toLowerCase();
    const mimeType = file.type || "unknown";

    let imageDimensions: { width: number; height: number } | null = null;
    let pdfPageCount: number | null = null;
    let textInfo: FileInspectorTextInfo | null = null;

    if (mimeType.startsWith("image/")) {
      try {
        const img = await loadImage(file);
        imageDimensions = { width: img.naturalWidth, height: img.naturalHeight };
      } catch {
        // 破損画像等は寸法不明のまま、他の情報だけ返す
      }
    } else if (mimeType === "application/pdf" || extension === "pdf") {
      try {
        pdfPageCount = await getPdfPageCount(file);
      } catch {
        // 破損・パスワード保護PDF等はページ数不明のまま、他の情報だけ返す
      }
    } else if (mimeType === "text/csv" || mimeType === "text/plain" || extension === "csv" || extension === "txt") {
      if (file.size > TEXT_INSPECT_MAX_BYTES) {
        textInfo = { lines: 0, columns: null, skippedLargeFile: true };
      } else {
        try {
          const text = await file.text();
          if (extension === "csv" || mimeType === "text/csv") {
            const rows = parseCsv(text).filter((row) => !isBlankRow(row));
            textInfo = {
              lines: rows.length,
              columns: rows.length > 0 ? rows[0].length : 0,
              skippedLargeFile: false,
            };
          } else {
            const rawLines = text.split(/\r\n|\r|\n/);
            // 末尾の改行が余分な空行を生まないよう、最後の1行だけ空文字なら除く
            if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
              rawLines.pop();
            }
            textInfo = { lines: rawLines.length, columns: null, skippedLargeFile: false };
          }
        } catch {
          // 読み込み失敗時は他の情報だけ返す
        }
      }
    }

    return {
      name: file.name,
      mimeType,
      extension,
      sizeBytes: file.size,
      lastModifiedMs: file.lastModified,
      imageDimensions,
      pdfPageCount,
      textInfo,
    };
  }
}
