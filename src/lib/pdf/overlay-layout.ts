/**
 * PDFへ文字・枠を重ねるツール(ページ番号・透かし・サイズ変更・余白トリミング)の
 * 配置計算。実際の出力(lib/processors/browser/pdf.ts)と画面上のプレビューの
 * 両方から同じ関数を呼ぶことで、「プレビューどおりの位置・形式」を保つ。
 * 座標はPDFの座標系(原点=左下、単位=pt)。
 */

// --- ページの回転(/Rotate) ---
//
// PDFのページには /Rotate(90度単位・時計回り)を設定できる。ビューアは、ページ本来の座標系
// (原点=左下)に書かれた内容を、この角度だけ回して表示する。そのため、ページ番号や透かしを
// 「表示されたページの左下・中央・右下」へ、読める向きで置くには、表示上の座標で配置を決めてから
// ページ本来の座標系へ変換し、文字も同じ角度だけ回して描く必要がある。

export type PageRotation = 0 | 90 | 180 | 270;

/**
 * /Rotate の値を 0/90/180/270 に正規化する(負の値・360以上も扱う)。
 * 90の倍数でない値は、PDFの規格上は不正で、PDFビューア(pdf.js等)も無視して0として扱うため、0にする。
 */
export function normalizePageRotation(angle: number): PageRotation {
  if (!Number.isFinite(angle)) return 0;
  const a = ((angle % 360) + 360) % 360;
  return a === 90 || a === 180 || a === 270 ? a : 0;
}

/** 回転を反映した、表示上のページの大きさ(90/270度のとき縦横が入れ替わる) */
export function displayedPageSize(
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: pageHeight, height: pageWidth }
    : { width: pageWidth, height: pageHeight };
}

/**
 * 表示上の座標(u, v: 表示されたページの左下が原点・右が+u・上が+v)を、
 * ページ本来の座標系(x, y: ページの左下が原点)へ変換する。
 * pageWidth/pageHeight は、ページ本来の(回転前の)幅と高さ。
 */
export function displayToPagePoint(
  u: number,
  v: number,
  pageWidth: number,
  pageHeight: number,
  rotation: PageRotation
): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: pageWidth - v, y: u };
    case 180:
      return { x: pageWidth - u, y: pageHeight - v };
    case 270:
      return { x: v, y: pageHeight - u };
    default:
      return { x: u, y: v };
  }
}

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

/**
 * ページ番号を実際に描く位置と向き(ページ本来の座標系)。
 * 左下・中央下・右下は「表示されたページ」を基準にする。ページに /Rotate があるときは、
 * 表示上の位置をページ本来の座標へ変換し、文字も同じ角度だけ回して、表示上は常に正しい向きで読めるようにする。
 * /Rotate がない(0度)ページでは、pageNumberPlacement の結果と同じ値になる。
 * pageWidth/pageHeight は、ページ本来の(回転前の)幅と高さ。angle は pdf-lib の rotate に渡す反時計回りの度数。
 */
