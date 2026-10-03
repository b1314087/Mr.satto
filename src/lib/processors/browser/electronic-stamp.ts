import { BrowserProcessor, type ImageProcessorOutput } from "../types";
import { canvasToBlob, toOutput, type CropRegion } from "./image";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";

/**
 * 電子印鑑生成（印影画像の作成・取り込み）Processor（Phase 16）。
 *
 * 重要: これは「印影画像（PNG）を作るためのツール」であり、法的な効力を持つ
 * 電子署名・デジタル署名・電子契約機能ではない。UI・SEO・本ファイルの
 * コメントも含め、「電子署名」という語は用いない。
 *
 * 設計方針:
 * - AI/LLM/外部API（背景除去API・OCR API含む）は一切使用しない。
 * - PDF読み込みは新規レンダラーを追加せず、既存の共通PDF基盤
 *   （src/lib/pdf/pdfjs-client.ts の loadPdfDocument。pdf-render.ts の
 *   PdfToImageProcessorと同じ土台）をそのまま利用する。
 * - 画像の読み込み・Canvas書き出しは src/lib/processors/browser/image.ts の
 *   canvasToBlob/toOutput/CropRegion 型をそのまま再利用し、重複実装しない。
 * - 背景除去はしきい値（明度）に基づく決定的な処理のみで行い、AIは使わない。
 *   色相を見ないため、赤・黒・青などどの色の印影にも同じロジックが適用できる
 *   （「赤色専用」にしない、という要件を満たす）。
 * - すべての中間処理はブラウザのCanvas上のみで完結し、画像・PDFの中身を
 *   サーバーへ送信したり、localStorage/sessionStorage/IndexedDBへ保存したり
 *   することは一切ない。
 */

// ---------------------------------------------------------------------------
// 共通の上限・定数
// ---------------------------------------------------------------------------

export const STAMP_LIMITS = {
  /** 文字から生成する印影の1辺(直径)の最大px */
  maxStampSizePx: 600,
  minStampSizePx: 120,
  /** 中央テキストの最大文字数（大量デザインテンプレート化を避けるための実用上の上限） */
  maxTextLength: 8,
  /** 取り込みフローで最終的に書き出す画像の最大辺(px)。ブラウザメモリ圧迫を防ぐための上限 */
  maxOutputDimensionPx: 2000,
  /** 出力時の拡大倍率の上限（小さすぎる画像を無条件に拡大して不自然な高解像度にしないため） */
  maxUpscaleRatio: 3,
  /** 背景透過処理を行うCanvasの最大ピクセル数（幅×高さ）。過大な画像による処理落ちを防ぐ */
  maxProcessablePixels: 20_000_000,
} as const;

export type StampShape = "round" | "square";
export type StampTextLayout = "horizontal" | "vertical";
export type StampColorId = "red" | "black" | "blue";

export const STAMP_COLORS: Record<StampColorId, string> = {
  red: "#b7282e",
  black: "#1a1a1a",
  blue: "#1f3a8f",
};

const CANVAS_FONT_FAMILY =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", system-ui, sans-serif';

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  return ctx;
}

// ---------------------------------------------------------------------------
// A. 文字から印影を生成
// ---------------------------------------------------------------------------

export interface StampTextGenerateInput {
  text: string;
  shape: StampShape;
  layout: StampTextLayout;
  /** 出力画像の1辺(px)。丸印は直径、角印は1辺の長さ */
  sizePx: number;
  /** 文字サイズの倍率(0.6〜1.4程度を想定) */
  fontScale: number;
  /** 枠線の太さ比率（サイズに対する割合、0.02〜0.08程度を想定） */
  borderWidthRatio: number;
  /** 内側の余白比率（0〜0.25程度を想定） */
  paddingRatio: number;
  color: StampColorId;
  /** 文字位置の水平方向オフセット（サイズに対する割合、-20〜20を想定） */
  offsetXPct: number;
  /** 文字位置の垂直方向オフセット（サイズに対する割合、-20〜20を想定） */
  offsetYPct: number;
}

