import { BrowserProcessor, type ImageProcessorOutput } from "../types";
import { loadImage, canvasToBlob, toOutput } from "./image";

/**
 * 画像モザイク（Step 8）。
 *
 * 「画像レイアウト」（自由配置）・「画像結合」（複数→1枚）・
 * 「画像一括余白・文字入れ」（外側へ余白追加）・「画像タイル分割」（1枚→複数）
 * のいずれとも役割が異なり、1枚の画像の「内側」の一部領域をモザイク・ぼかしで
 * 隠すための専用Processor。元画像のサイズ・縦横比・それ以外のピクセルは
 * 変更せず、指定された矩形範囲にだけモザイク/ぼかしを焼き込む。
 *
 * 画像の読み込み・Blob化は image.ts の loadImage / canvasToBlob / toOutput を
 * そのまま再利用し、同じ処理を新規にコピーしない。
 */

export type MosaicKind = "mosaic" | "blur";

export interface MosaicRegion {
  id: string;
  kind: MosaicKind;
  /** 元画像のピクセル座標系（左上原点）での範囲。CSS/Canvas表示座標ではない */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 強度レベル 1〜10（UIの「弱い←→強い」スライダーに対応） */
  level: number;
}

export interface ImageMosaicInput {
  file: File;
  regions: MosaicRegion[];
  format: "png" | "jpeg";
}

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;
export const DEFAULT_LEVEL = 5;
export const MAX_REGIONS = 50;

// 画像レイアウト等の他Processorと同様、極端に大きい画像でブラウザが
// フリーズ・クラッシュしないよう上限を設ける（各ファイルで個別に定義し、
// image-layout.ts 等への結合は作らない）。
const MAX_CANVAS_PIXELS = 40_000_000;

function clampLevel(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(level)));
}

/** モザイクのブロックサイズ(px)。レベル1で8px(弱い)〜レベル10で44px(強い)。 */
export function mosaicBlockSizeForLevel(level: number): number {
  return 4 + clampLevel(level) * 4;
}

/** ぼかしの半径(px)。レベル1で2px(弱い)〜レベル10で20px(強い)。 */
export function blurRadiusForLevel(level: number): number {
  return clampLevel(level) * 2;
}

interface ClampedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 範囲をドラッグ操作で画像の外へはみ出させた場合でも、実際の処理は
 * 画像の内側に安全にクランプする（テスト用にexportし、UI側でも
 * 同じクランプ結果を前提にできるようにする）。
 */
export function clampRegionToImage(
  region: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number
): ClampedRegion {
  const x = Math.max(0, Math.min(region.x, Math.max(0, imageWidth - 1)));
  const y = Math.max(0, Math.min(region.y, Math.max(0, imageHeight - 1)));
  const width = Math.max(0, Math.min(region.width, imageWidth - x));
  const height = Math.max(0, Math.min(region.height, imageHeight - y));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * モザイク（ピクセレーション）: 対象範囲を一旦小さいCanvasへ縮小してから、
 * 補間を無効化して拡大し直すことで、軽量にブロック状の見た目を作る
 * （追加ライブラリ・ピクセル単位ループ不要）。
 */
function applyMosaicRegion(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  region: ClampedRegion,
  level: number
) {
  const { x: sx, y: sy, width: sw, height: sh } = region;
  const blockSize = mosaicBlockSizeForLevel(level);
  const smallW = Math.max(1, Math.round(sw / blockSize));
  const smallH = Math.max(1, Math.round(sh / blockSize));

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = smallW;
  tempCanvas.height = smallH;
  const tempCtx = tempCanvas.getContext("2d");
  if (!tempCtx) throw new Error("Canvasの初期化に失敗しました");
  tempCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, smallW, smallH);

  const prevSmoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tempCanvas, 0, 0, smallW, smallH, sx, sy, sw, sh);
  ctx.imageSmoothingEnabled = prevSmoothing;
}

/**
 * ぼかし: Canvas 2D の `filter: blur()` をそのまま利用する。範囲の外周に
 * パディングを持たせた上で描画・ぼかし・切り出しを行うことで、範囲の境界に
 * 不自然な縁（透明ピクセルの巻き込み）が出ないようにしている。
 */
function applyBlurRegion(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  region: ClampedRegion,
  level: number
) {
  const { x: sx, y: sy, width: sw, height: sh } = region;
  const radius = blurRadiusForLevel(level);
  const padding = Math.ceil(radius * 2);
  const imgWidth = sourceCanvas.width;
  const imgHeight = sourceCanvas.height;
  const psx = Math.max(0, sx - padding);
  const psy = Math.max(0, sy - padding);
  const pex = Math.min(imgWidth, sx + sw + padding);
  const pey = Math.min(imgHeight, sy + sh + padding);
  const pw = pex - psx;
  const ph = pey - psy;
  if (pw <= 0 || ph <= 0) return;

  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = pw;
  tempCanvas.height = ph;
  const tempCtx = tempCanvas.getContext("2d");
  if (!tempCtx) throw new Error("Canvasの初期化に失敗しました");
  tempCtx.filter = `blur(${radius}px)`;
  tempCtx.drawImage(sourceCanvas, psx, psy, pw, ph, 0, 0, pw, ph);

  ctx.drawImage(tempCanvas, sx - psx, sy - psy, sw, sh, sx, sy, sw, sh);
}

export class ImageMosaicProcessor extends BrowserProcessor<ImageMosaicInput, ImageProcessorOutput> {
  async process({ file, regions, format }: ImageMosaicInput): Promise<ImageProcessorOutput> {
    const img = await loadImage(file);
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (width <= 0 || height <= 0) {
      throw new Error("画像の読み込みに失敗しました");
    }
    if (width * height > MAX_CANVAS_PIXELS) {
      throw new Error("画像サイズが大きすぎて処理できません。画像を縮小してからお試しください");
    }
    if (regions.length > MAX_REGIONS) {
      throw new Error(`範囲が多すぎます（最大${MAX_REGIONS}個まで）`);
    }
    // 個人情報等を隠すためのツールのため、UI側のボタン無効化だけに頼らず、
    // 範囲が1つも指定されていない場合はProcessor側でも未加工画像の書き出しを拒否する。
    if (regions.length === 0) {
      throw new Error("モザイク領域を1つ以上指定してください");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");
    ctx.drawImage(img, 0, 0, width, height);

    for (const region of regions) {
      const clamped = clampRegionToImage(region, width, height);
      if (clamped.width <= 0 || clamped.height <= 0) continue;
      if (region.kind === "blur") {
        applyBlurRegion(ctx, canvas, clamped, region.level);
      } else {
        applyMosaicRegion(ctx, canvas, clamped, region.level);
      }
    }

    const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
    let exportCanvas = canvas;
    if (format === "jpeg") {
      // JPEGは透過非対応のため、元画像が透過を持つ場合に備えて白背景を敷く
      // （image.tsのImageConvertProcessorと同じ方式）。
      const flatCanvas = document.createElement("canvas");
      flatCanvas.width = width;
      flatCanvas.height = height;
      const flatCtx = flatCanvas.getContext("2d");
      if (!flatCtx) throw new Error("Canvasの初期化に失敗しました");
      flatCtx.fillStyle = "#ffffff";
      flatCtx.fillRect(0, 0, width, height);
      flatCtx.drawImage(canvas, 0, 0);
      exportCanvas = flatCanvas;
    }

    const blob = await canvasToBlob(exportCanvas, mimeType, 0.92);
    return toOutput(blob, width, height);
  }
}
