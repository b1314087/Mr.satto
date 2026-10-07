/**
 * 封筒宛名の配置計算（PDFとプレビューで共通）。
 *
 * 「どこに何を描くか」を図形(Op)の一覧として返し、PDF生成(envelope-address.ts)と
 * 画面のプレビュー(envelope-preview.tsx)が同じ一覧を使う。これにより、
 * プレビューと出力のレイアウトが食い違わない。文字幅の測り方(measure)だけは呼び出し側が渡す
 * (PDFは埋め込みフォントの実測、プレビューは近似)。
 *
 * 座標は封筒の左上を原点とし、単位はpt。yは下向きに増える。
 * 縦書きは、1文字ずつ縦に積み、列が埋まったら1列左へ折り返す単純な方式
 * （半角数字は全角数字へ変換する。縦中横・禁則処理までは行わない）。
 */
import { mmToPt } from "./paper-sizes";

export type EnvelopeWritingMode = "vertical" | "horizontal";
/** 封筒の向き。landscape=横長(長辺が横)、portrait=縦長(長辺が縦) */
export type EnvelopeOrientation = "landscape" | "portrait";
/** 宛名の敬称 */
export type EnvelopeHonorific = "sama" | "onchu" | "none";

export const HONORIFIC_LABELS: Record<EnvelopeHonorific, string> = {
  sama: "様",
  onchu: "御中",
  none: "なし",
};

export interface EnvelopePerson {
  postalCode: string;
  address: string;
  name: string;
}

/** 文字サイズ(pt)・太字の指定。サイズが null のときは書字方向ごとの既定値を使う */
export interface EnvelopeTextStyle {
  nameSize: number | null;
  addressSize: number | null;
  senderSize: number | null;
  nameBold: boolean;
  addressBold: boolean;
  senderBold: boolean;
}

export const DEFAULT_TEXT_STYLE: EnvelopeTextStyle = {
  nameSize: null,
  addressSize: null,
  senderSize: null,
  nameBold: false,
  addressBold: false,
  senderBold: false,
};

/** 書字方向ごとの既定の文字サイズ(pt) */
export const DEFAULT_SIZES: Record<EnvelopeWritingMode, { name: number; address: number; sender: number }> = {
  vertical: { name: 18, address: 11, sender: 8 },
  horizontal: { name: 22, address: 13, sender: 9 },
};

export const MIN_FONT_PT = 6;
export const MAX_FONT_PT = 60;

export type Rgb = [number, number, number];
const COLOR_TEXT: Rgb = [0.1, 0.1, 0.12];
const COLOR_MUTED: Rgb = [0.4, 0.4, 0.42];

export type EnvelopeOp =
  | { kind: "text"; x: number; y: number; size: number; text: string; bold: boolean; color: Rgb; align: "left" | "center" }
  | { kind: "rect"; x: number; y: number; w: number; h: number; stroke: Rgb };

export type MeasureFn = (text: string, size: number) => number;

export interface EnvelopeLayoutInput {
  width: number;
  height: number;
  writingMode: EnvelopeWritingMode;
  honorific: EnvelopeHonorific;
  style: EnvelopeTextStyle;
  recipient: EnvelopePerson | undefined;
  sender: EnvelopePerson | null;
}

export function toFullWidthDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

export function isPersonEmpty(p: EnvelopePerson): boolean {
  return p.postalCode.trim() === "" && p.address.trim() === "" && p.name.trim() === "";
}

/** 宛名に敬称をつけた文字列。横書きは「名前 様」、縦書きは「名前様」（御中も同じ） */
export function nameWithHonorific(name: string, honorific: EnvelopeHonorific, mode: EnvelopeWritingMode): string {
  const n = name.trim();
  if (n === "" || honorific === "none") return n;
  const label = HONORIFIC_LABELS[honorific];
  return mode === "vertical" ? `${n}${label}` : `${n} ${label}`;
}

