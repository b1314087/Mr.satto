import { BrowserProcessor, type ImageProcessorOutput } from "../types";
import { loadImage, canvasToBlob, toOutput } from "./image";

/**
 * 画像一括余白・文字入れ Processor（Mr.Satto 次工程フェーズ Step 6）。
 *
 * 「画像レイアウト」（自由配置キャンバス）・「画像結合」（複数画像を1枚にまとめる）
 * とは明確に役割を分ける。このツールは1枚の画像を単位とし、
 * 元画像自体は一切リサイズ・トリミングせず、周囲のキャンバスだけを拡張して
 * 余白を追加し、その余白部分にのみ文字を配置する（開発指示書8・12章）。
 *
 * 複数画像の一括処理はUI側で1枚ずつこのProcessorを呼び出す方式にしている
 * （src/components/tools/implementations/image-batch-convert-tool.tsxと同じ
 * 設計：Processor自体は単一画像を扱う単純な形を保ち、バッチ処理・ZIP化は
 * UI側で既存のcreateZip()を使って行う）。
 *
 * 文字描画のフォント・行間・既定色は、image-layout.ts のテキストオブジェクト
 * 描画（drawItemsToCanvas内、kind === "text"の分岐）と同じ値を踏襲している
 * （image-layout.ts自体は変更していない。別ファイルでの独立実装）。
 */

export type PaddingTextEdge = "top" | "bottom" | "left" | "right";
/** 帯（余白）の長辺方向における文字ブロックの位置 */
export type PaddingTextEdgeAlign = "start" | "center" | "end";
/**
 * 帯（余白）の厚み方向における文字ブロックの位置（「縦位置」に相当）。
 * 上下左右どの辺を選んでも意味が変わらないよう、帯の座標系のstart/endではなく
 * 「写真に近い側/中央/外側（キャンバス端側）」という写真基準の向きで表す。
 */
export type PaddingTextBandAlign = "near" | "center" | "far";
/** 複数行テキストの行ごとの揃え（CSSのtext-alignに相当） */
export type PaddingTextHAlign = "left" | "center" | "right";

export interface ImagePaddingTextInput {
  file: File;
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  /** "transparent" または "#rrggbb" */
  background: string;
  /** 空文字（trim後）の場合は文字を描画しない */
  text: string;
  fontSize: number;
  bold: boolean;
  color: string;
  textAlign: PaddingTextHAlign;
  edge: PaddingTextEdge;
  edgeAlign: PaddingTextEdgeAlign;
  bandAlign: PaddingTextBandAlign;
  format: "png" | "jpeg";
}

const MAX_CANVAS_PIXELS = 40_000_000; // 過大なキャンバスでのブラウザ停止を防ぐ上限
const MAX_PADDING_PX = 4000;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 400;

// image-layout.ts の文字描画（drawItemsToCanvas内）と同じフォント・行間規則
const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
const LINE_HEIGHT_RATIO = 1.3;
const DEFAULT_TEXT_COLOR = "#111111";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 選択された辺の余白帯（矩形）を求める。その辺の余白が0pxの場合は
 * 描画先が存在しないため null を返す（文字が写真本体へはみ出さないようにする）。
 */
function getPaddingBand(
  edge: PaddingTextEdge,
  canvasWidth: number,
  canvasHeight: number,
  padTop: number,
  padBottom: number,
  padLeft: number,
  padRight: number
): Rect | null {
  switch (edge) {
    case "top":
      return padTop > 0 ? { x: 0, y: 0, width: canvasWidth, height: padTop } : null;
    case "bottom":
      return padBottom > 0
        ? { x: 0, y: canvasHeight - padBottom, width: canvasWidth, height: padBottom }
        : null;
    case "left":
      return padLeft > 0 ? { x: 0, y: 0, width: padLeft, height: canvasHeight } : null;
    case "right":
      return padRight > 0
        ? { x: canvasWidth - padRight, y: 0, width: padRight, height: canvasHeight }
        : null;
  }
}

/** 帯の中で、開始/中央/終端のどこに配置するかをオフセットとして返す共通ヘルパー */
function alignOffset(cellSize: number, itemSize: number, align: "start" | "center" | "end"): number {
  if (align === "start") return 0;
  if (align === "end") return cellSize - itemSize;
  return (cellSize - itemSize) / 2;
}

/**
 * bandAlign（near/center/far、写真基準）を、帯の座標系でのstart/center/endへ
 * 変換する。帯が写真のどちら側にあるか（top/left系は帯がcanvas原点側＝写真は
 * 帯のend側、bottom/right系は帯がcanvas終端側＝写真は帯のstart側）で
 * near/farとstart/endの対応が入れ替わる。
 */
function bandAlignToOffsetAlign(
  edge: PaddingTextEdge,
  bandAlign: PaddingTextBandAlign
): "start" | "center" | "end" {
  if (bandAlign === "center") return "center";
  const photoIsAtBandEnd = edge === "top" || edge === "left";
  if (bandAlign === "near") return photoIsAtBandEnd ? "end" : "start";
  return photoIsAtBandEnd ? "start" : "end"; // far
}

