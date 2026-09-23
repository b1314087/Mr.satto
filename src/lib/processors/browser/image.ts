import { BrowserProcessor, type ImageProcessorOutput } from "../types";

/** File/Blob から HTMLImageElement を読み込む */
function loadImage(file: Blob): Promise<HTMLImageElement> {
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

function canvasToBlob(
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

function toOutput(blob: Blob, width: number, height: number): ImageProcessorOutput {
  return {
    blob,
    url: URL.createObjectURL(blob),
    width,
    height,
    mimeType: blob.type,
    sizeBytes: blob.size,
  };
}

function drawToCanvas(img: HTMLImageElement, width: number, height: number) {
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
