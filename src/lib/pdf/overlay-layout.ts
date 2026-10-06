/**
 * PDFへ文字・枠を重ねるツール(ページ番号・透かし・サイズ変更・余白トリミング)の
 * 配置計算。実際の出力(lib/processors/browser/pdf.ts)と画面上のプレビューの
 * 両方から同じ関数を呼ぶことで、「プレビューどおりの位置・形式」を保つ。
 * 座標はPDFの座標系(原点=左下、単位=pt)。
 */

// --- ページ番号 ---
export type PageNumberPosition = "bottom-left" | "bottom-center" | "bottom-right";

export const PAGE_NUMBER_MARGIN = 24;
export const PAGE_NUMBER_COLOR = { r: 0.3, g: 0.3, b: 0.32 };

/** ページ番号の文字(startNumberから数えた、0始まりのページ位置 index 番目の表示) */
export function pageNumberLabel(startNumber: number, index: number): string {
  return String(startNumber + index);
}

/** ページ番号の描画開始位置(文字の左端・ベースライン) */
export function pageNumberPlacement(
  pageWidth: number,
  textWidth: number,
  position: PageNumberPosition
): { x: number; y: number } {
  let x: number;
  if (position === "bottom-left") {
    x = PAGE_NUMBER_MARGIN;
  } else if (position === "bottom-right") {
    x = pageWidth - PAGE_NUMBER_MARGIN - textWidth;
  } else {
    x = (pageWidth - textWidth) / 2;
  }
  return { x, y: PAGE_NUMBER_MARGIN * 0.6 };
}

// --- 透かし ---
export type WatermarkPosition = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const WATERMARK_MARGIN = 32;
export const WATERMARK_COLOR = { r: 0.5, g: 0.5, b: 0.5 };

/** 透かし文字の描画開始位置(回転の中心でもある、文字の左端・ベースライン) */
export function watermarkPlacement(
  pageWidth: number,
  pageHeight: number,
  textWidth: number,
  textHeight: number,
  position: WatermarkPosition
): { x: number; y: number } {
  switch (position) {
    case "top-left":
      return { x: WATERMARK_MARGIN, y: pageHeight - WATERMARK_MARGIN - textHeight };
    case "top-right":
      return { x: pageWidth - WATERMARK_MARGIN - textWidth, y: pageHeight - WATERMARK_MARGIN - textHeight };
    case "bottom-left":
      return { x: WATERMARK_MARGIN, y: WATERMARK_MARGIN };
    case "bottom-right":
      return { x: pageWidth - WATERMARK_MARGIN - textWidth, y: WATERMARK_MARGIN };
    case "center":
    default:
      return { x: (pageWidth - textWidth) / 2, y: (pageHeight - textHeight) / 2 };
  }
}

// --- ページサイズ変更 ---
export type PageSizePreset = "a4" | "a3" | "letter" | "original";
export type PageOrientation = "portrait" | "landscape";
export type ResizeContentMode = "fit" | "keep";

export const PAGE_SIZE_PT: Record<Exclude<PageSizePreset, "original">, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  letter: { width: 612, height: 792 },
};

/** 変更後のページサイズ(pt)。"original"(変更なし)は null */
export function resizeTargetSize(
  pageSize: PageSizePreset,
  orientation: PageOrientation
): { width: number; height: number } | null {
  if (pageSize === "original") return null;
  const base = PAGE_SIZE_PT[pageSize];
  const long = Math.max(base.width, base.height);
  const short = Math.min(base.width, base.height);
  return orientation === "landscape" ? { width: long, height: short } : { width: short, height: long };
}

/**
 * 変更後のページ内での、元ページ内容の位置と大きさ(左下原点・pt)。
 * fit: 縦横比を保って拡大縮小し中央へ。keep: 大きさ・左下の位置は変えない(はみ出した分は切れる)
 */
export function resizeContentRect(
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
  mode: ResizeContentMode
): { x: number; y: number; width: number; height: number; scale: number } {
  if (mode === "fit") {
    const scale = Math.min(newWidth / oldWidth, newHeight / oldHeight);
    const width = oldWidth * scale;
    const height = oldHeight * scale;
    return { x: (newWidth - width) / 2, y: (newHeight - height) / 2, width, height, scale };
  }
  return { x: 0, y: 0, width: oldWidth, height: oldHeight, scale: 1 };
}

// --- 余白トリミング ---
export const MM_TO_PT = 2.8346456693;

export interface CropMarginsMm {
  topMm: number;
  bottomMm: number;
  leftMm: number;
  rightMm: number;
}

/** 余白(mm)を引いた後の表示範囲(元のCropBox基準・左下原点・pt)。大きすぎる余白は null */
export function croppedBox(
  box: { x: number; y: number; width: number; height: number },
  margins: CropMarginsMm
): { x: number; y: number; width: number; height: number } | null {
  const leftPt = margins.leftMm * MM_TO_PT;
  const rightPt = margins.rightMm * MM_TO_PT;
  const topPt = margins.topMm * MM_TO_PT;
  const bottomPt = margins.bottomMm * MM_TO_PT;
  const width = box.width - leftPt - rightPt;
  const height = box.height - topPt - bottomPt;
  if (width <= 1 || height <= 1) return null;
  return { x: box.x + leftPt, y: box.y + bottomPt, width, height };
}
