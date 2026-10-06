import QRCode from "qrcode";
import { addLogoToQr, type QrLogo } from "@/lib/qr/logo";
import { BrowserProcessor } from "../types";

export interface QrCodeInput {
  text: string;
  size?: number;
  /** 誤り訂正レベル */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  /** 前景(黒い部分)の色。省略時は黒 */
  darkColor?: string;
  /** 背景の色。省略時は白 */
  lightColor?: string;
  /**
   * QRコードの中央または右下に重ねるマーク。指定すると、読み取りやすさのため
   * 誤り訂正レベルは最高の "H" に自動で切り替わる。
   */
  logo?: QrLogo | null;
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
  async process({ text, size = 320, errorCorrectionLevel: requestedEcl = "M", darkColor, lightColor, logo }: QrCodeInput) {
    const errorCorrectionLevel = logo ? "H" : requestedEcl;
    if (!text.trim()) {
      throw new Error("QRコードに変換する内容を入力してください");
    }
    const color =
      darkColor || lightColor ? { dark: darkColor ?? "#000000", light: lightColor ?? "#ffffff" } : undefined;
    const [plainDataUrl, svg] = await Promise.all([
      QRCode.toDataURL(text, {
        width: size,
        errorCorrectionLevel,
        margin: 1,
        color,
      }),
      QRCode.toString(text, {
        type: "svg",
        errorCorrectionLevel,
        margin: 1,
        color,
      }),
    ]);
    const dataUrl = logo ? await addLogoToQr(plainDataUrl, logo, lightColor ?? "#ffffff") : plainDataUrl;
    return { dataUrl, svg };
  }
}
