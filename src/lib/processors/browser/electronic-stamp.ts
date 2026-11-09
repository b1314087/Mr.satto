import { create as createQr } from "qrcode";
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
// カスタムフォント（篆書体・印相体・古印体・隷書体など）の読み込み
// ---------------------------------------------------------------------------
//
// 篆書体・印相体・古印体・隷書体は実印・銀行印などに使われる専門的な書体だが、
// 調査の結果、これらを無料で「アプリに組み込んでWeb配布」できるライセンスの
// フォントはほぼ存在しないことが分かった。個人利用は無料でも「フォント
// ファイル自体の再配布を禁止」という条件が一般的で、Webサイトに埋め込んで
// 訪問者のブラウザへ配信することは、たとえ表示用途であっても再配布に
// 当たってしまう。本物に近い書体を使うには、有料のWeb埋め込みライセンス
// （書体メーカーとの契約）が必要になる。
//
// そのため本ツールでは、特定の書体をあらかじめ同梱するのではなく、
// ユーザー自身が別途入手・契約したフォントファイル(.ttf/.otf/.woff/.woff2)を
// その場でブラウザのFontFace APIに読み込み、Canvas描画に使う方式を取る。
// ファイルは常にブラウザ内のメモリ上でのみ扱われ、サーバーへ送信される
// ことは一切ない（本ファイル冒頭の設計方針のとおり）。

export const STAMP_FONT_LIMITS = {
  /** フォントファイルの最大サイズ。極端に大きいファイルでのブラウザ負荷を防ぐための実用上の上限 */
  maxFontFileSizeBytes: 20 * 1024 * 1024,
} as const;

export interface LoadedCustomFont {
  /** generateStampCanvasのfontFamilyにそのまま渡す、ブラウザに登録済みのfont-family名 */
  cssFontFamily: string;
  /** UI表示用の元のファイル名 */
  fileName: string;
}

let customFontSeq = 0;

/**
 * ユーザーが選択したフォントファイルをFontFace APIでブラウザに読み込み、
 * Canvas描画で使えるようにする。読み込んだフォントはページ（タブ）を
 * 閉じる・リロードするまでの間、このブラウザタブ内でのみ有効。
 */
export async function loadCustomStampFont(file: File): Promise<LoadedCustomFont> {
  if (file.size > STAMP_FONT_LIMITS.maxFontFileSizeBytes) {
    const maxMb = Math.round(STAMP_FONT_LIMITS.maxFontFileSizeBytes / (1024 * 1024));
    throw new Error(`フォントファイルが大きすぎます（上限${maxMb}MB）。`);
  }
  if (!/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)) {
    throw new Error(
      "対応していないファイル形式です。.ttf / .otf / .woff / .woff2 のフォントファイルを選択してください。"
    );
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error("フォントファイルを読み込めませんでした。");
  }

  customFontSeq += 1;
  const cssFontFamily = `StampCustomFont${customFontSeq}`;
  const face = new FontFace(cssFontFamily, buffer);
  try {
    await face.load();
  } catch {
    throw new Error(
      "フォントファイルを読み込めませんでした。ファイルが壊れているか、対応していない形式の可能性があります。"
    );
  }
  document.fonts.add(face);
  return { cssFontFamily, fileName: file.name };
}

/** 読み込み済みのカスタムフォントをブラウザの登録から解除する（別のフォントに差し替える際の解放用） */
export function unloadCustomStampFont(cssFontFamily: string): void {
  for (const face of Array.from(document.fonts)) {
    if (face.family === cssFontFamily) document.fonts.delete(face);
  }
}

/** Canvasのctx.fontに渡す実際のfont-family文字列を組み立てる（カスタムフォント未指定時は従来どおり） */
function resolveFontFamily(customFontFamily?: string): string {
  if (!customFontFamily) return CANVAS_FONT_FAMILY;
  return `"${customFontFamily}", ${CANVAS_FONT_FAMILY}`;
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
  /** loadCustomStampFontで読み込んだカスタムフォントのfont-family名。未指定時は標準の明朝/ゴシック系フォントを使う */
  fontFamily?: string;
  /** 文字の太さ。未指定時は"bold"（カスタムフォント使用時は、書体本来の形を崩す合成太字を避けるため"normal"を推奨） */
  fontWeight?: "normal" | "bold";
  /**
   * 固有番号のQRコードを、印影の四隅のどこか(corner。未指定なら右下)に入れる。
   * 丸印は円の外側の四隅に、角印は枠の内側の四隅に置く(角印の文字は中央に、QRコードと重ならない大きさで置く)。
   * serial に固有番号を渡すと、その番号のQRコードを描く。serial が null のときは、番号を発行する前の
   * 編集中のプレビュー用に、QRコードの置き場所だけを描く。未指定なら、従来どおりQRコードの無い印影
   */
  qr?: { serial: string | null; corner?: StampQrCorner };
}

