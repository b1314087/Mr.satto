/**
 * OCRの読み取り精度を上げるための前処理と、読み取った結果の後始末（2026-11-20）。
 *
 * 前処理（どのPDFにも効く、一般的な処理だけ。特定の様式に合わせた調整はしない）:
 *  - 字を濃くする: 紙の色を白に、いちばん濃いインクを黒にそろえ（コントラストを広げる）、
 *    中間の灰色（薄い文字・かすれた文字）を濃い側へ寄せる。
 *  - 細い字を太くする: 線の太さが1pxしかない（かすれた・細い）ときだけ、字の線を1pxほど太くする。
 *  - もともと黒い字・白い紙のくっきりした画像には、どちらもしない（すき間が埋まって、かえって読み違えるため）。
 *  - 小さい枠は、文字の高さが十分になるように拡大する（cropScaleForOcr）。
 *  - 指定した場所（枠）の画像では、枠の線（枠の幅・高さのほとんどにわたる線）を消す。
 *
 * 後始末（図形・線を文字として読まない）:
 *  - 罫線・枠・記号の図形（|、─、□、○ など）を、読み取った文字から取り除く。
 *  - 文字（ひらがな・カタカナ・漢字・英字）や数字を1つも含まないものは、捨てる。
 *
 * 純粋関数（DOM非依存）の部分は、テストから直接呼べる。
 */

import { removeRuledLines, type GrayImage } from "./remove-ruled-lines";

/** 文字・数字と認める文字（これを1つも含まない読み取り結果は、図形とみなして捨てる） */
const CHARACTER_RE = /[0-9A-Za-z０-９Ａ-Ｚａ-ｚ\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々〆]/u;

/** 罫線・枠・図形として読まれやすい記号（どこにあっても取り除く） */
const SHAPE_CHARS_RE = /[|｜¦│┃┆┇┊┋╎╏▏▕▐▌█▀▄■□▢▣▪▫◻◼◽◾●○◯◎◉◆◇▲△▼▽▶▷◀◁►◄★☆♦♢❍❏❐❑❒┌┐└┘├┤┬┴┼━─┄┅┈┉═║╔╗╚╝╠╣╦╩╬]/gu;

/** 線として読まれやすい記号（2つ以上続いたとき・単独で置かれたときだけ取り除く。「03-1234」の「-」などは残す） */
const LINE_RUN_RE = /[-‐‑‒–—―_＿=＝~～・･.。、,，]{2,}|[ー一－]{3,}/gu;
const LONE_LINE_RE = /(^|\s)[-‐‑‒–—―_＿=＝~～・･'"`^＾¨'"](?=\s|$)/gu;

/** 文字・数字を1つでも含むか */
export function hasCharacter(text: string): boolean {
  return CHARACTER_RE.test(text);
}

/** 1つの単語（OCRの読み取りの単位）から、図形・線の記号を取り除く。文字・数字が残らなければ空文字 */
export function cleanOcrWord(text: string): string {
  const cleaned = text.replace(SHAPE_CHARS_RE, "").replace(LINE_RUN_RE, "").trim();
  return hasCharacter(cleaned) ? cleaned : "";
}

/** 複数行の文字（枠の中の読み取り結果）から、図形・線の記号と、文字・数字のない行を取り除く */
export function cleanOcrText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(SHAPE_CHARS_RE, " ")
        .replace(LINE_RUN_RE, " ")
        .replace(LONE_LINE_RE, "$1")
        .replace(/[ \t　]+/g, " ")
        .trim(),
    )
    .filter((line) => hasCharacter(line))
    .join("\n");
}

/** OCRの単語の一覧から、図形・線だけのものを捨て、残りの記号を取り除く */
export function filterCharacterWords<T extends { text: string }>(words: T[]): T[] {
  const out: T[] = [];
  for (const w of words) {
    const text = cleanOcrWord(w.text);
    if (text !== "") out.push(text === w.text ? w : { ...w, text });
  }
  return out;
}

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/** これより濃いインク（0〜255）と、これより明るい紙の画像は、もともとくっきりしているとみなす */
const CRISP_INK_MAX = 70;
const CRISP_PAPER_MIN = 225;

/**
 * 字を濃くする：紙の色（明るい側）を白、いちばん濃い部分を黒にそろえ、中間の灰色を濃い側へ寄せる。
 * 画像がほぼ一色（白紙など）のときは、そのまま返す（ノイズを濃くしない）。
 */
