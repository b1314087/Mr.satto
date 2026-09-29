import { BrowserProcessor } from "../types";
import { loadImage, canvasToBlob } from "./image";

/**
 * 画像タイル分割 Processor（Mr.Satto 次工程フェーズ Step 7）。
 *
 * 「画像結合」（複数画像→1枚）・「画像レイアウト」（複数画像・文字の自由配置）
 * とは逆方向の処理で、1枚の画像を行数×列数の均等なタイルへ分割し、
 * それぞれを個別の画像として出力する。元画像はリサイズ・回転・トリミングせず、
 * ピクセル領域をそのまま分割する（開発指示書9・10章）。
 *
 * 複数の小さな出力ファイルをZIPへまとめる方式は、既存の
 * form-to-individual-pdfs.ts（フォーム回答からの個別PDF一括作成）と
 * 同じ考え方（多数の小さな出力はZIPのみを提供し、個別ダウンロードUIは
 * 増やさない）を踏襲している。
 */

export interface ImageTileSplitInput {
  file: File;
  rows: number;
  cols: number;
  format: "png" | "jpeg";
}

export interface TileImageOutput {
  blob: Blob;
  width: number;
  height: number;
  /** 0始まりの行番号 */
  row: number;
  /** 0始まりの列番号 */
  col: number;
  /** 0始まりの通し番号（左上→右方向→次の行の順） */
  index: number;
}

export interface ImageTileSplitOutput {
  tiles: TileImageOutput[];
  sourceWidth: number;
  sourceHeight: number;
}

// 行・列それぞれの上限（開発指示書25章「1〜20など、現実的な範囲」を採用）
const MAX_AXIS = 20;
// 極端な組み合わせ（例: 20×20=400枚）でブラウザが固まらないよう、
// 合計タイル数にも別途上限を設ける。
const MAX_TOTAL_TILES = 200;

/**
 * 全長(total)をcount個に均等分割する境界座標（0始まり、count+1個、整数px）を返す。
 * 端数は各区間へ1px単位で分配され、隣り合う区間の間に隙間・重複が生じない
 * （開発指示書8・11章：ピクセルの欠損・重複が出ない均等分割）。
 */
export function computeTileBoundaries(total: number, count: number): number[] {
  const boundaries: number[] = [];
  for (let i = 0; i <= count; i++) {
    boundaries.push(Math.round((i * total) / count));
  }
  return boundaries;
}

export class ImageTileSplitProcessor extends BrowserProcessor<
  ImageTileSplitInput,
  ImageTileSplitOutput
> {
  async process(input: ImageTileSplitInput): Promise<ImageTileSplitOutput> {
    const rows = Math.round(input.rows);
    const cols = Math.round(input.cols);

    if (!Number.isInteger(rows) || rows < 1 || rows > MAX_AXIS) {
      throw new Error(`行数は1〜${MAX_AXIS}の範囲で指定してください`);
    }
    if (!Number.isInteger(cols) || cols < 1 || cols > MAX_AXIS) {
      throw new Error(`列数は1〜${MAX_AXIS}の範囲で指定してください`);
    }
    if (rows * cols > MAX_TOTAL_TILES) {
      throw new Error(`分割数が多すぎます（最大${MAX_TOTAL_TILES}枚まで）。行数・列数を見直してください`);
    }

    // image.tsのloadImage()を1回だけ呼び、デコード済みの同じHTMLImageElementを
    // 全タイルの描画に使い回す（タイルごとに元画像を再読み込み・再デコードしない）。
    const img = await loadImage(input.file);
    const sourceWidth = img.naturalWidth;
    const sourceHeight = img.naturalHeight;

    if (sourceWidth < cols || sourceHeight < rows) {
      throw new Error("画像が小さすぎて、指定した行数・列数には分割できません");
    }

    const colBoundaries = computeTileBoundaries(sourceWidth, cols);
    const rowBoundaries = computeTileBoundaries(sourceHeight, rows);
    const mimeType = input.format === "jpeg" ? "image/jpeg" : "image/png";

    const tiles: TileImageOutput[] = [];
    let index = 0;
    for (let r = 0; r < rows; r++) {
      const sy = rowBoundaries[r];
      const sh = rowBoundaries[r + 1] - sy;
      for (let c = 0; c < cols; c++) {
        const sx = colBoundaries[c];
        const sw = colBoundaries[c + 1] - sx;

        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvasの初期化に失敗しました");
        // 元画像の該当領域をそのまま切り出すだけで、拡大・縮小・回転はしない
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        const blob = await canvasToBlob(canvas, mimeType, 0.92);
        tiles.push({ blob, width: sw, height: sh, row: r, col: c, index });
        index++;
      }
    }

    return { tiles, sourceWidth, sourceHeight };
  }
}
