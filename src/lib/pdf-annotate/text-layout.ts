/**
 * PDF修正（記入・注釈）で、画面に出す文字の位置・大きさを、書き出すPDFと同じにするための計算。
 *
 * 書き出しは、Noto Sans JP（public/fonts/NotoSansJP-Regular.ttf）で、文字の基準線（ベースライン）の位置 obj.y に、
 * 1文字ずつの送り幅で描く（src/lib/processors/browser/pdf-fill-annotate.ts）。画面でも同じフォントを読み込み、
 * 同じ送り幅・同じ基準線の位置で表示する。フォントを読み込む前（読み込めないとき）は、近い値で表示する。
 */

export const PDF_TEXT_FONT_FAMILY = "MrSattoPdfJP";
/** 書き出しと同じ行の間隔（文字の大きさ×1.3） */
export const PDF_TEXT_LINE_HEIGHT = 1.3;
/** 読み込めないときの、フォントの上端・下端（Noto Sans JP の値。文字の大きさに対する割合） */
const FALLBACK_ASCENT = 1.16;
const FALLBACK_DESCENT = 0.288;

let fontPromise: Promise<boolean> | null = null;
let fontReady = false;

/** 書き出しと同じフォントを、画面の表示用に読み込む（1回だけ） */
export function ensurePdfTextFont(): Promise<boolean> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve(false);
  if (!fontPromise) {
    fontPromise = (async () => {
      try {
        const face = new FontFace(PDF_TEXT_FONT_FAMILY, "url(/fonts/NotoSansJP-Regular.ttf)", { weight: "400", style: "normal" });
        await face.load();
        document.fonts.add(face);
        fontReady = true;
        return true;
      } catch {
        fontPromise = null;
        return false;
      }
    })();
  }
  return fontPromise;
}

let ctx: CanvasRenderingContext2D | null | undefined;
function measureContext(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  if (typeof document === "undefined") return (ctx = null);
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

/** 画面の表示用に、書き出しと同じフォントを読み込み終えたか */
export function pdfTextFontReady(): boolean {
  return fontReady;
}

/** 読み込めないときの、文字の送り幅の目安（全角は1文字分、半角は0.6文字分） */
function approxWidth(text: string, px: number): number {
  let w = 0;
  for (const ch of text) w += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? 0.6 : 1;
  return w * px;
}

export interface TextBoxLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  lineHeight: number;
  fontPx: number;
  /** 疑似太字（書き出しと同じく、少しずらして重ねる）のずらす量（px） */
  boldShiftPx: number;
}

/**
 * 文字の注釈の、画面上の箱（左上・幅・高さ）を求める。
 * x・y は PDF の座標（左下が原点）で、y は最後の行の基準線。pageHeight は PDF のページの高さ（pt）、scale は 1pt あたりの画面の px。
 */
export function layoutTextBox(
  obj: { x: number; y: number; text: string; fontSize: number; width?: number; bold?: boolean },
  pageHeight: number,
  scale: number
): TextBoxLayout {
  const lines = (obj.text || " ").split("\n");
  const fontPx = obj.fontSize * scale;
  const lineHeight = obj.fontSize * PDF_TEXT_LINE_HEIGHT * scale;
  const c = measureContext();
  const loaded = fontReady;
  let ascent = FALLBACK_ASCENT * fontPx;
  let descent = FALLBACK_DESCENT * fontPx;
  let width = 0;
  if (c && loaded) {
    c.font = `${fontPx}px ${PDF_TEXT_FONT_FAMILY}`;
    try {
      (c as CanvasRenderingContext2D & { fontKerning?: string }).fontKerning = "none";
    } catch {
      // 古いブラウザ
    }
    const m = c.measureText("あHg");
    if (m.fontBoundingBoxAscent && m.fontBoundingBoxDescent) {
      ascent = m.fontBoundingBoxAscent;
      descent = m.fontBoundingBoxDescent;
    }
    // 書き出しは1文字ずつ送り幅を足して描くため、画面でも1文字ずつ測って足す（字詰めをしない）
    for (const line of lines) {
      let w = 0;
      for (const ch of line) w += c.measureText(ch).width;
      width = Math.max(width, w);
    }
  } else {
    for (const line of lines) width = Math.max(width, approxWidth(line, fontPx));
  }
  if (obj.width) width = obj.width * scale;
  // CSS の行の箱：行の高さと、フォントの上端〜下端の差の半分が、上下に入る
  const halfLeading = (lineHeight - (ascent + descent)) / 2;
  const baselineLast = (pageHeight - obj.y) * scale;
  const top = baselineLast - (lines.length - 1) * lineHeight - halfLeading - ascent;
  return {
    left: obj.x * scale,
    top,
    width: Math.max(width, fontPx * 0.5),
    height: lineHeight * lines.length,
    lineHeight,
    fontPx,
    boldShiftPx: obj.bold ? Math.max(0.35, obj.fontSize * 0.018) * scale : 0,
  };
}
