/**
 * 画像→PDFのページ配置計算。最終出力(ImagesToPdfProcessor)とライブプレビューで同じ計算を使う。
 * 単位はPDFのポイント(画像1pxを1ptとして扱う)。yはPDFの座標系(ページ下端が0)。
 */
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

export type ImageToPdfPageSize = "fit" | "a4";

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
  pageSize: ImageToPdfPageSize
): ImagePageLayout {
  if (pageSize === "a4") {
    const scale = Math.min(A4_WIDTH_PT / imageWidth, A4_HEIGHT_PT / imageHeight, 1);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    return {
      pageWidth: A4_WIDTH_PT,
      pageHeight: A4_HEIGHT_PT,
      x: (A4_WIDTH_PT - width) / 2,
      y: (A4_HEIGHT_PT - height) / 2,
      width,
      height,
    };
  }
  return { pageWidth: imageWidth, pageHeight: imageHeight, x: 0, y: 0, width: imageWidth, height: imageHeight };
}