/** 文字サイズの検証・補正。範囲外・不正な値は null（既定値を使う）にする */
export function resolveSize(value: number | null, fallback: number): number {
  if (value === null || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_PT, Math.max(MIN_FONT_PT, value));
}

export function wrapByMeasure(text: string, size: number, maxWidth: number, measure: MeasureFn): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const candidate = current + ch;
      if (current !== "" && measure(candidate, size) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/** 郵便番号を1桁ずつ枠で囲んで横に並べる(右端から左へ) */
function postalBoxes(ops: EnvelopeOp[], postalCode: string, rightX: number, topY: number, box: number): void {
  const digits = postalCode.replace(/[^0-9]/g, "");
  if (digits.length === 0) return;
  const gap = box * 0.25;
  let x = rightX - box;
  for (let i = digits.length - 1; i >= 0; i--) {
    ops.push({ kind: "rect", x, y: topY, w: box, h: box, stroke: COLOR_MUTED });
    ops.push({ kind: "text", x: x + box / 2, y: topY + box * 0.78, size: box * 0.6, text: digits[i], bold: false, color: COLOR_TEXT, align: "center" });
    x -= box + gap;
    // 郵便番号は通常3桁-4桁でハイフンを挟むため、4桁目の後で少し間隔を空ける
    if (digits.length - i === 4) x -= gap;
  }
}

/** 縦書き: 1文字ずつ積み、列が埋まったら1列左へ。戻り値は使った列数 */
function verticalText(
  ops: EnvelopeOp[],
  text: string,
  startX: number,
  topY: number,
  size: number,
  lineHeight: number,
  columnGap: number,
  maxColumnHeight: number,
  color: Rgb,
  bold: boolean
): number {
  const chars = Array.from(toFullWidthDigits(text)).filter((c) => c !== "\n" && c !== "\r");
  if (chars.length === 0) return 0;
  const perColumn = Math.max(1, Math.floor(maxColumnHeight / lineHeight));
  chars.forEach((ch, i) => {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    ops.push({ kind: "text", x: startX - col * columnGap, y: topY + (row + 1) * lineHeight - (lineHeight - size) / 2 - size * 0.12, size, text: ch, bold, color, align: "center" });
  });
  return Math.ceil(chars.length / perColumn);
}

/** 縦書きの文字の「行の高さ」「列の間隔」は、文字サイズに比例させる(従来の既定値と同じ比率) */
const V_LINE = 1.42;
const V_COL_GAP = 2.05;

export function layoutEnvelope(input: EnvelopeLayoutInput, measure: MeasureFn): EnvelopeOp[] {
  const { width: w, height: h, writingMode, honorific, style, recipient: r, sender } = input;
  const defaults = DEFAULT_SIZES[writingMode];
  const nameSize = resolveSize(style.nameSize, defaults.name);
  const addrSize = resolveSize(style.addressSize, defaults.address);
  const senderSize = resolveSize(style.senderSize, defaults.sender);
  const landscape = w >= h;
  const ops: EnvelopeOp[] = [];

  if (r) {
    if (writingMode === "vertical") {
      const topMargin = mmToPt(18);
      if (r.postalCode.trim()) postalBoxes(ops, r.postalCode, w - mmToPt(20), mmToPt(6), mmToPt(6));
      const maxCol = h - topMargin - mmToPt(15);
      const addrLine = addrSize * V_LINE;
      const addrGap = addrSize * V_COL_GAP;
      const nameLine = nameSize * V_LINE;
      const nameGap = nameSize * V_COL_GAP;
      let addrCols = 0;
      const addrX = w * 0.62;
      if (r.address.trim()) {
        addrCols = verticalText(ops, r.address, addrX, topMargin, addrSize, addrLine, addrGap, maxCol, COLOR_MUTED, style.addressBold);
      }
      const nm = nameWithHonorific(r.name, honorific, writingMode);
      if (nm) {
        // 住所の列が増えて宛名の列とぶつからないよう、宛名の列を住所の左端より左へ寄せる
        const addrLeft = addrX - Math.max(0, addrCols - 1) * addrGap;
        const nameX = Math.min(w * 0.46, addrLeft - (addrGap + nameGap) / 2);
        verticalText(ops, nm, nameX, topMargin, nameSize, nameLine, nameGap, maxCol, COLOR_TEXT, style.nameBold);
      }
    } else {
      const x0 = landscape ? w * 0.4 : w * 0.12;
      const wrapW = landscape ? w * 0.42 : w * 0.76;
      let y = landscape ? h - h * 0.6 : h * 0.22;
      if (r.postalCode.trim()) {
        postalBoxes(ops, r.postalCode, w - mmToPt(landscape ? 15 : 12), y, mmToPt(6));
        y += mmToPt(12);
      } else {
        y += addrSize;
      }
      const step = addrSize * 1.54;
      const lines = wrapByMeasure(r.address, addrSize, wrapW, measure);
      if (r.address.trim()) {
        lines.forEach((line, i) => ops.push({ kind: "text", x: x0, y: y + i * step, size: addrSize, text: line, bold: style.addressBold, color: COLOR_TEXT, align: "left" }));
        y += step * lines.length;
      }
      y += addrSize * 0.77 + (nameSize - addrSize > 0 ? (nameSize - addrSize) * 0.6 : 0);
      const nm = nameWithHonorific(r.name, honorific, writingMode);
      if (nm) {
        // 長い宛名は幅に収まるよう折り返す
        const nameLines = wrapByMeasure(nm, nameSize, wrapW, measure);
        nameLines.forEach((line, i) => ops.push({ kind: "text", x: x0, y: y + i * nameSize * 1.3, size: nameSize, text: line, bold: style.nameBold, color: COLOR_TEXT, align: "left" }));
      }
    }
  }

  if (sender && !isPersonEmpty(sender)) {
    if (writingMode === "vertical") {
      const topY = h * 0.38;
      if (sender.postalCode.trim()) {
        ops.push({ kind: "text", x: mmToPt(12), y: h * 0.34, size: senderSize * 0.9, text: `〒${sender.postalCode}`, bold: style.senderBold, color: COLOR_MUTED, align: "left" });
      }
      const combined = [sender.address, sender.name].filter((v) => v.trim() !== "").join("　");
      if (combined.trim()) {
        verticalText(ops, combined, mmToPt(15), topY, senderSize, senderSize * 1.6, senderSize * 2.1, h * 0.5, COLOR_MUTED, style.senderBold);
      }
    } else {
      const x = mmToPt(15);
      const step = senderSize * 1.33;
      // 差出人の行数ぶんを先に数え、封筒の下端から一定の余白(下から20mm)に最後の行が来るように置く
      const lines = sender.address.trim() ? wrapByMeasure(sender.address, senderSize, mmToPt(70), measure) : [];
      const total = (sender.postalCode.trim() ? 1 : 0) + lines.length + (sender.name.trim() ? 1 : 0);
      let y = h - mmToPt(20) - step * Math.max(0, total - 1) + 0;
      if (sender.postalCode.trim()) {
        ops.push({ kind: "text", x, y, size: senderSize, text: `〒${sender.postalCode}`, bold: style.senderBold, color: COLOR_MUTED, align: "left" });
        y += step;
      }
      for (const line of lines) {
        ops.push({ kind: "text", x, y, size: senderSize, text: line, bold: style.senderBold, color: COLOR_MUTED, align: "left" });
        y += step;
      }
      if (sender.name.trim()) {
        ops.push({ kind: "text", x, y, size: senderSize * 1.1, text: sender.name, bold: style.senderBold, color: COLOR_TEXT, align: "left" });
      }
    }
  }

  return ops;
}