function splitIntoColumns(chars: string[]): string[][] {
  if (chars.length <= 3) return [chars];
  // 4文字以上は伝統的な印影に近づけるため2列に分ける
  const perCol = Math.ceil(chars.length / 2);
  return [chars.slice(0, perCol), chars.slice(perCol)];
}

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  startPx: number,
  maxWidth: number,
  weight = "bold"
): number {
  let fontPx = startPx;
  ctx.font = `${weight} ${fontPx}px ${CANVAS_FONT_FAMILY}`;
  while (fontPx > 8 && ctx.measureText(text).width > maxWidth) {
    fontPx -= 1;
    ctx.font = `${weight} ${fontPx}px ${CANVAS_FONT_FAMILY}`;
  }
  return fontPx;
}

function drawStampText(
  ctx: CanvasRenderingContext2D,
  params: {
    text: string;
    layout: StampTextLayout;
    cx: number;
    cy: number;
    /** テキストを収める領域の一辺（正方形近似） */
    innerBoxSize: number;
    fontScale: number;
    offsetXPct: number;
    offsetYPct: number;
    color: string;
  }
) {
  const { text, layout, cx, cy, innerBoxSize, fontScale, offsetXPct, offsetYPct, color } = params;
  const chars = Array.from(text);
  if (chars.length === 0) return;

  const offsetX = (offsetXPct / 100) * innerBoxSize;
  const offsetY = (offsetYPct / 100) * innerBoxSize;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (layout === "horizontal" || chars.length === 1) {
    const fontPx = fitFontSize(ctx, text, innerBoxSize * 0.62 * fontScale, innerBoxSize * 0.92);
    ctx.font = `bold ${fontPx}px ${CANVAS_FONT_FAMILY}`;
    ctx.fillText(text, cx + offsetX, cy + offsetY);
    return;
  }

  // 縦書き（1列 or 2列）
  const columns = splitIntoColumns(chars);
  const colCount = columns.length;
  const colWidth = (innerBoxSize * 0.9) / colCount;
  const longestCol = Math.max(...columns.map((c) => c.length));
  let fontPx = Math.min(colWidth * 0.85, (innerBoxSize * 0.9) / longestCol) * fontScale;
  fontPx = Math.max(8, fontPx);
  ctx.font = `bold ${fontPx}px ${CANVAS_FONT_FAMILY}`;

  columns.forEach((col, ci) => {
    // 縦書きの伝統的な読み順（右の列から左の列へ）に合わせるため、
    // 分割後の最初の列（姓など、文字列の前半）を右側、後の列（名など、
    // 後半）を左側に配置する。ci(配列のインデックス)をそのままx座標の
    // 順序に使うと左→右になってしまい、2列の印影で姓と名の位置が
    // 入れ替わって見える不具合があったため、表示上の列順を反転する。
    const visualColIndex = colCount - 1 - ci;
    const colX = cx + offsetX - (colWidth * (colCount - 1)) / 2 + visualColIndex * colWidth;
    const lineHeight = fontPx * 1.08;
    const totalH = col.length * lineHeight;
    col.forEach((ch, ri) => {
      const y = cy + offsetY - totalH / 2 + lineHeight / 2 + ri * lineHeight;
      ctx.fillText(ch, colX, y);
    });
  });
}

/**
 * 文字から印影（丸印/角印）を生成する。UIのライブプレビューからも
 * 直接呼び出せるよう、Canvas自体を返す純粋関数として切り出している。
 */
export function generateStampCanvas(input: StampTextGenerateInput): HTMLCanvasElement {
  const size = Math.min(
    STAMP_LIMITS.maxStampSizePx,
    Math.max(STAMP_LIMITS.minStampSizePx, Math.round(input.sizePx))
  );
  const canvas = createCanvas(size, size);
  const ctx = get2dContext(canvas);
  ctx.clearRect(0, 0, size, size);

  const color = STAMP_COLORS[input.color] ?? STAMP_COLORS.red;
  const borderWidth = Math.max(2, size * Math.min(Math.max(input.borderWidthRatio, 0.01), 0.12));
  const cx = size / 2;
  const cy = size / 2;

  ctx.strokeStyle = color;
  ctx.lineWidth = borderWidth;

  let innerBoxSize: number;
  if (input.shape === "round") {
    const radius = size / 2 - borderWidth / 2 - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
    ctx.stroke();
    // 円に内接する正方形の一辺（余白比率を反映）
    innerBoxSize = radius * Math.SQRT2 * (1 - Math.min(Math.max(input.paddingRatio, 0), 0.4));
  } else {
    const half = size / 2 - borderWidth / 2 - 2;
    ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
    innerBoxSize = half * 2 * (1 - Math.min(Math.max(input.paddingRatio, 0), 0.4));
  }

  drawStampText(ctx, {
    text: input.text.trim(),
    layout: input.layout,
    cx,
    cy,
    innerBoxSize: Math.max(1, innerBoxSize),
    fontScale: Math.min(Math.max(input.fontScale, 0.4), 2),
    offsetXPct: input.offsetXPct,
    offsetYPct: input.offsetYPct,
    color,
  });

  return canvas;
}

