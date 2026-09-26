import { BrowserProcessor, type ImageProcessorOutput } from "../types";

/**
 * File/Blob から HTMLImageElement を読み込む。
 * PDF系Processor（image-to-pdf等）からも再利用するため export する
 * （「すでにある処理を再実装しない」ための共通化）。
 */
export function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像の読み込みに失敗しました"));
    };
    img.src = url;
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("画像の書き出しに失敗しました"));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Phase 6で追加した画像反転・グレースケール・明るさ/コントラスト調整の
 * Processorからも再利用するため export する（新規ツールでの再実装を避ける）。
 */
export function toOutput(blob: Blob, width: number, height: number): ImageProcessorOutput {
  return {
    blob,
    url: URL.createObjectURL(blob),
    width,
    height,
    mimeType: blob.type,
    sizeBytes: blob.size,
  };
}

export function drawToCanvas(img: HTMLImageElement, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

// ---------------------------------------------------------------------------
// リサイズ
// ---------------------------------------------------------------------------
export interface ImageResizeInput {
  file: File;
  width: number;
  height: number;
  mimeType?: string;
}

export class ImageResizeProcessor extends BrowserProcessor<
  ImageResizeInput,
  ImageProcessorOutput
> {
  async process({ file, width, height, mimeType }: ImageResizeInput) {
    if (width <= 0 || height <= 0) {
      throw new Error("幅と高さは1以上を指定してください");
    }
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, Math.round(width), Math.round(height));
    const outType = mimeType ?? file.type ?? "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 圧縮（品質指定）
// ---------------------------------------------------------------------------
export interface ImageCompressInput {
  file: File;
  /** 0〜1 */
  quality: number;
  mimeType?: string;
}

export class ImageCompressProcessor extends BrowserProcessor<
  ImageCompressInput,
  ImageProcessorOutput
> {
  async process({ file, quality, mimeType }: ImageCompressInput) {
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    const outType = mimeType ?? (file.type === "image/png" ? "image/png" : "image/jpeg");
    const blob = await canvasToBlob(canvas, outType, Math.min(Math.max(quality, 0.01), 1));
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 指定KBまで圧縮（2分探索で品質を調整）
// ---------------------------------------------------------------------------
export interface ImageCompressToSizeInput {
  file: File;
  targetKB: number;
  mimeType?: string;
}

export class ImageCompressToSizeProcessor extends BrowserProcessor<
  ImageCompressToSizeInput,
  ImageProcessorOutput
> {
  async process({ file, targetKB, mimeType }: ImageCompressToSizeInput) {
    if (targetKB <= 0) throw new Error("目標サイズは1KB以上を指定してください");
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    const outType =
      mimeType ?? (file.type === "image/png" ? "image/jpeg" : file.type || "image/jpeg");
    const targetBytes = targetKB * 1024;

    let low = 0.02;
    let high = 1;
    let best = await canvasToBlob(canvas, outType, high);

    // 目標サイズより既に小さければそのまま返す
    if (best.size <= targetBytes) {
      return toOutput(best, canvas.width, canvas.height);
    }

    for (let i = 0; i < 8; i++) {
      const mid = (low + high) / 2;
      const candidate = await canvasToBlob(canvas, outType, mid);
      if (candidate.size > targetBytes) {
        high = mid;
      } else {
        low = mid;
        best = candidate;
      }
    }

    return toOutput(best, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 形式変換（JPG / PNG / WebP）
// ---------------------------------------------------------------------------
export interface ImageConvertInput {
  file: File;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export class ImageConvertProcessor extends BrowserProcessor<
  ImageConvertInput,
  ImageProcessorOutput
> {
  async process({ file, mimeType }: ImageConvertInput) {
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    if (mimeType === "image/jpeg") {
      // JPGは透過非対応のため白背景を敷く
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
    const blob = await canvasToBlob(canvas, mimeType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 回転
// ---------------------------------------------------------------------------
export interface ImageRotateInput {
  file: File;
  /** 90度単位 */
  degrees: 90 | 180 | 270;
}

export class ImageRotateProcessor extends BrowserProcessor<
  ImageRotateInput,
  ImageProcessorOutput
> {
  async process({ file, degrees }: ImageRotateInput) {
    const img = await loadImage(file);
    const swap = degrees === 90 || degrees === 270;
    const width = swap ? img.naturalHeight : img.naturalWidth;
    const height = swap ? img.naturalWidth : img.naturalHeight;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    ctx.translate(width / 2, height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

    const outType = file.type || "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// トリミング（Phase 2-A）
// 画像トリミングツール・SNSサイズ変換ツールの両方から利用する共通Processor。
// 「切り抜き範囲の決め方」（自由選択 / 比率プリセットからの中央揃え）はUI側の
// 責務とし、このProcessorは「与えられた範囲を切り抜いて必要なら指定サイズへ
// 描画し直す」ことだけを行う。
// ---------------------------------------------------------------------------
export interface CropRegion {
  /** 元画像のピクセル座標系での切り抜き位置・サイズ */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCropInput {
  file: File;
  crop: CropRegion;
  /** 指定時は切り抜き後にこのサイズへ描画し直す（未指定なら切り抜きサイズのまま） */
  targetWidth?: number;
  targetHeight?: number;
  mimeType?: string;
}

export class ImageCropProcessor extends BrowserProcessor<ImageCropInput, ImageProcessorOutput> {
  async process({ file, crop, targetWidth, targetHeight, mimeType }: ImageCropInput) {
    if (crop.width <= 0 || crop.height <= 0) {
      throw new Error("切り抜き範囲が正しくありません");
    }
    const img = await loadImage(file);
    const sx = Math.max(0, Math.min(crop.x, img.naturalWidth - 1));
    const sy = Math.max(0, Math.min(crop.y, img.naturalHeight - 1));
    const sw = Math.max(1, Math.min(crop.width, img.naturalWidth - sx));
    const sh = Math.max(1, Math.min(crop.height, img.naturalHeight - sy));

    const outWidth = Math.round(targetWidth ?? sw);
    const outHeight = Math.round(targetHeight ?? sh);
    if (outWidth <= 0 || outHeight <= 0) {
      throw new Error("出力サイズが正しくありません");
    }

    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outWidth, outHeight);

    const outType = mimeType ?? file.type ?? "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 反転（Phase 6）
// ---------------------------------------------------------------------------
export interface ImageFlipInput {
  file: File;
  direction: "horizontal" | "vertical";
}

export class ImageFlipProcessor extends BrowserProcessor<ImageFlipInput, ImageProcessorOutput> {
  async process({ file, direction }: ImageFlipInput) {
    const img = await loadImage(file);
    const width = img.naturalWidth;
    const height = img.naturalHeight;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    if (direction === "horizontal") {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(0, height);
      ctx.scale(1, -1);
    }
    ctx.drawImage(img, 0, 0);

    const outType = file.type || "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// グレースケール（Phase 6）
// ---------------------------------------------------------------------------
export interface ImageGrayscaleInput {
  file: File;
}

export class ImageGrayscaleProcessor extends BrowserProcessor<
  ImageGrayscaleInput,
  ImageProcessorOutput
> {
  async process({ file }: ImageGrayscaleInput) {
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    // 元画像を直接書き換えず、Canvas上の複製に対してのみ処理する。
    // アルファチャンネル（透過）は変更しない。
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // 知覚輝度に近い重み付け（ITU-R BT.601）でグレー値を求める
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      // data[i + 3]（アルファ）はそのまま
    }
    ctx.putImageData(imageData, 0, 0);

    const outType = file.type || "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 明るさ・コントラスト調整（Phase 6）
// ---------------------------------------------------------------------------
export interface ImageAdjustInput {
  file: File;
  /** -100〜100 */
  brightness: number;
  /** -100〜100 */
  contrast: number;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, value));
}

export class ImageAdjustProcessor extends BrowserProcessor<ImageAdjustInput, ImageProcessorOutput> {
  async process({ file, brightness, contrast }: ImageAdjustInput) {
    if (
      !Number.isFinite(brightness) ||
      !Number.isFinite(contrast) ||
      brightness < -100 ||
      brightness > 100 ||
      contrast < -100 ||
      contrast > 100
    ) {
      throw new Error("明るさ・コントラストは-100〜100の範囲で指定してください");
    }
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    // UIの -100〜100 を、-255〜255 の内部値へ変換してから既知のコントラスト式を適用する。
    // 極端な値（±100）でも式自体は破綻しない（±255の範囲で必ず有限の値になる）。
    const brightnessShift = brightness * 2.55;
    const contrastValue = contrast * 2.55;
    const contrastFactor = (259 * (contrastValue + 255)) / (255 * (259 - contrastValue));

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clampByte(contrastFactor * (data[i] - 128) + 128 + brightnessShift);
      data[i + 1] = clampByte(contrastFactor * (data[i + 1] - 128) + 128 + brightnessShift);
      data[i + 2] = clampByte(contrastFactor * (data[i + 2] - 128) + 128 + brightnessShift);
    }
    ctx.putImageData(imageData, 0, 0);

    const outType = file.type || "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 画像メタデータ削除（Phase 8）
// ---------------------------------------------------------------------------
export interface ImageMetadataRemoveInput {
  file: File;
  /** 省略時は元の形式を維持する（Canvasが再エンコードできない形式はPNGにフォールバック） */
  outputMimeType?: "image/jpeg" | "image/png" | "image/webp";
  /** JPEG/WebP書き出し時の画質(0〜1)。省略時は0.92 */
  quality?: number;
}

const CANVAS_REENCODABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Canvasへ描画し直して再エンコードすることで、元ファイルのバイト列に
 * 含まれていたEXIF等の付随データを持ち越さない（=結果のBlobは常に
 * 新規生成された、元とは別のバイト列になる）。
 *
 * 重要な注意（開発指示書■11・■44）: これは「ブラウザのCanvasが再現できる
 * 画素情報だけを新しいファイルとして書き出す」処理であり、
 * 「あらゆるメタデータ形式を検出して確実に除去した」ことを保証するものではない。
 * 出力形式は必ずJPEG/PNG/WebPのいずれかになり（Canvas.toBlob()の対応形式）、
 * 元がそれ以外の形式だった場合は元の形式を維持できない。UI側でこの2点を
 * 明示する。
 */
export class ImageMetadataRemoveProcessor extends BrowserProcessor<
  ImageMetadataRemoveInput,
  ImageProcessorOutput
> {
  async process({ file, outputMimeType, quality }: ImageMetadataRemoveInput) {
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    const requested = outputMimeType ?? file.type;
    const outType = CANVAS_REENCODABLE_TYPES.has(requested) ? requested : "image/png";
    const blob = await canvasToBlob(canvas, outType, quality ?? 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// 画像ウォーターマーク（Phase 8）
// ---------------------------------------------------------------------------
export type ImageWatermarkPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center";

export interface ImageWatermarkInput {
  file: File;
  text: string;
  position: ImageWatermarkPosition;
  /** 0〜1 */
  opacity: number;
  fontSize: number;
  /** 度数（時計回り） */
  rotation: number;
}

/**
 * Canvasへテキストを描画してから再書き出しする。元のFile/Blobは一切変更せず、
 * 新しいBlobを結果として返す（開発指示書■12）。
 * PDF透かし（src/lib/processors/browser/pdf.ts の PdfWatermarkProcessor）の
 * 「位置・不透明度・回転」という設定項目の考え方は踏襲しつつ、画像用に
 * 新しいライブラリは追加せずCanvas APIだけで実装している。
 */
export class ImageWatermarkProcessor extends BrowserProcessor<
  ImageWatermarkInput,
  ImageProcessorOutput
> {
  async process({ file, text, position, opacity, fontSize, rotation }: ImageWatermarkInput) {
    if (text.trim() === "") {
      throw new Error("透かしの文字を入力してください");
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new Error("不透明度は0〜1の範囲で指定してください");
    }
    if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 400) {
      throw new Error("フォントサイズは6〜400の範囲で指定してください");
    }
    const img = await loadImage(file);
    const canvas = drawToCanvas(img, img.naturalWidth, img.naturalHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    ctx.font = `${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(text).width;
    const margin = Math.max(8, Math.round(Math.min(canvas.width, canvas.height) * 0.03));

    let x: number;
    let y: number;
    switch (position) {
      case "top-left":
        x = margin;
        y = margin + fontSize;
        break;
      case "top-right":
        x = canvas.width - margin - textWidth;
        y = margin + fontSize;
        break;
      case "bottom-left":
        x = margin;
        y = canvas.height - margin;
        break;
      case "bottom-right":
        x = canvas.width - margin - textWidth;
        y = canvas.height - margin;
        break;
      case "center":
      default:
        x = (canvas.width - textWidth) / 2;
        y = (canvas.height + fontSize) / 2;
        break;
    }

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(x + textWidth / 2, y - fontSize / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-(x + textWidth / 2), -(y - fontSize / 2));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.lineWidth = Math.max(1, fontSize / 16);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillStyle = "#ffffff";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();

    const outType = file.type || "image/png";
    const blob = await canvasToBlob(canvas, outType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}

/**
 * 指定した比率(width/height)に収まるよう、中央基準で切り抜く範囲を計算する。
 * SNSサイズ変換ツールが「不必要に引き伸ばさず」プリセット比率へ合わせるために使う
 * （長い方の辺を切り詰め、短い方の辺はそのまま使う＝拡大縮小のみで引き伸ばしはしない）。
 */
export function computeCenterCropForAspect(
  sourceWidth: number,
  sourceHeight: number,
  aspectRatio: number
): CropRegion {
  const sourceRatio = sourceWidth / sourceHeight;
  let width = sourceWidth;
  let height = sourceHeight;
  if (sourceRatio > aspectRatio) {
    width = Math.max(1, Math.round(sourceHeight * aspectRatio));
  } else {
    height = Math.max(1, Math.round(sourceWidth / aspectRatio));
  }
  return {
    x: Math.round((sourceWidth - width) / 2),
    y: Math.round((sourceHeight - height) / 2),
    width,
    height,
  };
}
