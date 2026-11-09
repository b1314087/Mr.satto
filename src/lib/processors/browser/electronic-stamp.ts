import { create as createQr, type QRCodeMaskPattern } from "qrcode";
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
   * 固有番号のQRコードを印影の中に入れる。serial に固有番号を渡すと、その番号のQRコードと番号を描く。
   * serial が null のときは、番号を発行する前の編集中のプレビュー用。従来の配置ではQRコードの置き場所だけを、
   * ①〜③のデザインでは見た目が分かるよう、実在しない番号(STAMP_QR_PREVIEW_SERIAL)のQRコードを描く。
   * design はQRコードのデザイン(未指定なら従来の配置)。未指定なら、従来どおりQRコードの無い印影
   */
  qr?: { serial: string | null; design?: StampQrDesign };
}

/**
 * QRコードのデザイン。
 * - inText(①)：QRコードのマスで印影の文字を形づくる(文字の部分は濃いマスと薄い色、文字の外は小さな点)
 * - replaceChar(②)：文字を並べたマス目の1つをQRコードにする
 * - pattern(③)：QRコードの点の模様を印影の内側いっぱいに広げ、中央の窓に文字を入れる
 * - standard：従来の配置(白い四角の中のQRコードを、印影の下に置く)
 */
export type StampQrDesign = "inText" | "replaceChar" | "pattern" | "standard";