// ---------------------------------------------------------------------------
// B. 既存の印鑑を取り込む — PDF読み込み・ページ描画
// ---------------------------------------------------------------------------

/**
 * PDFファイルを読み込み、指定ページをCanvasへ描画する。
 * 新しいPDFレンダラーは追加せず、既存の共通PDF基盤（pdfjs-client.ts /
 * pdf-render.ts と同じ仕組み）をそのまま使う。
 *
 * pdfjsのdocumentはUI側で1回だけ読み込み、ページ切り替えのたびに
 * このdocumentを使い回すことで、ファイルの再読込を避ける
 * （メモリ・処理時間の両面で有利）。
 */
export async function loadStampPdf(file: File) {
  return loadPdfDocument(file);
}

export async function renderStampPdfPage(
  pdf: Awaited<ReturnType<typeof loadPdfDocument>>,
  pageNumber: number,
  maxWidth = 900
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(0.2, maxWidth / baseViewport.width));
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = get2dContext(canvas);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// ---------------------------------------------------------------------------
// B. 既存の印鑑を取り込む — 画像読み込み
// ---------------------------------------------------------------------------

/**
 * PNG/JPG画像を読み込み、そのままCanvasへ描画する。
 * EXIF回転情報はブラウザの`createImageBitmap`のデフォルト動作
 * （imageOrientation: "from-image"の指定がない場合、多くのブラウザで
 * 画像本来の見た目の向きにデコードされる）に委ね、ここでの独自の
 * 回転補正ロジックは追加しない（既存のimage.ts側の他Processorと同じ方針）。
 */
export async function loadStampImageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap) {
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const ctx = get2dContext(canvas);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  // createImageBitmapが使えない環境向けのフォールバック
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("画像を読み込めませんでした。対応形式を確認してください。"));
      el.src = url;
    });
    const canvas = createCanvas(img.naturalWidth, img.naturalHeight);
    const ctx = get2dContext(canvas);
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// B. 切り抜き
// ---------------------------------------------------------------------------

