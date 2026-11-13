/**
 * 画像→PDFのページ配置計算。最終出力(ImagesToPdfProcessor)とライブプレビューで同じ計算を使う。
 * 単位はPDFのポイント(画像1pxを1ptとして扱う)。yはPDFの座標系(ページ下端が0)。
 */
import { resolvePaperSizePt, type PaperSizeId } from "@/lib/print/paper-sizes";

export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

/** "fit" = 画像サイズそのままのページ / "a4" = A4縦に収める（従来の値）/ "paper" = 選んだ用紙サイズ・向きに収める */
export type ImageToPdfPageSize = "fit" | "a4" | "paper";

/** 用紙サイズに収めるときの、用紙と向き（2026-11：A4以外の用紙サイズにも収められるようにした） */
export interface ImageToPdfPaper {
  id: PaperSizeId;
  /** auto = 画像の向き（横長なら横向き）に合わせる */
  orientation: "portrait" | "landscape" | "auto";
}

export const DEFAULT_IMAGE_TO_PDF_PAPER: ImageToPdfPaper = { id: "A4", orientation: "portrait" };

export interface ImagePageLayout {
  pageWidth: number;
  pageHeight: number;
  /** 画像の左下のx・y(PDF座標) */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function computeImagePageLayout(
  imageWidth: number,
  imageHeight: number,
  pageSize: ImageToPdfPageSize,
  paper: ImageToPdfPaper = DEFAULT_IMAGE_TO_PDF_PAPER
): ImagePageLayout {
  if (pageSize === "a4" || pageSize === "paper") {
    const chosen = pageSize === "a4" ? DEFAULT_IMAGE_TO_PDF_PAPER : paper;
    const orientation = chosen.orientation === "auto" ? (imageWidth > imageHeight ? "landscape" : "portrait") : chosen.orientation;
    const { width: pageWidth, height: pageHeight } = resolvePaperSizePt(chosen.id, orientation);
    // 用紙より小さい画像は拡大しない（従来のA4と同じ）。大きい画像は縦横比を保って収める
    const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight, 1);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    return {
      pageWidth,
      pageHeight,
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    };
  }
  return { pageWidth: imageWidth, pageHeight: imageHeight, x: 0, y: 0, width: imageWidth, height: imageHeight };
}