export function darkenText(img: GrayImage): { gray: Uint8Array; changed: boolean } {
  const { width: w, height: h, gray } = img;
  const n = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  // 紙の色：明るい側の大部分（文字は紙面のごく一部なので、60%点はほぼ紙の色になる）
  const paper = percentile(hist, n, 0.6);
  // インクの色：いちばん濃い0.2%（点のノイズに引っぱられないよう、少しだけ内側）
  const ink = percentile(hist, n, 0.002);
  if (paper - ink < 40) return { gray: new Uint8Array(gray), changed: false };
  // もともと「黒い字・白い紙」のくっきりした画像は、そのまま（濃くすると、字の線のすき間が埋まって読み違えるため）
  if (ink <= CRISP_INK_MAX && paper >= CRISP_PAPER_MIN) return { gray: new Uint8Array(gray), changed: false };
  // 紙の色より少し暗いところまでは、白にする（紙のざらつき・薄い汚れを消す）
  const white = Math.max(ink + 30, paper - 12);
  const range = white - ink;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    if (v >= white) lut[v] = 255;
    else if (v <= ink) lut[v] = 0;
    else {
      const t = (v - ink) / range;
      // 1.8乗：中間の灰色（薄い字）を濃い側へ寄せる
      lut[v] = Math.round(255 * Math.pow(t, 1.8));
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = lut[gray[i]];
  return { gray: out, changed: true };
}

/** 字の線の太さの目安（横方向のインクの連なりの長さの中央値。長い線＝罫線は除く）。インクがなければ0 */
export function estimateStrokeWidth(img: GrayImage, inkThreshold = 128): number {
  const { width: w, height: h, gray } = img;
  const runs: number[] = [];
  // 全部の行を見ると遅いので、行を間引いて数える
  const step = Math.max(1, Math.floor(h / 400));
  for (let y = 0; y < h; y += step) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      const ink = x < w && gray[y * w + x] < inkThreshold;
      if (ink) run++;
      else if (run > 0) {
        if (run <= 20) runs.push(run);
        run = 0;
      }
    }
  }
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)];
}

/** 字の線を約1px太くする（2×2の範囲でいちばん濃い値を取る） */
export function thickenStrokes(img: GrayImage): Uint8Array {
  const { width: w, height: h, gray } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x1 = Math.min(w - 1, x + 1);
      out[y * w + x] = Math.min(gray[y * w + x], gray[y * w + x1], gray[y1 * w + x], gray[y1 * w + x1]);
    }
  }
  return out;
}

/** 線が細いとみなす太さ（px）。線の太さ（中央値）が1pxのときだけ太くする（2px以上の字を太くすると、すき間が埋まって読み違える） */
export const THIN_STROKE_PX = 2;

/** 字を濃くし、線が細いときは太くする（ページ全体・枠の画像の両方で使う） */
export function enhanceTextForOcr(img: GrayImage): { gray: Uint8Array; changed: boolean } {
  const dark = darkenText(img);
  const stroke = estimateStrokeWidth({ width: img.width, height: img.height, gray: dark.gray });
  if (stroke > 0 && stroke < THIN_STROKE_PX) {
    return { gray: thickenStrokes({ width: img.width, height: img.height, gray: dark.gray }), changed: true };
  }
  return dark;
}

/**
 * 枠（指定した場所）を切り出すときの拡大率。文字の高さが小さいとOCRが読めないので、
 * 枠の高さが targetHeight（px）になるまで拡大する（最大4倍）。幅が狭いときも同じく拡大する。
 */
export function cropScaleForOcr(cropWidth: number, cropHeight: number, targetHeight = 96, minWidth = 200): number {
  const byHeight = cropHeight > 0 && cropHeight < targetHeight ? targetHeight / cropHeight : 1;
  const byWidth = cropWidth > 0 && cropWidth < minWidth ? minWidth / cropWidth : 1;
  return Math.min(4, Math.max(1, byHeight, byWidth));
}

/**
 * 枠の画像の前処理（純粋関数）：字を濃くし、枠の線（枠の幅・高さのほとんどにわたる線）を消し、細い字を太くする。
 * 枠の中の字の一画は、枠の幅・高さに比べて短いので消えない。
 */
export function prepareFieldGray(img: GrayImage): Uint8Array {
  const { width: w, height: h } = img;
  const dark = darkenText(img);
  const maxThickness = Math.max(2, Math.min(8, Math.round(Math.min(w, h) * 0.08)));
  const { gray: noLines } = removeRuledLines(
    { width: w, height: h, gray: dark.gray },
    { minHorizontalRatio: 0.7, minVerticalRatio: 0.75, maxThicknessRatio: maxThickness / Math.max(1, Math.min(w, h)) },
  );
  const stroke = estimateStrokeWidth({ width: w, height: h, gray: noLines });
  return stroke > 0 && stroke < THIN_STROKE_PX ? thickenStrokes({ width: w, height: h, gray: noLines }) : noLines;
}

function canvasToGray(canvas: HTMLCanvasElement): GrayImage | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width: w, height: h } = canvas;
  const src = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = Math.round(0.299 * src.data[i * 4] + 0.587 * src.data[i * 4 + 1] + 0.114 * src.data[i * 4 + 2]);
  }
  return { width: w, height: h, gray };
}

/** グレースケールを、新しいCanvasにする */
export function grayToCanvas(w: number, h: number, gray: Uint8Array): HTMLCanvasElement | null {
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  const dst = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    dst.data[i * 4] = dst.data[i * 4 + 1] = dst.data[i * 4 + 2] = gray[i];
    dst.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(dst, 0, 0);
  return out;
}

/** 枠の画像（Canvas）の前処理。失敗したときは元の画像のまま（前処理の失敗でOCRを止めない） */
export function prepareFieldCanvasForOcr(canvas: HTMLCanvasElement): HTMLCanvasElement {
  try {
    const img = canvasToGray(canvas);
    if (!img) return canvas;
    return grayToCanvas(img.width, img.height, prepareFieldGray(img)) ?? canvas;
  } catch {
    return canvas;
  }
}
