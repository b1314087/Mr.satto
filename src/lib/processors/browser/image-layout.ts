import { PDFDocument } from "pdf-lib";
import { BrowserProcessor, type ImageProcessorOutput, type PdfProcessorOutput } from "../types";
import { loadImage, canvasToBlob } from "./image";

/**
 * 画像レイアウト Processor（Mr.Satto 次工程フェーズ）。
 *
 * 複数画像・テキストを1つのキャンバス上へ自由配置／グリッド配置し、
 * PNG・JPEG・PDFのいずれかとして書き出す。
 *
 * 設計方針（開発指示書 7〜9・13章）:
 * - 「画像結合」「A4/A3画像自動配置」「画像に余白＋文字」を専用エンジンとして
 *   別々に作らず、すべてこのProcessor（1つのキャンバスへアイテムを配置して
 *   書き出す、という単一のモデル）で表現する。「グリッド自動配置」は
 *   computeGridCells() で各アイテムのx/y/width/heightを計算し直すだけの
 *   ものなので、横結合(1行)・縦結合(1列)・グリッド(複数行列)を同じ関数で扱える。
 * - PDF出力は、テキスト・画像を個別にベクター配置する方式ではなく、
 *   編集キャンバスを1枚の高解像度画像として合成してからPDFへ埋め込む方式を
 *   採用する（image-to-pdf.tsのImagesToPdfProcessorと同じ「Canvas→PNG→
 *   pdf-libでembedPng」の考え方を踏襲）。Excel→PDF等の「元データの構造を
 *   保った変換」とは異なり、このツールは元々レイアウト編集の結果を
 *   1枚の画像として書き出すことが目的のため、この方式で十分な用途である。
 * - 画像の読み込みは image.ts の loadImage/canvasToBlob をそのまま再利用する
 *   （新しいCanvas処理エンジンを増やさない）。
 */

export type ImageLayoutItemKind = "image" | "text";
export type ImageLayoutImageFit = "contain" | "cover";

export interface ImageLayoutItem {
  id: string;
  kind: ImageLayoutItemKind;
  /** キャンバス座標系（左上原点、px） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 度数（時計回り、矩形の中心を軸に回転） */
  rotation: number;
  zIndex: number;
  /** kind === "image" の場合のみ意味を持つ */
  fit?: ImageLayoutImageFit;
  /** kind === "image" の場合、ImageLayoutRenderInput.files のインデックス */
  imageIndex?: number;
  /** kind === "text" の場合のみ意味を持つ */
  text?: string;
  fontSize?: number;
  color?: string;
  fontWeight?: "normal" | "bold";
}

export interface ImageLayoutCanvasSpec {
  widthPx: number;
  heightPx: number;
  /** "transparent" の場合は塗りつぶさない（PNG書き出し時のみ透過になる） */
  backgroundColor: string;
}

export type ImageLayoutOutputFormat = "png" | "jpeg" | "pdf";

export interface ImageLayoutRenderInput {
  /** items[].imageIndex が参照する画像ファイル群 */
  files: File[];
  canvas: ImageLayoutCanvasSpec;
  items: ImageLayoutItem[];
  format: ImageLayoutOutputFormat;
  /** PDF出力時のページサイズ(pt)。省略時はcanvasのpx値をそのままpt数として扱う
   * （image-to-pdf.tsの"fit"モードと同じ、既存の考え方を踏襲した近似） */
  pdfPageSizePt?: { width: number; height: number };
}

/** 画面表示解像度に対する書き出し倍率。印刷・保存時の品質確保のため2倍でレンダリングする */
const EXPORT_SCALE = 2;

const MAX_CANVAS_PIXELS = 40_000_000; // 書き出し時（EXPORT_SCALE適用後）の上限。過大なキャンバスでのブラウザ停止を防ぐ

