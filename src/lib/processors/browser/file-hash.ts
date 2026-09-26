import { BrowserProcessor } from "../types";

/**
 * ファイルハッシュ（SHA-256）（Phase 8）。
 *
 * Web Crypto API（crypto.subtle.digest）のみを使い、新しい暗号ライブラリは
 * 追加しない（開発指示書■5・■32）。MD5等の脆弱なハッシュは実装しておらず、
 * 「安全なハッシュ」という誤解を招く表現もしない（開発指示書■2-2）。
 * ファイル内容はブラウザ内で計算されるだけで、どこにも送信されない。
 */
export interface FileHashInput {
  file: File;
}

export interface FileHashOutput {
  fileName: string;
  sizeBytes: number;
  algorithm: "SHA-256";
  hashHex: string;
}

export class FileHashProcessor extends BrowserProcessor<FileHashInput, FileHashOutput> {
  async process({ file }: FileHashInput): Promise<FileHashOutput> {
    if (typeof crypto === "undefined" || !crypto.subtle) {
      throw new Error(
        "お使いのブラウザはこの機能に対応していません（Web Crypto APIが利用できません）。"
      );
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      throw new Error("ファイルの読み込みに失敗しました");
    }

    let digest: ArrayBuffer;
    try {
      digest = await crypto.subtle.digest("SHA-256", buffer);
    } catch {
      throw new Error("ハッシュの計算に失敗しました");
    }

    const hashHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return {
      fileName: file.name,
      sizeBytes: file.size,
      algorithm: "SHA-256",
      hashHex,
    };
  }
}
