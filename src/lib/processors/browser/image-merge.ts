import { BrowserProcessor, type ImageProcessorOutput } from "../types";
import { loadImage, canvasToBlob, toOutput } from "./image";

/**
 * 画像結合 Processor（Mr.Satto 次工程フェーズ Step 5）。
 *
 * 「画像レイアウト」（image-layout.ts）とは明確に役割を分ける。
 * - 画像結合: 複数画像を横・縦・グリッドで1枚にまとめる（このファイル）
 * - 画像レイアウト: 複数の画像・文字をキャンバス上へ自由配置する
 * 自由配置キャンバス・文字オブジェクト・回転・A4印刷レイアウトはこちらには
 * 追加しない（開発指示書18章）。
 *
 * 画像の読み込み・Blob化・出力形式化は image.ts の loadImage/canvasToBlob/
 * toOutput をそのまま再利用する（新しいCanvas処理基盤を増やさない）。
 */

export type ImageMergeDirection = "horizontal" | "vertical" | "grid";
export type ImageMergeSizeMode = "original" | "scale" | "uniform";
export type ImageMergeUniformFit = "fit" | "crop";
export type ImageMergeAlignment = "start" | "center" | "end";
export type ImageMergeFormat = "png" | "jpeg";

export interface ImageMergeInput {
  files: File[];
  direction: ImageMergeDirection;
  /** direction === "grid" の場合のみ使用 */
  columns: number;
  sizeMode: ImageMergeSizeMode;
  /** sizeMode === "scale" の場合のみ使用（%） */
  scalePercent: number;
  /** sizeMode === "uniform" の場合のみ使用（px） */
  uniformWidth: number;
  uniformHeight: number;
  /** sizeMode === "uniform" の場合のみ使用。縦横比を潰さないよう、
   * 既定はfit（レターボックス）。cropを選んだ場合のみ中央クロップする。 */
  uniformFit: ImageMergeUniformFit;
  gapPx: number;
  alignment: ImageMergeAlignment;
  /** "transparent" または "#rrggbb" */
  background: string;
  format: ImageMergeFormat;
}

const MAX_MERGE_CANVAS_PIXELS = 40_000_000; // 過大なキャンバスでのブラウザ停止を防ぐ上限

/**
 * 指定した矩形(cellSize)内で、アイテム(itemSize)をどこに揃えるかのオフセットを返す。
 * 横結合の縦方向揃え・縦結合の横方向揃え・グリッドの行/列内揃え、いずれも
 * このひとつの関数で表現する（設定項目を増やしすぎないための共通化）。
 */
function alignOffset(cellSize: number, itemSize: number, alignment: ImageMergeAlignment): number {
  if (alignment === "start") return 0;
  if (alignment === "end") return cellSize - itemSize;
  return (cellSize - itemSize) / 2;
}

export interface MergeItemSize {
  width: number;
  height: number;
}

export interface MergeLayoutResult {
  canvasWidth: number;
  canvasHeight: number;
  positions: { x: number; y: number }[];
}

/**
 * 各画像の実際に描画するサイズ(sizes)から、結合後のキャンバスサイズと
 * 各画像の配置座標を計算する（純粋関数、UI側のプレビューからも呼べる）。
 *
 * 画像レイアウト(image-layout.ts)のcomputeGridCells()は「決められた
 * キャンバスサイズいっぱいにセルを引き伸ばして分割する」のに対し、
 * 画像結合は「画像の実サイズに合わせてキャンバス自体を決める」という
 * 逆方向の計算が必要なため、別の関数として実装する（開発指示書8・10・11章：
 * 元サイズ維持・縦横比を潰さないことが基本仕様のため）。
 * グリッドの列幅・行高は、その列/行に含まれる画像の最大サイズに合わせる
 * （サイズがバラバラでも崩れないようにするための表方式）。
 */
export function computeMergeLayout(
  sizes: MergeItemSize[],
  direction: ImageMergeDirection,
  columns: number,
  gap: number,
  alignment: ImageMergeAlignment
): MergeLayoutResult {
  if (sizes.length === 0) return { canvasWidth: 0, canvasHeight: 0, positions: [] };

  if (direction === "horizontal") {
    const rowHeight = Math.max(...sizes.map((s) => s.height));
    let x = 0;
    const positions = sizes.map((s) => {
      const pos = { x, y: alignOffset(rowHeight, s.height, alignment) };
      x += s.width + gap;
      return pos;
    });
    return { canvasWidth: Math.max(1, x - gap), canvasHeight: Math.max(1, rowHeight), positions };
  }

  if (direction === "vertical") {
    const colWidth = Math.max(...sizes.map((s) => s.width));
    let y = 0;
    const positions = sizes.map((s) => {
      const pos = { x: alignOffset(colWidth, s.width, alignment), y };
      y += s.height + gap;
      return pos;
    });
    return { canvasWidth: Math.max(1, colWidth), canvasHeight: Math.max(1, y - gap), positions };
  }

  // グリッド
  const cols = Math.max(1, Math.min(columns, sizes.length));
  const rows = Math.ceil(sizes.length / cols);
  const colWidths = new Array(cols).fill(0);
  const rowHeights = new Array(rows).fill(0);
  sizes.forEach((s, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    colWidths[c] = Math.max(colWidths[c], s.width);
    rowHeights[r] = Math.max(rowHeights[r], s.height);
  });
  const colOffsets: number[] = [];
  colWidths.forEach((w, i) => colOffsets.push(i === 0 ? 0 : colOffsets[i - 1] + colWidths[i - 1] + gap));
  const rowOffsets: number[] = [];
  rowHeights.forEach((h, i) => rowOffsets.push(i === 0 ? 0 : rowOffsets[i - 1] + rowHeights[i - 1] + gap));

  const positions = sizes.map((s, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return {
      x: colOffsets[c] + alignOffset(colWidths[c], s.width, alignment),
      y: rowOffsets[r] + alignOffset(rowHeights[r], s.height, alignment),
    };
  });
  const canvasWidth = Math.max(1, colOffsets[cols - 1] + colWidths[cols - 1]);
  const canvasHeight = Math.max(1, rowOffsets[rows - 1] + rowHeights[rows - 1]);
  return { canvasWidth, canvasHeight, positions };
}

