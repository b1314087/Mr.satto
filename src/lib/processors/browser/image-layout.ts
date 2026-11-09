import { BrowserProcessor, type ImageProcessorOutput, type PdfProcessorOutput } from "../types";
import { loadImage, canvasToBlob } from "./image";
import { ensurePdfLib, pdfLib } from "@/lib/pdf/pdf-lib-loader";

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
  /**
   * 書き出しの倍率（工程4）。数値ならその倍率。"auto"（省略時の既定）は、配置した画像の元の解像度を落とさない倍率
   * （2倍〜4倍の範囲。キャンバスが大きすぎるときは、上限の画素数に収まるまで下げる）。
   */
  scale?: number | "auto";
}

/** 画面の表示・書き出しの両方で使う、テキストの書体と行の高さ（表示と書き出しの見た目をそろえる） */
export const LAYOUT_TEXT_FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
export const LAYOUT_TEXT_LINE_HEIGHT = 1.3;

/** 書き出しの倍率の範囲（"auto" のとき） */
export const EXPORT_SCALE_RANGE = { min: 2, max: 4 } as const;

/**
 * 回転を反映した、アイテムの見た目の外枠（キャンバスの座標）。
 * はみ出しの確認（キャンバスの外にある部分は書き出すと切れる）に使う
 */
export function rotatedItemBounds(item: Pick<ImageLayoutItem, "x" | "y" | "width" | "height" | "rotation">) {
  const r = (item.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  const w = item.width * cos + item.height * sin;
  const h = item.width * sin + item.height * cos;
  const cx = item.x + item.width / 2;
  const cy = item.y + item.height / 2;
  return { minX: cx - w / 2, minY: cy - h / 2, maxX: cx + w / 2, maxY: cy + h / 2 };
}

/** キャンバスからはみ出しているアイテム（1px未満のはみ出しは数えない） */
export function findOverflowingItems(items: readonly ImageLayoutItem[], canvasWidth: number, canvasHeight: number): ImageLayoutItem[] {
  const eps = 1;
  return items.filter((it) => {
    const b = rotatedItemBounds(it);
    return b.minX < -eps || b.minY < -eps || b.maxX > canvasWidth + eps || b.maxY > canvasHeight + eps;
  });
}

/**
 * すべてのアイテムが収まるように、キャンバスを広げる大きさと、アイテムをずらす量を求める
 * （左・上にはみ出しているときは、そのぶんアイテム全体を右・下へずらす。もとのキャンバスより小さくはしない）
 */
export function computeFitCanvas(items: readonly ImageLayoutItem[], canvasWidth: number, canvasHeight: number) {
  let minX = 0;
  let minY = 0;
  let maxX = canvasWidth;
  let maxY = canvasHeight;
  for (const it of items) {
    const b = rotatedItemBounds(it);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  const shiftX = Math.max(0, Math.ceil(-minX));
  const shiftY = Math.max(0, Math.ceil(-minY));
  return { width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY), shiftX, shiftY };
}

/**
 * "auto" の書き出し倍率：配置した画像を、元の画素数より粗くしない倍率（2〜4倍）。
 * 画素数の上限（MAX_CANVAS_PIXELS）を超えるときは、上限に収まるまで下げる
 */
export function computeAutoExportScale(
  items: readonly ImageLayoutItem[],
  naturalSizes: ReadonlyMap<number, { width: number; height: number }>,
  canvasWidth: number,
  canvasHeight: number
): number {
  let need: number = EXPORT_SCALE_RANGE.min;
  for (const it of items) {
    if (it.kind !== "image" || it.imageIndex === undefined) continue;
    const n = naturalSizes.get(it.imageIndex);
    if (!n || it.width <= 0 || it.height <= 0) continue;
    // 比率維持（contain）では短い辺が枠に合うので、画像が枠に収まるときの倍率で考える
    const fitScale = it.fit === "cover" ? Math.max(it.width / n.width, it.height / n.height) : Math.min(it.width / n.width, it.height / n.height);
    if (fitScale > 0) need = Math.max(need, 1 / fitScale);
  }
  const capped = Math.min(EXPORT_SCALE_RANGE.max, need);
  const byPixels = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, canvasWidth * canvasHeight));
  return Math.max(0.25, Math.min(capped, byPixels));
}

/**
 * テキストを、枠の幅で折り返した行に分ける（画面の表示と同じく、改行で行を分け、幅を超えたら次の行へ送る）。
 * 英単語の途中では、できるだけ切らない
 */
export function wrapTextLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    const tokens = raw.match(/[A-Za-z0-9.,!?'"()\-]+|\s+|./gu) ?? [];
    for (const tok of tokens) {
      const candidate = line + tok;
      if (line !== "" && measure(candidate) > maxWidth) {
        out.push(line.replace(/\s+$/, ""));
        line = /^\s+$/.test(tok) ? "" : tok;
        // 1語が枠より長いときは、文字単位で切る
        while (measure(line) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/** 画面表示解像度に対する書き出し倍率。印刷・保存時の品質確保のため2倍でレンダリングする */
const EXPORT_SCALE = 2;

export const MAX_CANVAS_PIXELS = 40_000_000; // 書き出し時（EXPORT_SCALE適用後）の上限。過大なキャンバスでのブラウザ停止を防ぐ

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
      ctx.font = `${weight}${fontSize}px ${LAYOUT_TEXT_FONT_FAMILY}`;
      ctx.fillStyle = item.color ?? "#111111";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      // 工程4：画面の表示と同じく、枠の幅で折り返し、枠の外は描かない（表示と書き出しの見た目をそろえる）
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.clip();
      const lineHeight = fontSize * LAYOUT_TEXT_LINE_HEIGHT;
      const lines = wrapTextLines(item.text ?? "", w, (t) => ctx.measureText(t).width);
      lines.forEach((line, i) => {
        // 行の高さの中で、文字を上下の中央に置く（CSSの line-height と同じ）
        ctx.fillText(line, 0, i * lineHeight + (lineHeight - fontSize) / 2);
      });
      ctx.restore();
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
    await ensurePdfLib();
    if (input.items.length === 0) {
      throw new Error("配置された画像・文字がありません。画像を追加するか、文字を配置してください。");
    }

    let scale = typeof input.scale === "number" ? input.scale : EXPORT_SCALE;
    if (input.scale === undefined || input.scale === "auto") {
      // 配置した画像の元の大きさを調べ、元の解像度を落とさない倍率にする
      const sizes = new Map<number, { width: number; height: number }>();
      for (const it of input.items) {
        if (it.kind !== "image" || it.imageIndex === undefined || sizes.has(it.imageIndex)) continue;
        const file = input.files[it.imageIndex];
        if (!file) continue;
        try {
          const img = await loadImage(file);
          sizes.set(it.imageIndex, { width: img.naturalWidth, height: img.naturalHeight });
        } catch {
          // 読み込めない画像は、描くときにエラーを出す
        }
      }
      scale = computeAutoExportScale(input.items, sizes, input.canvas.widthPx, input.canvas.heightPx);
    }
    const canvas = await drawItemsToCanvas(input.files, input.canvas, input.items, scale);

    if (input.format === "pdf") {
      const pngBlob = await canvasToBlob(canvas, "image/png");
      const bytes = new Uint8Array(await pngBlob.arrayBuffer());
      const doc = await pdfLib().PDFDocument.create();
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