async function drawItemsToCanvas(
  files: File[],
  spec: ImageLayoutCanvasSpec,
  items: ImageLayoutItem[],
  scale: number
): Promise<HTMLCanvasElement> {
  const outWidth = Math.max(1, Math.round(spec.widthPx * scale));
  const outHeight = Math.max(1, Math.round(spec.heightPx * scale));
  if (outWidth * outHeight > MAX_CANVAS_PIXELS) {
    throw new Error("キャンバスサイズが大きすぎます。用紙サイズを小さくするか、キャンバス幅・高さを見直してください。");
  }

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");

  if (spec.backgroundColor !== "transparent") {
    ctx.fillStyle = spec.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // 同じ画像が複数アイテムから参照されるケース（例: グリッド配置前に複製した場合）に
  // 二重で読み込まないよう、このレンダリング処理内でキャッシュする。
  const imageCache = new Map<number, HTMLImageElement>();
  async function getImage(index: number): Promise<HTMLImageElement> {
    const cached = imageCache.get(index);
    if (cached) return cached;
    const file = files[index];
    if (!file) throw new Error("参照している画像が見つかりません。もう一度画像を選び直してください。");
    const img = await loadImage(file);
    imageCache.set(index, img);
    return img;
  }

  const sorted = [...items].sort((a, b) => a.zIndex - b.zIndex);
  for (const item of sorted) {
    const x = item.x * scale;
    const y = item.y * scale;
    const w = Math.max(1, item.width * scale);
    const h = Math.max(1, item.height * scale);
    const cx = x + w / 2;
    const cy = y + h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((item.rotation * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);

    if (item.kind === "image" && item.imageIndex !== undefined) {
      const img = await getImage(item.imageIndex);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();

      const srcRatio = img.naturalWidth / img.naturalHeight;
      const dstRatio = w / h;
      if (item.fit === "cover") {
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
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
      } else {
        // contain（既定）: アスペクト比を維持し、はみ出す部分は描画しない（余白は背景のまま）
        let dw = w;
        let dh = h;
        let dx = 0;
        let dy = 0;
        if (srcRatio > dstRatio) {
          dh = w / srcRatio;
          dy = (h - dh) / 2;
        } else {
          dw = h * srcRatio;
          dx = (w - dw) / 2;
        }
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, dx, dy, dw, dh);
      }
      ctx.restore();
    } else if (item.kind === "text") {
      const fontSize = Math.max(1, (item.fontSize ?? 24) * scale);
      const weight = item.fontWeight === "bold" ? "bold " : "";
      ctx.font = `${weight}${fontSize}px "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif`;
      ctx.fillStyle = item.color ?? "#111111";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      const lines = (item.text ?? "").split("\n");
      lines.forEach((line, i) => {
        ctx.fillText(line, 0, i * fontSize * 1.3);
      });
    }

    ctx.restore();
  }

  return canvas;
}

export class ImageLayoutRenderProcessor extends BrowserProcessor<
  ImageLayoutRenderInput,
  ImageProcessorOutput | PdfProcessorOutput
> {
  async process(input: ImageLayoutRenderInput): Promise<ImageProcessorOutput | PdfProcessorOutput> {
    if (input.items.length === 0) {
      throw new Error("配置された画像・文字がありません。画像を追加するか、文字を配置してください。");
    }

    const canvas = await drawItemsToCanvas(input.files, input.canvas, input.items, EXPORT_SCALE);

    if (input.format === "pdf") {
      const pngBlob = await canvasToBlob(canvas, "image/png");
      const bytes = new Uint8Array(await pngBlob.arrayBuffer());
      const doc = await PDFDocument.create();
      const embedded = await doc.embedPng(bytes);
      const pageSize = input.pdfPageSizePt ?? { width: input.canvas.widthPx, height: input.canvas.heightPx };
      const page = doc.addPage([Math.max(1, pageSize.width), Math.max(1, pageSize.height)]);
      page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
      const pdfBytes = await doc.save();
      const pdfBlob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
      const output: PdfProcessorOutput = {
        blob: pdfBlob,
        url: URL.createObjectURL(pdfBlob),
        pageCount: 1,
        sizeBytes: pdfBlob.size,
      };
      return output;
    }

    const mimeType = input.format === "jpeg" ? "image/jpeg" : "image/png";
    if (mimeType === "image/jpeg") {
      // JPEGは透過非対応のため、既存ImageConvertProcessorと同じ方針で白背景を敷く
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
    const blob = await canvasToBlob(canvas, mimeType, 0.92);
    const output: ImageProcessorOutput = {
      blob,
      url: URL.createObjectURL(blob),
      width: canvas.width,
      height: canvas.height,
      mimeType: blob.type,
      sizeBytes: blob.size,
    };
    return output;
  }
}

// ---------------------------------------------------------------------------
// グリッド自動配置（横結合・縦結合・グリッドを同一ロジックで扱う）
// ---------------------------------------------------------------------------

export interface GridLayoutOptions {
  canvasWidthPx: number;
  canvasHeightPx: number;
  marginPx: number;
  gapPx: number;
  columns: number;
  rows: number;
}

export interface GridCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 指定した列数×行数で、余白・画像間隔を考慮したセル矩形一覧を計算する。
 * columns=N, rows=1 なら横結合、columns=1, rows=N なら縦結合と同じ配置になる。
 */
export function computeGridCells(options: GridLayoutOptions): GridCell[] {
  const columns = Math.max(1, Math.round(options.columns));
  const rows = Math.max(1, Math.round(options.rows));
  const usableWidth = Math.max(1, options.canvasWidthPx - options.marginPx * 2 - options.gapPx * (columns - 1));
  const usableHeight = Math.max(1, options.canvasHeightPx - options.marginPx * 2 - options.gapPx * (rows - 1));
  const cellWidth = usableWidth / columns;
  const cellHeight = usableHeight / rows;

  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push({
        x: options.marginPx + c * (cellWidth + options.gapPx),
        y: options.marginPx + r * (cellHeight + options.gapPx),
        width: cellWidth,
        height: cellHeight,
      });
    }
  }
  return cells;
}