/**
 * 「サイズを揃える」モード用。指定サイズの枠内に画像を収める。
 * fit: 縦横比を維持したままレターボックス（背景色が周囲に見える）
 * crop: 縦横比を維持したまま中央を基準にクロップして枠いっぱいに埋める
 * どちらも「縦横比を無視して引き伸ばす」ことはしない（開発指示書10章）。
 * image-layout.tsのdrawItemsToCanvas()が使っているcontain/coverの計算式と
 * 同じ考え方（描画先が異なるため関数自体は個別に持つ）。
 */
function drawFitted(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  width: number,
  height: number,
  fit: ImageMergeUniformFit
) {
  const srcRatio = img.naturalWidth / img.naturalHeight;
  const dstRatio = width / height;

  if (fit === "crop") {
    let sx = 0;
    let sy = 0;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    if (srcRatio > dstRatio) {
      sw = img.naturalHeight * dstRatio;
      sx = (img.naturalWidth - sw) / 2;
    } else {
      sh = img.naturalWidth / dstRatio;
      sy = (img.naturalHeight - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
    return;
  }

  let dw = width;
  let dh = height;
  let dx = 0;
  let dy = 0;
  if (srcRatio > dstRatio) {
    dh = width / srcRatio;
    dy = (height - dh) / 2;
  } else {
    dw = height * srcRatio;
    dx = (width - dw) / 2;
  }
  ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
}

export class ImageMergeProcessor extends BrowserProcessor<ImageMergeInput, ImageProcessorOutput> {
  async process(input: ImageMergeInput): Promise<ImageProcessorOutput> {
    if (input.files.length < 2) {
      throw new Error("画像を2枚以上追加してください");
    }

    const images = await Promise.all(input.files.map((file) => loadImage(file)));

    let drawables: { source: CanvasImageSource; width: number; height: number }[];

    if (input.sizeMode === "uniform") {
      if (
        !Number.isFinite(input.uniformWidth) ||
        !Number.isFinite(input.uniformHeight) ||
        input.uniformWidth <= 0 ||
        input.uniformHeight <= 0
      ) {
        throw new Error("サイズを揃える幅・高さは1px以上を指定してください");
      }
      const w = Math.round(input.uniformWidth);
      const h = Math.round(input.uniformHeight);
      drawables = images.map((img) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        if (input.background !== "transparent") {
          ctx.fillStyle = input.background;
          ctx.fillRect(0, 0, w, h);
        }
        drawFitted(ctx, img, w, h, input.uniformFit);
        return { source: canvas, width: w, height: h };
      });
    } else {
      const scale =
        input.sizeMode === "scale" ? Math.max(0.01, (input.scalePercent || 100) / 100) : 1;
      drawables = images.map((img) => ({
        source: img,
        width: Math.max(1, Math.round(img.naturalWidth * scale)),
        height: Math.max(1, Math.round(img.naturalHeight * scale)),
      }));
    }

    const gap = Math.max(0, input.gapPx || 0);
    const layout = computeMergeLayout(
      drawables.map((d) => ({ width: d.width, height: d.height })),
      input.direction,
      Math.max(1, Math.round(input.columns || 1)),
      gap,
      input.alignment
    );

    if (layout.canvasWidth * layout.canvasHeight > MAX_MERGE_CANVAS_PIXELS) {
      throw new Error("結合後の画像サイズが大きすぎます。倍率やサイズ指定、画像枚数を見直してください。");
    }

    const canvas = document.createElement("canvas");
    canvas.width = layout.canvasWidth;
    canvas.height = layout.canvasHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    // JPEGは透過非対応のため、既存Processor群（image-layout.ts等）と同じ方針で
    // 透明指定時は白背景にフォールバックする。
    const needsFill = input.format === "jpeg" || input.background !== "transparent";
    if (needsFill) {
      ctx.fillStyle = input.background === "transparent" ? "#ffffff" : input.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    layout.positions.forEach((pos, i) => {
      const d = drawables[i];
      ctx.drawImage(d.source, pos.x, pos.y, d.width, d.height);
    });

    const mimeType = input.format === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await canvasToBlob(canvas, mimeType, 0.92);
    return toOutput(blob, canvas.width, canvas.height);
  }
}