/** 指定した矩形範囲でCanvasを切り抜き、新しいCanvasを返す（元Canvasは変更しない） */
export function cropCanvasRegion(source: HTMLCanvasElement, region: CropRegion): HTMLCanvasElement {
  const sx = Math.max(0, Math.min(Math.round(region.x), source.width - 1));
  const sy = Math.max(0, Math.min(Math.round(region.y), source.height - 1));
  const sw = Math.max(1, Math.min(Math.round(region.width), source.width - sx));
  const sh = Math.max(1, Math.min(Math.round(region.height), source.height - sy));

  const canvas = createCanvas(sw, sh);
  const ctx = get2dContext(canvas);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

// ---------------------------------------------------------------------------
// B. 背景透過（しきい値ベース、AI不使用）
// ---------------------------------------------------------------------------

/**
 * 明度(Lightness)としきい値に基づき、背景と思われる明るいピクセルを
 * 透明化する。色相を見ないため赤・黒・青いずれの印影にも同じロジックが
 * 適用できる（特定色専用にしない、という要件を満たす）。
 *
 * thresholdPercent: 0(ほぼ何も除去しない)〜100(積極的に除去し、
 * かなり暗い部分だけ残す)。境界付近は線形補間してアンチエイリアスの
 * ギザギザを抑える。
 *
 * 「どんな背景でも完全に除去できる」ことは保証しない。複雑な背景・影・
 * 柄・透かし等では完全に分離できない場合があるが、しきい値をUI側で
 * 調整できるようにすることで対処の余地を残す。
 */
export function removeLightBackground(
  source: HTMLCanvasElement,
  thresholdPercent: number
): HTMLCanvasElement {
  const pixelCount = source.width * source.height;
  if (pixelCount > STAMP_LIMITS.maxProcessablePixels) {
    throw new Error(
      "画像が大きすぎるため背景透過処理を行えません。画像サイズを小さくするか、範囲を絞って選択してください。"
    );
  }

  const canvas = createCanvas(source.width, source.height);
  const ctx = get2dContext(canvas);
  ctx.drawImage(source, 0, 0);

  const clampedThreshold = Math.min(Math.max(thresholdPercent, 0), 100);
  // しきい値(0-100)を明度カットオフ(140-245)へ写像し、その手前40段階を
  // なだらかな境界（フェザー）として扱う。
  const cutoffHi = 140 + (clampedThreshold / 100) * 105;
  const band = 40;
  const cutoffLo = cutoffHi - band;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const originalAlpha = data[i + 3];
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;

    let alpha: number;
    if (lightness >= cutoffHi) {
      alpha = 0;
    } else if (lightness <= cutoffLo) {
      alpha = 255;
    } else {
      alpha = Math.round(255 * (1 - (lightness - cutoffLo) / band));
    }
    data[i + 3] = Math.min(originalAlpha, alpha);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// B. 透明余白の自動トリミング
// ---------------------------------------------------------------------------

export interface OpaqueBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 不透明(またはほぼ不透明)なピクセルの外接矩形を求める。見つからない場合はnull */
export function findOpaqueBoundingBox(
  canvas: HTMLCanvasElement,
  alphaThreshold = 10
): OpaqueBoundingBox | null {
  const ctx = get2dContext(canvas);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 透明な余白を自動検出してトリミングする。印影が検出できない場合
 * （全面透明等）は元のCanvasをそのまま返し、呼び出し側でメッセージを
 * 出せるようにする（例外にはしない）。
 */
export function autoTrimTransparentMargins(
  canvas: HTMLCanvasElement,
  paddingPx = 6
): { canvas: HTMLCanvasElement; trimmed: boolean } {
  const box = findOpaqueBoundingBox(canvas);
  if (!box) return { canvas, trimmed: false };

  const x = Math.max(0, box.x - paddingPx);
  const y = Math.max(0, box.y - paddingPx);
  const width = Math.min(canvas.width - x, box.width + paddingPx * 2);
  const height = Math.min(canvas.height - y, box.height + paddingPx * 2);

  // すでに余白がほぼない場合はトリミング不要として扱う
  if (x === 0 && y === 0 && width >= canvas.width - 1 && height >= canvas.height - 1) {
    return { canvas, trimmed: false };
  }

  const out = createCanvas(width, height);
  const ctx = get2dContext(out);
  ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
  return { canvas: out, trimmed: true };
}

// ---------------------------------------------------------------------------
// B. 出力サイズ調整
// ---------------------------------------------------------------------------

/**
 * 指定した倍率でCanvasをリサイズする。小さすぎる画像を無条件に
 * 拡大して不自然な高解像度画像を作らないよう、拡大倍率と最終的な
 * 最大辺の両方に上限を設けている。
 */
export function resizeCanvasByScale(source: HTMLCanvasElement, scalePercent: number): HTMLCanvasElement {
  const requestedScale = Math.min(Math.max(scalePercent, 25), STAMP_LIMITS.maxUpscaleRatio * 100) / 100;
  let width = Math.round(source.width * requestedScale);
  let height = Math.round(source.height * requestedScale);

  const maxDim = STAMP_LIMITS.maxOutputDimensionPx;
  if (width > maxDim || height > maxDim) {
    const factor = maxDim / Math.max(width, height);
    width = Math.max(1, Math.round(width * factor));
    height = Math.max(1, Math.round(height * factor));
  }
  width = Math.max(1, width);
  height = Math.max(1, height);

  const canvas = createCanvas(width, height);
  const ctx = get2dContext(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

// ---------------------------------------------------------------------------
// 共通: Canvas → PNG書き出し
// ---------------------------------------------------------------------------

export interface StampExportInput {
  canvas: HTMLCanvasElement;
}

/**
 * 完成した印影CanvasをPNG(Blob)として書き出す、共通の最終ステップ。
 * 文字から生成するモード・取り込みモードのどちらも、最後はこのProcessorを
 * 通してダウンロード用の出力を得る。
 */
export class StampExportProcessor extends BrowserProcessor<StampExportInput, ImageProcessorOutput> {
  async process({ canvas }: StampExportInput): Promise<ImageProcessorOutput> {
    if (canvas.width <= 0 || canvas.height <= 0) {
      throw new Error("印影画像の生成に失敗しました。内容を確認してください。");
    }
    const blob = await canvasToBlob(canvas, "image/png");
    return toOutput(blob, canvas.width, canvas.height);
  }
}