export const STAMP_QR_DESIGNS: { id: StampQrDesign; label: string; description: string }[] = [
  {
    id: "inText",
    label: "① 文字の中に組み込む",
    description: "QRコードのマスで文字を形づくります。文字の部分は濃いマスと薄い色、文字の外は小さな点になり、四角いQRコードには見えにくくなります。",
  },
  {
    id: "replaceChar",
    label: "② 文字の一部をQRコードに置き換える",
    description: "文字を並べたマス目の1つをQRコードにします。QRコードが文字の1つのように並びます（白い四角は使いません）。",
  },
  {
    id: "pattern",
    label: "③ 印鑑全体に模様として配置する",
    description: "QRコードの点の模様を印影の内側いっぱいに広げ、中央の窓に文字を入れます。文字は小さめになります。",
  },
  {
    id: "standard",
    label: "従来の配置（下に四角く入れる）",
    description: "これまでどおり、白い四角の中にQRコードを入れて、印影の下の方に置きます。",
  },
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
 * 白い四角は、背景が透明でも読み取れるよう、QRコードの明暗の差を確保するためのもの
 */
function drawQr(ctx: CanvasRenderingContext2D, serial: string, x: number, y: number, modulePx: number, color: string) {
  const modules = stampQrModules(serial);
  const n = modules.length;
  const side = (n + QR_QUIET_MODULES * 2) * modulePx;
  const ox = Math.round(x);
  const oy = Math.round(y);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(ox, oy, side, side);
  ctx.fillStyle = color;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (modules[r][c]) ctx.fillRect(ox + (c + QR_QUIET_MODULES) * modulePx, oy + (r + QR_QUIET_MODULES) * modulePx, modulePx, modulePx);
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

/** QRコードのマスの大きさ(px)：印影の大きさに合わせる(最低2px。読み取れる大きさ) */
function qrModulePx(size: number): number {
  return Math.max(2, Math.floor((size * 0.2) / (21 + QR_QUIET_MODULES * 2)));
}

/** 固有番号のQRコードを入れるのに必要な印影の大きさ(1辺のpx)。これより小さいと、文字の場所が足りない */
export const STAMP_QR_MIN_SIZE_PX = 200;

/**
 * 文字から作る印影の、QRコード・番号・文字の配置。丸印は円の内側の下に、角印は枠の内側の下にQRコードを置き、
 * その上に番号、残りの上の部分に文字を置く(文字・枠とは重ならない)。入らないときは null
 */
function stampQrLayout(size: number, shape: StampShape, borderWidth: number) {
  if (size < STAMP_QR_MIN_SIZE_PX) return null;
  const m = qrModulePx(size);
  const side = (21 + QR_QUIET_MODULES * 2) * m;
  const half = side / 2;
  const cx = size / 2;
  const cy = size / 2;
  const gap = Math.max(2, size * 0.015);
  const serialPx = Math.min(14, Math.max(7, Math.round(size * 0.034)));
  if (shape === "round") {
    const radius = size / 2 - borderWidth / 2 - 2;
    const ri = radius - borderWidth / 2 - gap;
    if (ri <= half * 1.5) return null;
    const qrCenterY = cy + Math.sqrt(ri * ri - half * half) - half;
    const qrTop = qrCenterY - half;
    const serialY = qrTop - serialPx * 0.75;
    const serialHalfChord = Math.sqrt(Math.max(0, ri * ri - (serialY - serialPx / 2 - cy) ** 2));
    const textTop = cy - ri * 0.8;
    const textBottom = serialY - serialPx * 0.9;
    const reach = Math.max(Math.abs(textTop - cy), Math.abs(textBottom - cy));
    const textWidth = 2 * Math.sqrt(Math.max(0, ri * ri - reach * reach));
    return { m, qrX: cx - half, qrY: qrTop, side, serialY, serialPx, serialMaxWidth: serialHalfChord * 2 * 0.92, textCy: (textTop + textBottom) / 2, textBox: Math.min(textBottom - textTop, textWidth) };
  }
  const hh = size / 2 - borderWidth / 2 - 2 - borderWidth / 2 - gap;
  if (hh * 2 <= side * 2) return null;
  const qrTop = cy + hh - side;
  const serialY = qrTop - serialPx * 0.75;
  const textTop = cy - hh;
  const textBottom = serialY - serialPx * 0.9;
  return { m, qrX: cx - half, qrY: qrTop, side, serialY, serialPx, serialMaxWidth: hh * 2 * 0.92, textCy: (textTop + textBottom) / 2, textBox: Math.min(textBottom - textTop, hh * 2) };
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

type QrPlaceInput = Pick<StampTextGenerateInput, "sizePx" | "shape" | "borderWidthRatio"> &
  Partial<Pick<StampTextGenerateInput, "text" | "layout">> & { design?: StampQrDesign };

/**
 * 文字から作る印影に、QRコードを入れられるか(印影の大きさ・形・枠の太さで決まる。②は文字数と文字の向きでも決まる)。
 * design を省略すると、従来の配置
 */
export function canPlaceStampQr(input: QrPlaceInput): boolean {
  const size = Math.min(STAMP_LIMITS.maxStampSizePx, Math.max(STAMP_LIMITS.minStampSizePx, Math.round(input.sizePx)));
  const borderWidth = Math.max(2, size * Math.min(Math.max(input.borderWidthRatio, 0.01), 0.12));
  const design = input.design ?? "standard";
  if (design === "standard") return stampQrLayout(size, input.shape, borderWidth) !== null;
  const area = designAreaLayout(size, input.shape, borderWidth);
  if (!area) return false;
  if (design === "inText") return chooseSymbol(area.side, IN_TEXT_VERSIONS, DESIGN_MIN_MODULE_PX.inText) !== null;
  if (design === "pattern") return chooseSymbol(area.side, PATTERN_VERSIONS, DESIGN_MIN_MODULE_PX.pattern) !== null;
  const chars = Array.from((input.text ?? "印").trim() || "印").length;
  return replaceCharLayout(area, chars, input.layout ?? "vertical") !== null;
}

/** QRコードを入れるのに必要な、いちばん小さい印影の大きさ(px、10px刻み)。最大の大きさでも入らなければ null */
export function stampQrMinSizePx(input: QrPlaceInput): number | null {
  for (let s = STAMP_LIMITS.minStampSizePx; s <= STAMP_LIMITS.maxStampSizePx; s += 10) {
    if (canPlaceStampQr({ ...input, sizePx: s })) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// QRコードのデザイン(①文字の中に組み込む・②文字の一部を置き換える・③全体に模様として配置する)
// ---------------------------------------------------------------------------
//
// どのデザインも、QRコードとして読み取るのに必要な構造(3つの位置検出パターン・タイミングパターン・位置合わせ
// パターン・形式情報。QRコードの部品のうち、データ以外の「予約された」マス)は、普通のQRコードと同じ、
// 塗りつぶした四角のマスで描き、形を変えない。デザインで変えるのはデータのマスの描き方だけで、
// 次のことを守る(読み取りの試験で確かめた条件。tests/tools/electronic-stamp-qr-design.spec.ts)。
// - 濃いマス：マスの大きさの86%の円(面積はマスの約58%)以上を、印影の色で塗る。読み取り側は、マスの中心の明るさ、
//   またはマス全体の平均の明るさで濃い・薄いを決めるため、どちらで見ても「濃い」になる大きさにする。
// - 薄いマス：塗らない(透明)。①の文字の部分だけ、印影の色を42%の濃さで塗る(白い紙の上で、濃いマスとの明るさの
//   差が十分に残る薄さ。明るさ0〜255で、朱色は約183・青は約173・黒は約159。濃いマスは約60〜85)。
// - マスの大きさは最低4px(②は普通の四角いマスなので3px)。これより小さくなる印影の大きさでは、QRコードを入れない。
// - QRコードの周りの余白(何も描かない部分)は2マス。規格の推奨は4マスだが、印影の枠の内側に収めるため2マスにし、
//   枠・文字・番号がその内側に入らないようにしている。
// - ①③は誤り訂正のレベルH(約30%まで復元できる)。③は、文字の窓の部分のマスが読めなくなる分を、この誤り訂正で
//   補う。窓の広さは、QRコードの全体のマスの12%以下にする(試験では14%まで読み取れた。余裕を持たせた値)。
//   また、QRコードの規格で決められた8種類のマスクパターン(白黒の並べ方の変え方)のうち、窓の中の文字と
//   いちばん食い違いの少ないものを選ぶ(規格どおりのQRコードのまま、読み取りの余裕を増やす)。
// - ②は普通のQRコード(レベルM)を、白い四角を使わずに、文字と同じマス目に並べる。
// QRコードに入れるのは、どのデザインでも固有番号の文字列だけ。

/** 番号を発行する前のプレビューで、デザインの見た目を示すために使う番号。0 は固有番号に使わない文字なので、本物の番号と重ならない */
export const STAMP_QR_PREVIEW_SERIAL = "MS-0000-0000-0000";
const DESIGN_QUIET_MODULES = 2;
const DESIGN_DOT_RATIO = 0.86;
const DESIGN_TINT_ALPHA = 0.42;
const DESIGN_MIN_MODULE_PX = { inText: 4, replaceChar: 3, pattern: 4 } as const;
/** ①で使うQRコードの型番(大きい順)。型番が大きいほどマスが細かくなり、文字の形がよく出る */
const IN_TEXT_VERSIONS = [6, 5, 4, 3, 2];
/** ③で使う型番。型番2は位置合わせパターンが中央に近く、文字の窓と重なりやすいため3以上 */
const PATTERN_VERSIONS = [5, 4, 3];
/** マスの大きさがこれ以上になる、いちばん大きい型番を選ぶ(無ければ、最低の大きさを満たす小さい型番) */
const DESIGN_PREFERRED_MODULE_PX = 5;
/** ③の文字の窓の広さの上限(QRコードの全体のマスの数に対する割合) */
const PATTERN_WINDOW_BUDGET = 0.12;

interface QrMatrix {
  n: number;
  dark: Uint8Array;
  reserved: Uint8Array;
}

function qrMatrix(text: string, level: "M" | "H", version?: number, maskPattern?: QRCodeMaskPattern): QrMatrix {
  const qr = createQr(text, {
    errorCorrectionLevel: level,
    ...(version ? { version } : {}),
    ...(maskPattern !== undefined ? { maskPattern } : {}),
  });
  return { n: qr.modules.size, dark: qr.modules.data, reserved: qr.modules.reservedBit };
}

/** ①③のQRコード(または②の文字のマス目)を置く正方形と、その下の番号の位置 */
interface DesignArea {
  x: number;
  y: number;
  side: number;
  serialY: number;
  serialPx: number;
  serialMaxWidth: number;
}

/**
 * 枠の内側で、下に番号の1行を残した、いちばん大きい正方形。丸印は、正方形の上の2つの角が円の内側に入り、
 * 正方形の下の番号の行が円の弦に収まる位置を探す
 */
function designAreaLayout(size: number, shape: StampShape, borderWidth: number): DesignArea | null {
  const cx = size / 2;
  const cy = size / 2;
  const gap = Math.max(2, size * 0.015);
  const serialPx = Math.min(14, Math.max(7, Math.round(size * 0.034)));
  // 番号(17文字の等幅の文字)の幅の目安
  const serialNeed = serialPx * 0.62 * 17;
  if (shape === "round") {
    const radius = size / 2 - borderWidth / 2 - 2;
    const ri = radius - borderWidth / 2 - gap;
    if (ri <= 0) return null;
    for (let d = 0; d < ri; d += 1) {
      const side = -d + Math.sqrt(2 * ri * ri - d * d);
      const bottom = cy - d + side / 2;
      const serialY = bottom + gap * 0.5 + serialPx * 0.6;
      const edge = serialY + serialPx * 0.6 - cy;
      if (Math.abs(edge) >= ri) continue;
      const chord = 2 * Math.sqrt(ri * ri - edge * edge) * 0.92;
      if (chord >= serialNeed) return { x: cx - side / 2, y: cy - d - side / 2, side, serialY, serialPx, serialMaxWidth: chord };
    }
    return null;
  }
  const hh = size / 2 - borderWidth - 2 - gap;
  const side = 2 * hh - serialPx * 1.5;
  if (side <= 0) return null;
  return { x: cx - side / 2, y: cy - hh, side, serialY: cy + hh - serialPx * 0.7, serialPx, serialMaxWidth: 2 * hh * 0.92 };
}

/** 正方形 side に、周りの余白2マスを含めて収まる型番とマスの大きさ(整数px)を選ぶ */
function chooseSymbol(side: number, versions: number[], minModulePx: number): { version: number; n: number; m: number } | null {
  const fit = (v: number) => {
    const n = 17 + 4 * v;
    return { version: v, n, m: Math.floor(side / (n + DESIGN_QUIET_MODULES * 2)) };
  };
  for (const v of versions) {
    const s = fit(v);
    if (s.m >= DESIGN_PREFERRED_MODULE_PX) return s;
  }
  const smallest = fit(versions[versions.length - 1]);
  return smallest.m >= minModulePx ? smallest : null;
}

/** 正方形の中央に、マスの大きさ m のQRコード(n マス)を置くときの、QRコードの左上(整数px) */
function symbolOrigin(area: { x: number; y: number; side: number }, n: number, m: number) {
  const total = (n + DESIGN_QUIET_MODULES * 2) * m;
  return {
    ox: Math.round(area.x + (area.side - total) / 2) + DESIGN_QUIET_MODULES * m,
    oy: Math.round(area.y + (area.side - total) / 2) + DESIGN_QUIET_MODULES * m,
  };
}

/** 濃いマスを、点(円)の集まりとして1回で塗る */
function fillDots(ctx: CanvasRenderingContext2D, dots: [number, number][], m: number) {
  if (dots.length === 0) return;
  const radius = (m * DESIGN_DOT_RATIO) / 2;
  ctx.beginPath();
  for (const [x, y] of dots) {
    ctx.moveTo(x + m / 2 + radius, y + m / 2);
    ctx.arc(x + m / 2, y + m / 2, radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

/** 絵(art)の不透明さを、QRコードのマスごとに平均した値(0〜1) */
function moduleCoverage(art: HTMLCanvasElement, ox: number, oy: number, n: number, m: number): Float32Array {
  const cov = new Float32Array(n * n);
  const { data, width, height } = get2dContext(art).getImageData(0, 0, art.width, art.height);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let sum = 0;
      for (let y = oy + r * m; y < oy + (r + 1) * m; y++) {
        if (y < 0 || y >= height) continue;
        for (let x = ox + c * m; x < ox + (c + 1) * m; x++) {
          if (x < 0 || x >= width) continue;
          sum += data[(y * width + x) * 4 + 3];
        }
      }
      cov[r * n + c] = sum / (255 * m * m);
    }
  }
  return cov;
}

/**
 * ①の描き方(文字から作る印影・取り込んだ印影で共通)。art は、出力と同じ座標の、文字(または印影)だけの絵。
 * 1. 絵を42%の濃さで塗る(文字の形が、薄い色で、なめらかに見える)
 * 2. QRコードの濃いマスを塗る：構造のマスと、絵に半分以上かかるマスは四角いっぱいに(文字の部分が濃く見える)、
 *    それ以外は点にする(文字の外が軽く見え、四角いQRコードに見えにくくなる)
 * 薄いマスは塗らないか42%の濃さなので、どのマスも濃い・薄いが入れ替わらない(読み取りの誤りを増やさない)
 */
function drawInTextQr(ctx: CanvasRenderingContext2D, art: HTMLCanvasElement, mat: QrMatrix, ox: number, oy: number, m: number, color: string) {
  ctx.save();
  ctx.globalAlpha = DESIGN_TINT_ALPHA;
  ctx.drawImage(art, 0, 0);
  ctx.restore();
  const cov = moduleCoverage(art, ox, oy, mat.n, m);
  const dots: [number, number][] = [];
  ctx.fillStyle = color;
  for (let r = 0; r < mat.n; r++) {
    for (let c = 0; c < mat.n; c++) {
      const i = r * mat.n + c;
      if (!mat.dark[i]) continue;
      const x = ox + c * m;
      const y = oy + r * m;
      if (mat.reserved[i] || cov[i] >= 0.5) ctx.fillRect(x, y, m, m);
      else dots.push([x, y]);
    }
  }
  fillDots(ctx, dots, m);
}

/** 絵を、周りの8方向に少しずつずらして重ね、線を太らせる(どの書体にも同じ処理) */
function thickenArt(art: HTMLCanvasElement, px: number): HTMLCanvasElement {
  if (px < 0.5) return art;
  const out = createCanvas(art.width, art.height);
  const ctx = get2dContext(out);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    ctx.drawImage(art, Math.cos(a) * px, Math.sin(a) * px);
  }
  ctx.drawImage(art, 0, 0);
  return out;
}

/** 文字だけを描いた、出力と同じ大きさの絵 */
function renderTextArt(size: number, params: Parameters<typeof drawStampText>[1]): HTMLCanvasElement {
  const art = createCanvas(size, size);
  drawStampText(get2dContext(art), params);
  return art;
}

/** ②：文字と、最後のQRコードを並べるマス目。マス(正方形)が最も大きくなる列(行)の数を選ぶ */
function replaceCharLayout(area: DesignArea, chars: number, layout: StampTextLayout) {
  const count = chars + 1;
  let best: { cell: number; lines: number; perLine: number } | null = null;
  for (let lines = 1; lines <= 3; lines++) {
    const perLine = Math.ceil(count / lines);
    if (lines > 1 && Math.ceil(count / (lines - 1)) === perLine) continue;
    const cell = area.side / Math.max(lines, perLine);
    if (!best || cell > best.cell + 0.01) best = { cell, lines, perLine };
  }
  if (!best) return null;
  // マスの大きさは整数でなくてもよい(描くときに、マスの境目を整数のpxにそろえる)。文字のマスいっぱいに大きくする
  const m = (best.cell * 0.98) / (21 + DESIGN_QUIET_MODULES * 2);
  if (m < DESIGN_MIN_MODULE_PX.replaceChar) return null;
  const { cell, lines, perLine } = best;
  const cx = area.x + area.side / 2;
  const cy = area.y + area.side / 2;
  const centers: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const line = Math.floor(i / perLine);
    const inLine = i % perLine;
    const itemsInLine = line === lines - 1 ? count - perLine * (lines - 1) : perLine;
    const along = (inLine - (itemsInLine - 1) / 2) * cell;
    if (layout === "vertical") {
      // 縦書き：右の列から左の列へ、各列は上から下へ
      centers.push({ x: cx + ((lines - 1) / 2 - line) * cell, y: cy + along });
    } else {
      // 横書き：上の行から下の行へ、各行は左から右へ
      centers.push({ x: cx + along, y: cy + (line - (lines - 1) / 2) * cell });
    }
  }
  return { cell, m, centers };
}

interface DesignDrawInput {
  size: number;
  shape: StampShape;
  borderWidth: number;
  /** 丸印の、枠の内側の円の半径(③の飾りの点を、この内側だけに置く) */
  innerRadius: number;
  design: Exclude<StampQrDesign, "standard">;
  serial: string | null;
  color: string;
  text: string;
  layout: StampTextLayout;
  fontScale: number;
  paddingRatio: number;
  offsetXPct: number;
  offsetYPct: number;
  fontFamily: string;
  fontWeight: string;
}

/** ①〜③のデザインで、QRコード・文字・番号を描く。入らないときは何も描かずに false */
function drawDesignedStamp(ctx: CanvasRenderingContext2D, d: DesignDrawInput): boolean {
  const area = designAreaLayout(d.size, d.shape, d.borderWidth);
  if (!area) return false;
  const qrText = d.serial ?? STAMP_QR_PREVIEW_SERIAL;
  const cx = d.size / 2;
  const textBase = { text: d.text, layout: d.layout, color: d.color, fontFamily: d.fontFamily, fontWeight: d.fontWeight };

  if (d.design === "inText") {
    const sym = chooseSymbol(area.side, IN_TEXT_VERSIONS, DESIGN_MIN_MODULE_PX.inText);
    if (!sym) return false;
    const { ox, oy } = symbolOrigin(area, sym.n, sym.m);
    const symSide = sym.n * sym.m;
    const art = renderTextArt(d.size, {
      ...textBase,
      cx: ox + symSide / 2,
      cy: oy + symSide / 2,
      innerBoxSize: Math.max(1, symSide * (1 - Math.min(Math.max(d.paddingRatio, 0), 0.4))),
      fontScale: d.fontScale,
      offsetXPct: d.offsetXPct,
      offsetYPct: d.offsetYPct,
    });
    // 文字の線を少し太らせて(マスの約1/3)、QRコードのマスの中でも文字の形が分かるようにする
    drawInTextQr(ctx, thickenArt(art, sym.m * 0.35), qrMatrix(qrText, "H", sym.version), ox, oy, sym.m, d.color);
  } else if (d.design === "replaceChar") {
    const chars = Array.from(d.text);
    const grid = replaceCharLayout(area, chars.length, d.layout);
    if (!grid) return false;
    ctx.fillStyle = d.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    chars.forEach((ch, i) => {
      const px = fitFontSize(ctx, ch, grid.cell * 0.86 * Math.min(d.fontScale, 1.15), grid.cell * 0.95, d.fontWeight, d.fontFamily);
      ctx.font = `${d.fontWeight} ${px}px ${d.fontFamily}`;
      ctx.fillText(ch, grid.centers[i].x, grid.centers[i].y);
    });
    // QRコード(普通の四角いマス、白い四角は使わない)
    const mat = qrMatrix(qrText, "M");
    const q = grid.centers[chars.length];
    const ox = q.x - (mat.n * grid.m) / 2;
    const oy = q.y - (mat.n * grid.m) / 2;
    const edge = (o: number, k: number) => Math.round(o + k * grid.m);
    for (let r = 0; r < mat.n; r++)
      for (let c = 0; c < mat.n; c++)
        if (mat.dark[r * mat.n + c]) ctx.fillRect(edge(ox, c), edge(oy, r), edge(ox, c + 1) - edge(ox, c), edge(oy, r + 1) - edge(oy, r));
  } else {
    if (!drawPatternQr(ctx, d, area, qrText, textBase)) return false;
  }

  drawSerialText(ctx, d.serial, cx, area.serialY, area.serialPx, area.serialMaxWidth, d.color);
  return true;
}

/** ③：QRコードの点の模様を内側いっぱいに広げ、中央の窓に文字を入れる */
function drawPatternQr(
  ctx: CanvasRenderingContext2D,
  d: DesignDrawInput,
  area: DesignArea,
  qrText: string,
  textBase: { text: string; layout: StampTextLayout; color: string; fontFamily: string; fontWeight: string }
): boolean {
  const sym = chooseSymbol(area.side, PATTERN_VERSIONS, DESIGN_MIN_MODULE_PX.pattern);
  if (!sym) return false;
  const { n, m, version } = sym;
  const { ox, oy } = symbolOrigin(area, n, m);

  // 文字の外形の縦横の比(大きさ1の正方形に描いたときの、文字の範囲)
  const probeSize = 256;
  const probe = renderTextArt(probeSize, { ...textBase, cx: probeSize / 2, cy: probeSize / 2, innerBoxSize: probeSize, fontScale: 1, offsetXPct: 0, offsetYPct: 0 });
  const box = findOpaqueBoundingBox(probe);
  const fw = box ? box.width / probeSize : 0.5;
  const fh = box ? box.height / probeSize : 0.5;

  // 文字の窓(マスの数)：広さは全体の12%以下、縦横の比は文字に合わせる。構造のマスとは重ねない
  const reserved = qrMatrix(qrText, "H", version).reserved;
  const budget = PATTERN_WINDOW_BUDGET * n * n;
  let kw = Math.max(3, Math.floor(Math.sqrt(budget * (fw / fh))));
  let kh = Math.max(3, Math.floor(Math.sqrt(budget / (fw / fh))));
  while (kw * kh > budget && (kw > 3 || kh > 3)) {
    if (kw >= kh) kw--;
    else kh--;
  }
  const windowAt = () => ({ c0: Math.floor((n - kw) / 2), r0: Math.floor((n - kh) / 2) });
  const touchesReserved = () => {
    const { c0, r0 } = windowAt();
    for (let r = r0; r < r0 + kh; r++) for (let c = c0; c < c0 + kw; c++) if (reserved[r * n + c]) return true;
    return false;
  };
  while (touchesReserved()) {
    if (kw <= 3 && kh <= 3) return false;
    if (kw >= kh) kw--;
    else kh--;
  }
  const { c0, r0 } = windowAt();
  const textBox = Math.min(((kw - 1.4) * m) / fw, ((kh - 1.4) * m) / fh) * Math.min(1, Math.max(d.fontScale, 0.4));
  const art = renderTextArt(d.size, {
    ...textBase,
    cx: ox + (c0 + kw / 2) * m,
    cy: oy + (r0 + kh / 2) * m,
    innerBoxSize: Math.max(1, textBox),
    fontScale: 1,
    offsetXPct: 0,
    offsetYPct: 0,
  });

  // 窓の中の文字と、いちばん食い違いの少ないマスクパターンを選ぶ
  const cov = moduleCoverage(art, ox, oy, n, m);
  let mat: QrMatrix | null = null;
  let bestMismatch = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const cand = qrMatrix(qrText, "H", version, mask as QRCodeMaskPattern);
    let mismatch = 0;
    for (let r = r0; r < r0 + kh; r++)
      for (let c = c0; c < c0 + kw; c++) if (!!cand.dark[r * n + c] !== cov[r * n + c] >= 0.5) mismatch++;
    if (mismatch < bestMismatch) {
      bestMismatch = mismatch;
      mat = cand;
    }
  }
  if (!mat) return false;

  const inWindow = (r: number, c: number) => r >= r0 && r < r0 + kh && c >= c0 && c < c0 + kw;
  ctx.fillStyle = d.color;
  const dots: [number, number][] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (!mat.dark[i] || inWindow(r, c)) continue;
      if (mat.reserved[i]) ctx.fillRect(ox + c * m, oy + r * m, m, m);
      else dots.push([ox + c * m, oy + r * m]);
    }
  }
  // 丸印は、QRコードの余白よりさらに1マス外側から枠の内側までを、同じ大きさの点の飾りで埋める
  // (印影全体が模様に見えるように。番号の行の高さより下には置かない)
  if (d.shape === "round") {
    const keep = DESIGN_QUIET_MODULES + 1;
    const span = Math.ceil(d.size / m);
    const cxs = d.size / 2;
    const cys = d.size / 2;
    for (let r = -span; r < n + span; r++) {
      for (let c = -span; c < n + span; c++) {
        if (r >= -keep && r < n + keep && c >= -keep && c < n + keep) continue;
        const x = ox + c * m;
        const y = oy + r * m;
        if (y + m > oy + (n + DESIGN_QUIET_MODULES) * m) continue;
        const dist = Math.hypot(x + m / 2 - cxs, y + m / 2 - cys);
        if (dist + m * 0.8 > d.innerRadius) continue;
        const h = (Math.imul(r + 1000, 73856093) ^ Math.imul(c + 1000, 19349663)) >>> 0;
        if (h % 100 < 45) dots.push([x, y]);
      }
    }
  }
  fillDots(ctx, dots, m);

  // 窓の細い枠と、文字
  ctx.save();
  ctx.strokeStyle = d.color;
  ctx.lineWidth = Math.max(1, m * 0.18);
  const inset = m * 0.4;
  ctx.beginPath();
  const frame = [ox + c0 * m + inset, oy + r0 * m + inset, kw * m - inset * 2, kh * m - inset * 2] as const;
  if (typeof ctx.roundRect === "function") ctx.roundRect(...frame, m * 0.8);
  else ctx.rect(...frame);
  ctx.stroke();
  ctx.restore();
  ctx.drawImage(art, 0, 0);
  return true;
}

// ---------------------------------------------------------------------------
// 取り込んだ印影へのデザインの適用
// ---------------------------------------------------------------------------
//
// 取り込んだ印影は、画像ごとに形・文字・透明な部分が違い、文字の位置や区切りは分からない(文字認識は使わない)。
// - ①：文字の位置が分からなくても、「印影の線(不透明な部分)」をそのまま①の絵として使えば、文字から作る印影と
//   同じ描き方ができる(印影全体にQRコードを重ね、印影の線の部分を濃いマスと薄い色にする)。どの画像にも同じ
//   処理で、画像ごとの調整はしない。ただし、印影の色が薄すぎる・印影が小さすぎるときは使えない(理由を出す)。
// - ②：文字の一部を置き換えるには、文字1つ1つの位置が必要なため使えない。
// - ③：文字を読める形で残す窓を、どこに作ればよいか分からないため使えない(印影全体をQRコードの模様に重ねると、
//   読めないマスが多くなりすぎる)。
// - 従来の配置：印影の下に番号とQRコードを並べる(appendStampQr)。

/** 取り込んだ印影で、②③が使えない理由 */
export const IMPORTED_STAMP_DESIGN_UNAVAILABLE: Partial<Record<StampQrDesign, string>> = {
  replaceChar:
    "取り込んだ画像からは、文字1つ1つの位置や区切りを判別できない（文字認識は使っていません）ため、文字の一部をQRコードに置き換えられません。",
  pattern:
    "取り込んだ印影は文字の場所が分からないため、QRコードの模様の中に、文字を読める形で残す窓を作れません（印影全体を模様に重ねると、QRコードが読み取れなくなります）。",
};

/** 取り込んだ印影の、①に使う濃いマスの色(不透明な部分の平均の色)と、①が使えるか */
function importedStampInk(source: HTMLCanvasElement): { ok: true; color: string } | { ok: false; reason: string } {
  const longest = Math.max(source.width, source.height);
  if (longest < 25 * DESIGN_MIN_MODULE_PX.inText) {
    return { ok: false, reason: `印影の画像が小さすぎるため、読み取れる大きさのQRコードを重ねられません（${25 * DESIGN_MIN_MODULE_PX.inText}px以上が必要です）。` };
  }
  const { data } = get2dContext(source).getImageData(0, 0, source.width, source.height);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (count === 0) return { ok: false, reason: "印影の部分（透明でない部分）が見つかりません。" };
  r /= count;
  g /= count;
  b /= count;
  // 白い紙の上で、濃いマスと薄いマスの明るさの差が足りるか(明るさ0〜255。文字から作る印影の色は約60〜85)
  if (0.299 * r + 0.587 * g + 0.114 * b > 140) {
    return { ok: false, reason: "印影の色が薄いため、QRコードの濃いマスとの明暗の差が足りず、読み取れなくなります。" };
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return { ok: true, color: `#${hex(r)}${hex(g)}${hex(b)}` };
}

/** 取り込んだ印影に①(文字の中に組み込む)を使えるか。使えないときは理由 */
export function canEmbedStampQrInImage(source: HTMLCanvasElement): { ok: true } | { ok: false; reason: string } {
  const ink = importedStampInk(source);
  return ink.ok ? { ok: true } : ink;
}

/**
 * 取り込んだ印影に、①の描き方で固有番号のQRコードを重ね、下に番号を入れた画像を作る(背景は透明のまま)。
 * serial が null のときは、プレビュー用に実在しない番号で描く。使えない画像では null
 */
export function embedStampQrInImage(source: HTMLCanvasElement, serial: string | null): HTMLCanvasElement | null {
  const ink = importedStampInk(source);
  if (!ink.ok) return null;
  const longest = Math.max(source.width, source.height);
  let sym: { version: number; n: number; m: number } | null = null;
  for (const v of IN_TEXT_VERSIONS) {
    const n = 17 + 4 * v;
    if (longest / n >= DESIGN_PREFERRED_MODULE_PX) {
      sym = { version: v, n, m: Math.ceil(longest / n) };
      break;
    }
  }
  sym ??= { version: 2, n: 25, m: Math.ceil(longest / 25) };
  const { n, m, version } = sym;
  const total = (n + DESIGN_QUIET_MODULES * 2) * m;
  const serialPx = Math.min(16, Math.max(9, Math.round(total * 0.045)));
  const canvas = createCanvas(total, total + serialPx * 1.6);
  const ctx = get2dContext(canvas);
  const ox = DESIGN_QUIET_MODULES * m;
  const oy = DESIGN_QUIET_MODULES * m;
  const art = createCanvas(canvas.width, canvas.height);
  get2dContext(art).drawImage(source, Math.round(ox + (n * m - source.width) / 2), Math.round(oy + (n * m - source.height) / 2));
  drawInTextQr(ctx, art, qrMatrix(serial ?? STAMP_QR_PREVIEW_SERIAL, "H", version), ox, oy, m, ink.color);
  drawSerialText(ctx, serial, total / 2, total + serialPx * 0.6, serialPx, total - 4, ink.color);
  return canvas;
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

  // ①〜③のデザイン：QRコード・文字・番号の配置がデザインごとに違うので、まとめて描く(入らないときは、QRコードの無い印影)
  const design = input.qr?.design ?? "standard";
  if (input.qr && design !== "standard") {
    const drawn = drawDesignedStamp(ctx, {
      size,
      shape: input.shape,
      borderWidth,
      innerRadius: size / 2 - borderWidth - 2 - Math.max(2, size * 0.015),
      design,
      serial: input.qr.serial,
      color,
      text: input.text.trim(),
      layout: input.layout,
      fontScale: Math.min(Math.max(input.fontScale, 0.4), 2),
      paddingRatio: input.paddingRatio,
      offsetXPct: input.offsetXPct,
      offsetYPct: input.offsetYPct,
      fontFamily: resolveFontFamily(input.fontFamily),
      fontWeight: input.fontWeight ?? "bold",
    });
    if (drawn) return canvas;
  }

  // 固有番号のQRコード(従来の配置)：枠の内側の下にQRコード、その上に番号、残りの上の部分に文字を置く
  const qrLayout = input.qr && design === "standard" ? stampQrLayout(size, input.shape, borderWidth) : null;
  let textCy = cy;
  if (input.qr && qrLayout) {
    if (input.qr.serial) drawQr(ctx, input.qr.serial, qrLayout.qrX, qrLayout.qrY, qrLayout.m, color);
    else drawQrPlaceholder(ctx, qrLayout.qrX, qrLayout.qrY, qrLayout.side);
    drawSerialText(ctx, input.qr.serial, cx, qrLayout.serialY, qrLayout.serialPx, qrLayout.serialMaxWidth, color);
    textCy = qrLayout.textCy;
    innerBoxSize = qrLayout.textBox * (1 - Math.min(Math.max(input.paddingRatio, 0), 0.4));
  }

  drawStampText(ctx, {
    text: input.text.trim(),
    layout: input.layout,
    cx,
    cy: textCy,
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
