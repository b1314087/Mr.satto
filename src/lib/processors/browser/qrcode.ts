import QRCode from "qrcode";
import { BrowserProcessor } from "../types";

export interface QrCodeInput {
  text: string;
  size?: number;
  /** 誤り訂正レベル */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
}

export interface QrCodeOutput {
  dataUrl: string;
  svg: string;
}

/**
 * QRコード生成。npm の `qrcode` パッケージを使い、
 * 完全にブラウザ内で完結する（外部APIへの通信は発生しない）。
 */
export class QrCodeProcessor extends BrowserProcessor<QrCodeInput, QrCodeOutput> {
  async process({ text, size = 320, errorCorrectionLevel = "M" }: QrCodeInput) {
    if (!text.trim()) {
      throw new Error("QRコードに変換する内容を入力してください");
    }
    const [dataUrl, svg] = await Promise.all([
      QRCode.toDataURL(text, {
        width: size,
        errorCorrectionLevel,
        margin: 1,
      }),
      QRCode.toString(text, {
        type: "svg",
        errorCorrectionLevel,
        margin: 1,
      }),
    ]);
    return { dataUrl, svg };
  }
}