/** QRコードを置く隅 */
export type StampQrCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const STAMP_QR_CORNERS: { id: StampQrCorner; label: string }[] = [
  { id: "top-left", label: "左上" },
  { id: "top-right", label: "右上" },
  { id: "bottom-left", label: "左下" },
  { id: "bottom-right", label: "右下" },
];

// ---------------------------------------------------------------------------
// 固有番号とQRコード
// ---------------------------------------------------------------------------
//
// 印影ごとに、ランダムな固有番号(例 MS-7K9P-2XQ8-4D6A)を1つ発行し、その番号だけをQRコードにして印影に入れる。
// ・番号の生成・QRコードの生成・画像の作成は、すべてブラウザの中で行う(サーバー・データベース・外部APIは使わない)。
// ・乱数は、暗号学的に安全な乱数(crypto.getRandomValues)を使う。
// ・使う文字は、見間違えやすい文字(0とO、1とIとL)を除いた英大文字と数字の31種類。12文字で 31^12 ≒ 7.9×10^17 通り
//   (約59ビット)。全員の印影を突き合わせることはできないため重複しないことは保証できないが、例えば100万個の
//   番号を発行しても、どこかで同じ番号が出る確率は約0.00006%(10^12 / (2×7.9×10^17))。
// ・同じページ(タブ)の中では、発行した番号をメモリに覚えておき、同じ番号を2回発行しない(保存はしない。
//   ページを閉じると消える)。
// ・QRコードに入れるのは番号の文字列だけ(氏名・文字・色・日時などは入れない)。

/** 固有番号に使う文字(0・1・I・L・O を除く) */
export const STAMP_SERIAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** 固有番号の形式 */
export const STAMP_SERIAL_PATTERN = /^MS-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
/** このページの中で発行した番号(重複を避けるため。保存はしない) */
const issuedSerials = new Set<string>();

/**
 * 固有番号を1つ発行する。randomBytes は暗号学的に安全な乱数で配列を埋める関数(既定は crypto.getRandomValues)。
 * 31種類の文字を偏りなく選ぶため、248以上の値は捨てて引き直す(256を31で割った余りによる偏りを無くす)。
 */