function drawPaddingText(
  ctx: CanvasRenderingContext2D,
  band: Rect,
  edge: PaddingTextEdge,
  input: Pick<
    ImagePaddingTextInput,
    "text" | "fontSize" | "bold" | "color" | "textAlign" | "edgeAlign" | "bandAlign"
  >
) {
  const fontSize = input.fontSize;
  const weight = input.bold ? "bold " : "";
  ctx.font = `${weight}${fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = input.color || DEFAULT_TEXT_COLOR;
  ctx.textBaseline = "top";

  const lines = input.text.split("\n");
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const lineWidths = lines.map((line) => ctx.measureText(line).width);
  const blockWidth = Math.max(1, ...lineWidths);
  const blockHeight = lines.length * lineHeight;

  // 帯の向き（上下＝長辺は横方向、左右＝長辺は縦方向）によって、
  // edgeAlign（帯に沿った位置）・bandAlign（帯の厚み方向の位置＝縦位置）が
  // どちらの軸に効くかを切り替える。
  const isHorizontalBand = edge === "top" || edge === "bottom";
  const bandOffsetAlign = bandAlignToOffsetAlign(edge, input.bandAlign);
  const blockX = isHorizontalBand
    ? band.x + alignOffset(band.width, blockWidth, input.edgeAlign)
    : band.x + alignOffset(band.width, blockWidth, bandOffsetAlign);
  const blockY = isHorizontalBand
    ? band.y + alignOffset(band.height, blockHeight, bandOffsetAlign)
    : band.y + alignOffset(band.height, blockHeight, input.edgeAlign);

  // 帯からのはみ出し（文字が大きすぎる場合）で写真本体を汚さないよう、
  // 帯の矩形でクリップしてから描画する。
  ctx.save();
  ctx.beginPath();
  ctx.rect(band.x, band.y, band.width, band.height);
  ctx.clip();

  lines.forEach((line, i) => {
    const lineWidth = lineWidths[i];
    const lineX = blockX + alignOffset(blockWidth, lineWidth, textAlignToOffsetAlign(input.textAlign));
    ctx.fillText(line, lineX, blockY + i * lineHeight);
  });

  ctx.restore();
}

function textAlignToOffsetAlign(textAlign: PaddingTextHAlign): "start" | "center" | "end" {
  if (textAlign === "left") return "start";
  if (textAlign === "right") return "end";
  return "center";
}

export class ImagePaddingTextProcessor extends BrowserProcessor<
  ImagePaddingTextInput,
  ImageProcessorOutput
> {
  async process(input: ImagePaddingTextInput): Promise<ImageProcessorOutput> {
    const padTop = Math.round(input.paddingTop);
    const padBottom = Math.round(input.paddingBottom);
    const padLeft = Math.round(input.paddingLeft);
    const padRight = Math.round(input.paddingRight);

    for (const [label, value] of [
      ["上", padTop],
      ["下", padBottom],
      ["左", padLeft],
      ["右", padRight],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > MAX_PADDING_PX) {
        throw new Error(`${label}の余白は0〜${MAX_PADDING_PX}pxの範囲で指定してください`);
      }
    }

    const text = input.text.trim();
    if (text !== "") {
      if (!Number.isFinite(input.fontSize) || input.fontSize < MIN_FONT_SIZE || input.fontSize > MAX_FONT_SIZE) {
        throw new Error(`フォントサイズは${MIN_FONT_SIZE}〜${MAX_FONT_SIZE}の範囲で指定してください`);
      }
    }

    const img = await loadImage(input.file);

    const canvasWidth = img.naturalWidth + padLeft + padRight;
    const canvasHeight = img.naturalHeight + padTop + padBottom;

    if (canvasWidth <= 0 || canvasHeight <= 0) {
      throw new Error("画像サイズの計算に失敗しました");
    }
    if (canvasWidth * canvasHeight > MAX_CANVAS_PIXELS) {
      throw new Error("余白追加後の画像サイズが大きすぎます。余白の値を見直してください。");
    }

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvasの初期化に失敗しました");

    // JPEGは透過非対応のため、既存Processor群（image-layout.ts・image-merge.ts）と
    // 同じ方針で、透明指定時は白背景にフォールバックする。
    const needsFill = input.format === "jpeg" || input.background !== "transparent";
    if (needsFill) {
      ctx.fillStyle = input.background === "transparent" ? "#ffffff" : input.background;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    }

    // 最重要仕様：元画像はリサイズ・トリミングせず、そのままのピクセルサイズで描画する
    ctx.drawImage(img, padLeft, padTop, img.naturalWidth, img.naturalHeight);

    if (text !== "") {
      const band = getPaddingBand(input.edge, canvasWidth, canvasHeight, padTop, padBottom, padLeft, padRight);
      if (band) {
        drawPaddingText(ctx, band, input.edge, { ...input, text });
      }
      // 選択した辺の余白が0pxの場合、描画先の帯が存在しないため文字は描画しない
      // （写真本体の上へ文字が乗ってしまうことを避けるため、意図的に何もしない）。
    }

    const mimeType = input.format === "jpeg" ? "image/jpeg" : "image/png";
    const blob = await canvasToBlob(canvas, mimeType, 0.92);
    return toOutput(blob, canvasWidth, canvasHeight);
  }
}