export function pageNumberLayout(
  pageWidth: number,
  pageHeight: number,
  pageRotation: number,
  textWidth: number,
  position: PageNumberPosition
): { x: number; y: number; angle: number } {
  const rotation = normalizePageRotation(pageRotation);
  const displayed = displayedPageSize(pageWidth, pageHeight, rotation);
  const { x: u, y: v } = pageNumberPlacement(displayed.width, textWidth, position);
  const { x, y } = displayToPagePoint(u, v, pageWidth, pageHeight, rotation);
  return { x, y, angle: rotation };
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

/** 透かしを収めるために文字を縮めるとき、これより小さくはしない(読めなくなるため。出力側のフォントサイズの下限と同じ) */
export const MIN_WATERMARK_FONT_SIZE = 6;

export interface WatermarkLayoutInput {
  /** ページ本来の(回転前の)幅と高さ(pt) */
  pageWidth: number;
  pageHeight: number;
  /** ページの /Rotate(度) */
  pageRotation: number;
  position: WatermarkPosition;
  /** 指定された文字の大きさ(pt) */
  fontSize: number;
  /** 指定された回転角度(度・反時計回り。表示されたページを基準にした向き) */
  rotation: number;
  /** fontSize で測った文字の幅、高さ(ベースラインより下の部分を含む)、ベースラインより下の部分の高さ */
  textWidth: number;
  textHeight: number;
  textDescent: number;
}

export interface WatermarkLayout {
  /** 文字列の左端・ベースライン(ページ本来の座標系)。回転の中心でもある */
  x: number;
  y: number;
  /** pdf-lib の rotate に渡す反時計回りの度数(指定の回転角度に、ページの /Rotate を足したもの) */
  angle: number;
  /** 実際に使う文字の大きさ(収めるために縮めたときは、指定より小さい) */
  fontSize: number;
  /**
   * none: 指定どおり(従来と同じ配置)／moved: 大きさは変えず、位置だけ調整／shrunk: 大きさも縮めた。
   */
  adjustment: "none" | "moved" | "shrunk";
  /** false = ページが小さすぎる等で、MIN_WATERMARK_FONT_SIZE まで縮めてもページ内に収まらない */
  fits: boolean;
}

/** 浮動小数点の誤差を許す幅(pt) */
const FIT_EPSILON = 1e-6;

/** 文字の枠(左端・ベースラインを原点に、幅×[ベースラインの下 descent 〜 上 ascent])を angle 度回したときの範囲 */
function rotatedTextExtent(width: number, ascent: number, descent: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: [number, number][] = [
    [0, -descent],
    [width, -descent],
    [width, ascent],
    [0, ascent],
  ];
  const xs = corners.map(([px, py]) => px * cos - py * sin);
  const ys = corners.map(([px, py]) => px * sin + py * cos);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/**
 * 透かしを実際に描く位置・向き・大きさ(プレビューと出力で共通)。
 *
 * 1. 従来の配置(watermarkPlacement。文字列の左端・ベースラインを基準に、指定の角度で回す)で、
 *    回したあとの文字全体が表示されたページに収まるなら、大きさ・角度・位置はそのまま(従来と同じ値)。
 * 2. 収まらないときは、まず大きさを変えずに位置だけ調整する。回したあとの文字全体を、指定した位置
 *    (中央・四隅)に寄せる。四隅は余白(WATERMARK_MARGIN)を空け、余白を空けられないときは余白を詰める。
 * 3. 文字全体がページより大きいときだけ、収まる最大の大きさ(0.01pt単位)まで縮め、2のように配置する。
 *    MIN_WATERMARK_FONT_SIZE まで縮めても収まらないときは fits=false(描かない)。
 *
 * 位置は表示されたページを基準にする。/Rotate があるページでは、変換したうえで角度にも /Rotate を足す。
 */
export function watermarkLayout(input: WatermarkLayoutInput): WatermarkLayout {
  const pageRotation = normalizePageRotation(input.pageRotation);
  const displayed = displayedPageSize(input.pageWidth, input.pageHeight, pageRotation);
  const rotation = Number.isFinite(input.rotation) ? input.rotation : 0;
  const descent = Math.max(0, input.textDescent);
  const ascent = input.textHeight - descent;
  const extent = rotatedTextExtent(input.textWidth, ascent, descent, rotation);

  const finish = (
    u: number,
    v: number,
    fontSize: number,
    adjustment: WatermarkLayout["adjustment"],
    fits: boolean
  ): WatermarkLayout => {
    const { x, y } = displayToPagePoint(u, v, input.pageWidth, input.pageHeight, pageRotation);
    return { x, y, angle: rotation + pageRotation, fontSize, adjustment, fits };
  };

  // 1. 従来の配置で、文字全体がページ内に収まるか
  const anchor = watermarkPlacement(displayed.width, displayed.height, input.textWidth, input.textHeight, input.position);
  const insidePage =
    anchor.x + extent.minX >= -FIT_EPSILON &&
    anchor.x + extent.maxX <= displayed.width + FIT_EPSILON &&
    anchor.y + extent.minY >= -FIT_EPSILON &&
    anchor.y + extent.maxY <= displayed.height + FIT_EPSILON;
  if (insidePage) return finish(anchor.x, anchor.y, input.fontSize, "none", true);

  // 3. 文字全体がページより大きいときだけ、収まる大きさまで縮める
  const boxWidth = extent.maxX - extent.minX;
  const boxHeight = extent.maxY - extent.minY;
  let scale = 1;
  let adjustment: WatermarkLayout["adjustment"] = "moved";
  let fontSize = input.fontSize;
  if (boxWidth > displayed.width + FIT_EPSILON || boxHeight > displayed.height + FIT_EPSILON) {
    const fitScale = Math.min(displayed.width / boxWidth, displayed.height / boxHeight);
    fontSize = Math.floor(input.fontSize * fitScale * 100) / 100;
    scale = fontSize / input.fontSize;
    adjustment = "shrunk";
    if (fontSize < MIN_WATERMARK_FONT_SIZE) {
      return finish(anchor.x, anchor.y, fontSize, adjustment, false);
    }
  }

  // 2. 回したあとの文字全体(枠)を、指定した位置に寄せる
  const w = boxWidth * scale;
  const h = boxHeight * scale;
  const left = input.position === "top-left" || input.position === "bottom-left";
  const right = input.position === "top-right" || input.position === "bottom-right";
  const top = input.position === "top-left" || input.position === "top-right";
  const bottom = input.position === "bottom-left" || input.position === "bottom-right";
  const boxX = Math.min(
    Math.max(left ? WATERMARK_MARGIN : right ? displayed.width - WATERMARK_MARGIN - w : (displayed.width - w) / 2, 0),
    displayed.width - w
  );
  const boxY = Math.min(
    Math.max(bottom ? WATERMARK_MARGIN : top ? displayed.height - WATERMARK_MARGIN - h : (displayed.height - h) / 2, 0),
    displayed.height - h
  );
  return finish(boxX - extent.minX * scale, boxY - extent.minY * scale, fontSize, adjustment, true);
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
