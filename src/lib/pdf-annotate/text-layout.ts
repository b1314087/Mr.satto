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

// ---------------------------------------------------------------------------
// 縦書き（2026-11-17）
// ---------------------------------------------------------------------------
//
// 縦書きの文字は、画面（SVG）と書き出し（pdf-lib）の両方で、この計算だけを使って並べる（位置を一致させるため）。
// - 1行目がいちばん右の列。列の間隔は、横書きの行の間隔と同じ（文字の大きさ×1.3）
// - 1文字の送りは、文字の大きさ1つ分（全角の正方形のマス）。文字はマスの左右中央に置く
// - 「、。，．」は、マスの右上へずらす（縦書きの句読点の位置）
// - 長音・ダッシュ・波線・かっこ・三点リーダーなどは、右へ90度回して描く（縦書きの向き）
// - 縦書きのときの x・y は、文字の箱の「左上」（PDFの座標。y は箱の上端）

/** 縦書きで右へ90度回して描く文字 */
const VERTICAL_ROTATE_CHARS = new Set(Array.from("ー－—―‐−-~～〜…‥：:；;＝=（）()「」『』【】〔〕［］[]｛｝{}＜＞<>《》〈〉"));
/** 縦書きでマスの右上へずらす文字 */
const VERTICAL_PUNCT_CHARS = new Set(Array.from("、。，．"));
/** Noto Sans JP の全角のマス（em）の上端が、文字の基準線からどれだけ上か（文字の大きさに対する割合） */
const IDEOGRAPHIC_EM_TOP = 0.88;
/** 回した文字の中心が、基準線からどれだけ離れているか（全角のマスの上下中央） */
const IDEOGRAPHIC_EM_CENTER = 0.38;

export interface VerticalGlyph {
  ch: string;
  /** 文字の箱の左上を原点とした、右向き・下向きの座標（pt）。回さない文字は基準線の左端、回す文字は回す軸の点 */
  x: number;
  y: number;
  /** 右へ90度回して描くか */
  rotate: boolean;
}

export interface VerticalLayout {
  width: number;
  height: number;
  glyphs: VerticalGlyph[];
}

/**
 * 縦書きの並べ方を求める。measure は、その文字の送り幅（横書きのときの幅、pt）を返す関数（画面と書き出しで同じフォントを測る）。
 * align は列の中での揃え方（left＝上、center＝中央、right＝下）。
 */
export function layoutVerticalText(
  text: string,
  fontSize: number,
  align: "left" | "center" | "right",
  measure: (ch: string) => number
): VerticalLayout {
  const lines = (text || "").split("\n").map((l) => Array.from(l));
  const lineHeight = fontSize * PDF_TEXT_LINE_HEIGHT;
  const maxChars = Math.max(1, ...lines.map((l) => l.length));
  const width = Math.max(1, lines.length) * lineHeight;
  const height = maxChars * fontSize;
  const glyphs: VerticalGlyph[] = [];
  lines.forEach((chars, i) => {
    const centerX = width - (i + 0.5) * lineHeight;
    const shift = align === "center" ? ((maxChars - chars.length) * fontSize) / 2 : align === "right" ? (maxChars - chars.length) * fontSize : 0;
    chars.forEach((ch, j) => {
      const cellTop = shift + j * fontSize;
      const adv = measure(ch);
      if (VERTICAL_ROTATE_CHARS.has(ch)) {
        glyphs.push({ ch, x: centerX - IDEOGRAPHIC_EM_CENTER * fontSize, y: cellTop + Math.max(0, (fontSize - adv) / 2), rotate: true });
        return;
      }
      let x = centerX - adv / 2;
      let y = cellTop + IDEOGRAPHIC_EM_TOP * fontSize;
      if (VERTICAL_PUNCT_CHARS.has(ch)) {
        x += 0.55 * fontSize;
        y -= 0.6 * fontSize;
      }
      glyphs.push({ ch, x, y, rotate: false });
    });
  });
  return { width, height, glyphs };
}

/** 画面の表示用：書き出しと同じフォントで、1文字の送り幅（pt）を測る */
export function measureCharPt(ch: string, fontSize: number): number {
  const c = measureContext();
  if (c && fontReady) {
    c.font = `${fontSize * 10}px ${PDF_TEXT_FONT_FAMILY}`;
    return c.measureText(ch).width / 10;
  }
  return approxWidth(ch, fontSize);
}

/**
 * 文字の注釈の、PDFの座標での箱（左・右・下・上）。縦書きと横書きの両方に使う（移動の範囲・揃える操作・操作の帯の位置）。
 */
export function textBoundsPdf(obj: {
  x: number;
  y: number;
  text: string;
  fontSize: number;
  width?: number;
  bold?: boolean;
  vertical?: boolean;
  align?: "left" | "center" | "right";
}): { minX: number; maxX: number; minY: number; maxY: number } {
  if (obj.vertical) {
    const v = layoutVerticalText(obj.text, obj.fontSize, obj.align ?? "left", (ch) => measureCharPt(ch, obj.fontSize));
    return { minX: obj.x, maxX: obj.x + v.width, minY: obj.y - v.height, maxY: obj.y };
  }
  // 横書き：画面の箱を、倍率1・ページの高さ0として求めると、画面の y は「PDFの y の符号を変えたもの」になる
  const box = layoutTextBox(obj, 0, 1);
  return { minX: obj.x, maxX: obj.x + box.width, minY: -(box.top + box.height), maxY: -box.top };
}

/** 横書き⇔縦書きを切り替えるときに、文字の箱の左上が動かないように直した y を返す */
export function convertTextYForWritingMode(
  obj: { x: number; y: number; text: string; fontSize: number; width?: number; bold?: boolean; vertical?: boolean; align?: "left" | "center" | "right" },
  toVertical: boolean
): number {
  if (!!obj.vertical === toVertical) return obj.y;
  if (toVertical) return textBoundsPdf(obj).maxY;
  // 縦→横：横書きの箱の上端が、今の上端(obj.y)になる基準線の位置
  const offset = textBoundsPdf({ ...obj, vertical: false, y: 0 }).maxY;
  return obj.y - offset;
}