export function generateStampSerial(randomBytes: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const chars: string[] = [];
    while (chars.length < 12) {
      const buf = randomBytes(new Uint8Array(32));
      for (const b of buf) {
        if (b >= 248) continue; // 248 = 31 × 8
        chars.push(STAMP_SERIAL_ALPHABET[b % 31]);
        if (chars.length === 12) break;
      }
    }
    const serial = `MS-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
    if (!issuedSerials.has(serial)) {
      issuedSerials.add(serial);
      return serial;
    }
  }
  throw new Error("固有番号を発行できませんでした。");
}

/** QRコードの模様(固有番号だけを入れる。誤り訂正のレベルM)。true が黒いマス */
export function stampQrModules(serial: string): boolean[][] {
  const qr = createQr(serial, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => !!qr.modules.get(r, c)));
}

/** QRコードの周りの余白(マスの数。QRコードの規格の4マス) */
const QR_QUIET_MODULES = 4;
/** 番号の文字のフォント */
const SERIAL_FONT_FAMILY = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * QRコード(白い余白の四角の中に、印影と同じ色のマス)を描く。位置・マスの大きさは整数のpxにそろえる(ぼやけないように)。
 * 白い四角は、背景が透明でも読み取れるよう、QRコードの明暗の差を確保するためのもの(取り込んだ印影の下に並べるとき)
 */
function drawQr(ctx: CanvasRenderingContext2D, serial: string, x: number, y: number, modulePx: number, color: string) {
  const modules = stampQrModules(serial);
  const n = modules.length;
  const side = (n + QR_QUIET_MODULES * 2) * modulePx;
  const ox = Math.round(x);
  const oy = Math.round(y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(ox, oy, side, side);
  drawQrModules(ctx, modules, ox + QR_QUIET_MODULES * modulePx, oy + QR_QUIET_MODULES * modulePx, modulePx, color);
}

/** QRコードのマスだけを描く(白い四角は描かず、薄いマスは透明のまま)。x, y はマスの左上(整数px) */
function drawQrModules(ctx: CanvasRenderingContext2D, modules: boolean[][], x: number, y: number, modulePx: number, color: string) {
  ctx.fillStyle = color;
  for (let r = 0; r < modules.length; r++)
    for (let c = 0; c < modules.length; c++) if (modules[r][c]) ctx.fillRect(x + c * modulePx, y + r * modulePx, modulePx, modulePx);
}

/** 番号を発行する前のプレビュー用：QRコードの置き場所だけを描く(読み取れる模様は描かない) */
function drawQrPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, side: number) {
  ctx.save();
  ctx.strokeStyle = "#9ca3af";
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, side - 1, side - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = "#9ca3af";
  ctx.font = `${Math.max(9, Math.round(side * 0.2))}px ${SERIAL_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("QR", x + side / 2, y + side / 2);
  ctx.restore();
}

/** QRコード(固有番号の17文字・レベルM)のマスの数 */
const QR_MODULES = 21;
/** 四隅に置くQRコードの周りの余白(マスの数)。画像の端・枠・文字とのあいだに、この幅の何も描かない部分を残す */
const CORNER_QUIET_MODULES = 2;

/** 四隅のQRコードのマスの大きさ(px)：QRコードの1辺が印影の約14%になる大きさ(最低2px) */
function cornerModulePx(size: number): number {
  return Math.max(2, Math.round((size * 0.14) / QR_MODULES));
}

/** 丸印の円の外側の半径が、印影の大きさの何割まで小さくなってよいか(これより小さくなる大きさでは、QRコードを入れない) */
const ROUND_MIN_OUTER_RATIO = 0.4;
/** 角印の文字の場所(中央の正方形)が、印影の大きさの何割まで小さくなってよいか */
const SQUARE_MIN_TEXT_RATIO = 0.3;

/**
 * 四隅のQRコードの配置。
 * - 丸印：円の外側の隅にQRコードを置く。QRコードの内側の角と円のあいだに余白(2マス)が残るよう、必要なら円を少し小さくする
 * - 角印：枠の内側の隅にQRコードを置き、文字は中央に、QRコードと余白に重ならない大きさの正方形に収める
 * 入らないときは null
 */
function stampQrCornerLayout(size: number, shape: StampShape, borderWidth: number, corner: StampQrCorner) {
  const m = cornerModulePx(size);
  const qrSide = QR_MODULES * m;
  const quiet = CORNER_QUIET_MODULES * m;
  const cx = size / 2;
  const right = corner.endsWith("right");
  const bottom = corner.startsWith("bottom");
  if (shape === "round") {
    // 画像の端から余白を空けて隅に置く。QRコードの内側の角から円の中心までの距離から、余白を引いたものが円の外側の半径の上限
    const qrX = right ? size - quiet - qrSide : quiet;
    const qrY = bottom ? size - quiet - qrSide : quiet;
    const reach = Math.SQRT2 * (cx - quiet - qrSide);
    const outer = Math.min(size / 2 - 2, reach - quiet);
    if (outer < size * ROUND_MIN_OUTER_RATIO) return null;
    return { m, qrX, qrY, radius: outer - borderWidth / 2, textBox: null as number | null };
  }
  const half = size / 2 - borderWidth / 2 - 2;
  const inner = half - borderWidth / 2;
  const far = inner - quiet;
  const qrX = Math.round(right ? cx + far - qrSide : cx - far);
  const qrY = Math.round(bottom ? cx + far - qrSide : cx - far);
  const textBox = 2 * (far - qrSide - quiet);
  if (textBox < size * SQUARE_MIN_TEXT_RATIO) return null;
  return { m, qrX, qrY, radius: null as number | null, textBox };
}

/** 番号の文字を、幅に収まる大きさで描く(serial が null なら、番号の置き場所を灰色の点で示す) */
function drawSerialText(ctx: CanvasRenderingContext2D, serial: string | null, cx: number, cy: number, startPx: number, maxWidth: number, color: string) {
  const text = serial ?? "MS-····-····-····";
  const px = fitFontSize(ctx, text, startPx, maxWidth, "bold", SERIAL_FONT_FAMILY);
  ctx.save();
  ctx.font = `bold ${px}px ${SERIAL_FONT_FAMILY}`;
  ctx.fillStyle = serial ? color : "#9ca3af";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

/** 文字から作る印影に、QRコードを入れられるか(印影の大きさ・形・枠の太さで決まる。どの隅でも同じ) */
export function canPlaceStampQr(input: Pick<StampTextGenerateInput, "sizePx" | "shape" | "borderWidthRatio">): boolean {
  const size = Math.min(STAMP_LIMITS.maxStampSizePx, Math.max(STAMP_LIMITS.minStampSizePx, Math.round(input.sizePx)));
  const borderWidth = Math.max(2, size * Math.min(Math.max(input.borderWidthRatio, 0.01), 0.12));
  return stampQrCornerLayout(size, input.shape, borderWidth, "bottom-right") !== null;
}

/** QRコードを入れるのに必要な、いちばん小さい印影の大きさ(px、10px刻み)。最大の大きさでも入らなければ null */
export function stampQrMinSizePx(input: Pick<StampTextGenerateInput, "shape" | "borderWidthRatio">): number | null {
  for (let s = STAMP_LIMITS.minStampSizePx; s <= STAMP_LIMITS.maxStampSizePx; s += 10) {
    if (canPlaceStampQr({ ...input, sizePx: s })) return s;
  }
  return null;
}

/**
 * 取り込んだ印影(形が決まっていない画像)に、固有番号とQRコードを付ける。印影の中の空いている場所は分からないため、
 * 印影には重ねず、印影の下に番号とQRコードを並べた画像にする(背景は透明のまま)
 */
export function appendStampQr(source: HTMLCanvasElement, serial: string, color = STAMP_COLORS.red): HTMLCanvasElement {
  const base = Math.max(source.width, source.height);
  const m = Math.min(8, Math.max(2, Math.round(base / 150)));
  const side = (21 + QR_QUIET_MODULES * 2) * m;
  const serialPx = Math.min(16, Math.max(9, Math.round(side * 0.16)));
  const gap = Math.max(4, Math.round(side * 0.08));
  const width = Math.max(source.width, side, Math.ceil(serialPx * 0.62 * serial.length) + 4);
  const height = source.height + gap + serialPx + gap + side;
  const canvas = createCanvas(width, height);
  const ctx = get2dContext(canvas);
  ctx.drawImage(source, Math.round((width - source.width) / 2), 0);
  drawSerialText(ctx, serial, width / 2, source.height + gap + serialPx / 2, serialPx, width - 4, color);
  drawQr(ctx, serial, (width - side) / 2, source.height + gap + serialPx + gap, m, color);
  return canvas;
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
  weight: string,
  fontFamily: string
): number {
  let fontPx = startPx;
  ctx.font = `${weight} ${fontPx}px ${fontFamily}`;
  while (fontPx > 8 && ctx.measureText(text).width > maxWidth) {
    fontPx -= 1;
    ctx.font = `${weight} ${fontPx}px ${fontFamily}`;
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
    fontFamily: string;
    fontWeight: string;
  }
) {
  const { text, layout, cx, cy, innerBoxSize, fontScale, offsetXPct, offsetYPct, color, fontFamily, fontWeight } = params;
  const chars = Array.from(text);
  if (chars.length === 0) return;

  const offsetX = (offsetXPct / 100) * innerBoxSize;
  const offsetY = (offsetYPct / 100) * innerBoxSize;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (layout === "horizontal" || chars.length === 1) {
    const fontPx = fitFontSize(ctx, text, innerBoxSize * 0.62 * fontScale, innerBoxSize * 0.92, fontWeight, fontFamily);
    ctx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
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
  ctx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;

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

  // 固有番号のQRコードを四隅に置くときの配置(入らないときは、QRコードの無い印影)
  const qrLayout = input.qr ? stampQrCornerLayout(size, input.shape, borderWidth, input.qr.corner ?? "bottom-right") : null;

  let innerBoxSize: number;
  if (input.shape === "round") {
    // QRコードを円の外側の隅に置くときは、QRコードと重ならないよう、円を少し小さくすることがある
    const radius = qrLayout?.radius ?? size / 2 - borderWidth / 2 - 2;
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

  // 固有番号のQRコード(白い四角は使わず、薄いマスは透明のまま)。角印は、文字をQRコードと重ならない中央の正方形に収める
  if (input.qr && qrLayout) {
    if (input.qr.serial) drawQrModules(ctx, stampQrModules(input.qr.serial), qrLayout.qrX, qrLayout.qrY, qrLayout.m, color);
    else drawQrPlaceholder(ctx, qrLayout.qrX, qrLayout.qrY, QR_MODULES * qrLayout.m);
    if (qrLayout.textBox !== null) innerBoxSize = Math.min(innerBoxSize, qrLayout.textBox * (1 - Math.min(Math.max(input.paddingRatio, 0), 0.4)));
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
    fontFamily: resolveFontFamily(input.fontFamily),
    fontWeight: input.fontWeight ?? "bold",
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