/**
 * 固定サイズのセルを、用紙内へ収まるだけ敷き詰めて配置する
 * （Step 4: 証明写真サイズ変換で追加）。
 *
 * computeGridCells() は指定した列数×行数で利用可能領域いっぱいにセルを
 * 引き伸ばして分割するのに対し、証明写真は「セル自体の物理サイズ(mm)を
 * 厳密に保つ」必要がある（引き伸ばすと印刷サイズが狂ってしまう）ため、
 * 別の小さな関数として用意する（画像レイアウトの描画・書き出しエンジン
 * 自体は変更せず、既存のImageLayoutRenderProcessorへ渡すGridCell[]の
 * 計算方法だけを追加する）。余った余白は上下左右中央に均等配置する。
 */
export interface FixedSizeGridOptions {
  canvasWidthPx: number;
  canvasHeightPx: number;
  marginPx: number;
  gapPx: number;
  cellWidthPx: number;
  cellHeightPx: number;
}

export function computeFixedSizeGrid(options: FixedSizeGridOptions): GridCell[] {
  const { canvasWidthPx, canvasHeightPx, marginPx, gapPx, cellWidthPx, cellHeightPx } = options;
  if (cellWidthPx <= 0 || cellHeightPx <= 0) return [];

  const usableWidth = canvasWidthPx - marginPx * 2;
  const usableHeight = canvasHeightPx - marginPx * 2;
  const columns = Math.max(0, Math.floor((usableWidth + gapPx) / (cellWidthPx + gapPx)));
  const rows = Math.max(0, Math.floor((usableHeight + gapPx) / (cellHeightPx + gapPx)));
  if (columns === 0 || rows === 0) return [];

  const totalWidth = columns * cellWidthPx + (columns - 1) * gapPx;
  const totalHeight = rows * cellHeightPx + (rows - 1) * gapPx;
  const offsetX = marginPx + (usableWidth - totalWidth) / 2;
  const offsetY = marginPx + (usableHeight - totalHeight) / 2;

  const cells: GridCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push({
        x: offsetX + c * (cellWidthPx + gapPx),
        y: offsetY + r * (cellHeightPx + gapPx),
        width: cellWidthPx,
        height: cellHeightPx,
      });
    }
  }
  return cells;
}

/** 画像枚数から、なるべく正方形に近い列数×行数を自動算出する（「自動」列数指定用） */
export function computeAutoGridShape(itemCount: number, canvasWidthPx: number, canvasHeightPx: number) {
  if (itemCount <= 0) return { columns: 1, rows: 1 };
  let bestColumns = 1;
  let bestScore = Infinity;
  for (let columns = 1; columns <= itemCount; columns++) {
    const rows = Math.ceil(itemCount / columns);
    const cellRatio = canvasWidthPx / columns / (canvasHeightPx / rows);
    // 各セルの縦横比が1(正方形)に近いほど良いとする素朴なヒューリスティック
    const score = Math.abs(Math.log(cellRatio));
    if (score < bestScore) {
      bestScore = score;
      bestColumns = columns;
    }
  }
  return { columns: bestColumns, rows: Math.ceil(itemCount / bestColumns) };
}
