import { RECEIPT_LIMITS } from "./receipt-types";

/**
 * 読み込んだファイルの種類を、拡張子ではなくファイルの先頭のバイトで判定する（工程8）。
 * 拡張子だけで判断すると、名前を変えただけの別形式や壊れたファイルを、そのまま処理に渡してしまうため。
 */

export type ReceiptFileKind = "jpeg" | "png" | "webp" | "pdf";

/** ファイルの先頭のバイトから種類を判定する。対応していない形式・壊れたファイルは null */
export function detectReceiptFileKind(head: Uint8Array): ReceiptFileKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) {
    return "png";
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "webp";
  }
  // PDFは、先頭1024バイトの中に「%PDF-」があればよい（先頭に余分なバイトがあるPDFもある）
  const limit = Math.min(head.length, 1024) - 4;
  for (let i = 0; i <= limit; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return "pdf";
  }
  return null;
}

/** ファイルの種類ごとのサイズ上限（バイト） */
export function maxBytesFor(kind: ReceiptFileKind): number {
  return (kind === "pdf" ? RECEIPT_LIMITS.maxPdfMB : RECEIPT_LIMITS.maxImageMB) * 1024 * 1024;
}

/** 種類とサイズの確認結果。問題がなければ null、問題があれば利用者に見せる理由（ファイル名や内容は含めない） */
export function checkReceiptFile(kind: ReceiptFileKind | null, sizeBytes: number): string | null {
  if (sizeBytes === 0) return "空のファイルです。";
  if (kind === null) {
    return "対応していない形式、またはファイルが壊れています。JPG・PNG・WebP・PDFのファイルを選んでください（HEICなどには対応していません）。";
  }
  if (sizeBytes > maxBytesFor(kind)) {
    const limit = kind === "pdf" ? RECEIPT_LIMITS.maxPdfMB : RECEIPT_LIMITS.maxImageMB;
    return `ファイルサイズが大きすぎます（${kind === "pdf" ? "PDF" : "画像"}は1つ${limit}MBまでです）。`;
  }
  return null;
}
