/**
 * 画像・スキャンPDFを、AIに送るための小さなJPEGにする（ブラウザの中だけで行う。この時点では何も送信しない）。
 *
 * - 画像（PNG/JPEG）: 長辺を縮小し、JPEGにして、1枚の大きさの上限（MAX_IMAGE_BYTES）に収める。
 *   透明な部分は白にする。写真の向き（EXIF）は、ブラウザの読み込みが反映する。
 * - PDF: 文字情報がなく文字として読めないPDFを、先頭のページから順に画像にする（最大 MAX_IMAGES ページ）。
 * 送る画像は、縮小・変換したものだけ。元のファイルそのものは送らない。
 */
import { MAX_IMAGES, MAX_IMAGE_BYTES } from "@/lib/ai/calendar-assist";
import { loadPdfDocument, renderPageToCanvas } from "@/lib/pdf/pdfjs-client";

export interface PreparedImage {
  mediaType: "image/jpeg";
  base64: string;
  width: number;
  height: number;
  bytes: number;
  /** 画面に出す名前（ファイル名・ページ番号） */
  label: string;
}

/** 画像1枚の元ファイルの大きさの上限（スマートフォンの写真を想定） */
export const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
/** 画像の長辺の初期値(px)。表の小さな文字が読める大きさで、送る量を抑える */
const LONG_SIDE_START = 2000;
const LONG_SIDE_MIN = 900;

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像の変換に失敗しました"))), "image/jpeg", quality);
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** 白い背景に描き直して、長辺を longSide 以下にしたキャンバス */
function drawScaled(source: CanvasImageSource, width: number, height: number, longSide: number): HTMLCanvasElement {
  const ratio = Math.min(1, longSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像の処理を始められませんでした");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 上限に収まるまで、画質→大きさの順に下げてJPEGにする。収まらなければ null */
async function encodeWithin(source: CanvasImageSource, width: number, height: number, label: string): Promise<PreparedImage | null> {
  for (let longSide = LONG_SIDE_START; longSide >= LONG_SIDE_MIN; longSide = Math.round(longSide * 0.8)) {
    const canvas = drawScaled(source, width, height, longSide);
    for (const quality of [0.85, 0.72, 0.6]) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size <= MAX_IMAGE_BYTES) {
        return { mediaType: "image/jpeg", base64: await blobToBase64(blob), width: canvas.width, height: canvas.height, bytes: blob.size, label };
      }
    }
  }
  return null;
}

/** キャンバス（PDFのページなど）→ AIに送るJPEG。上限に収まらなければ null */
export async function encodeCanvasForAi(canvas: HTMLCanvasElement, label: string): Promise<PreparedImage | null> {
  return encodeWithin(canvas, canvas.width, canvas.height, label);
}

const TOO_BIG = "画像を小さくできませんでした。画像を切り取るなどして、もう一度お試しください。";

/** 画像ファイル（PNG/JPEG）→ AIに送るJPEG */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
  if (file.size === 0) throw new Error("空のファイルは読み込めません。");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error("画像が大きすぎます（25MBまで）。画像を小さくして、もう一度お試しください。");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name} を画像として読み込めませんでした。ファイルが壊れていないか確認してください。`);
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error("画像の縦横の大きさが大きすぎます。画像を小さくして、もう一度お試しください。");
    const prepared = await encodeWithin(bitmap, bitmap.width, bitmap.height, file.name);
    if (!prepared) throw new Error(TOO_BIG);
    return prepared;
  } finally {
    bitmap.close();
  }
}

/** 画像のバイト列（PNG/JPEG）→ AIに送るJPEG（PowerPointに挿入された画像など、ファイルではない画像用） */
export async function prepareImageBytes(bytes: Uint8Array, mime: "image/png" | "image/jpeg", label: string): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    throw new Error(`${label} を画像として読み込めませんでした。`);
  }
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error(`${label} は、縦横の大きさが大きすぎます。`);
    const prepared = await encodeWithin(bitmap, bitmap.width, bitmap.height, label);
    if (!prepared) throw new Error(TOO_BIG);
    return prepared;
  } finally {
    bitmap.close();
  }
}

export interface PreparedPdfPages {
  images: PreparedImage[];
  pageCount: number;
  /** 先頭の MAX_IMAGES ページだけを画像にしたか */
  truncated: boolean;
}

/** PDFの先頭のページを、AIに送るJPEGにする（ページ数が多いときは先頭の MAX_IMAGES ページだけ） */
export async function preparePdfPages(file: File, onProgress?: (message: string) => void): Promise<PreparedPdfPages> {
  onProgress?.("PDFを読み込んでいます…");
  const pdf = await loadPdfDocument(file);
  if (pdf.numPages === 0) throw new Error("このPDFにはページがありません");
  const used = Math.min(pdf.numPages, MAX_IMAGES);
  const images: PreparedImage[] = [];
  for (let n = 1; n <= used; n++) {
    onProgress?.(`${n}/${used}ページ目を画像にしています…`);
    let canvas: HTMLCanvasElement;
    try {
      const page = await pdf.getPage(n);
      canvas = (await renderPageToCanvas(page, 2, LONG_SIDE_START)).canvas;
    } catch {
      throw new Error(`${n}ページ目を画像にできませんでした。`);
    }
    const prepared = await encodeWithin(canvas, canvas.width, canvas.height, `${n}ページ目`);
    if (!prepared) throw new Error(TOO_BIG);
    images.push(prepared);
  }
  return { images, pageCount: pdf.numPages, truncated: pdf.numPages > used };
}
