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
 *
 * 郵便番号の枠は描かない。宛先・差出人・自由に入力したテキストは、それぞれ1つの複数行テキスト枠で、
 * 枠ごとに文字サイズ・太字・位置(封筒に対する%)を指定できる。位置を指定しない枠は、標準の位置に置く。
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

/** 位置・文字サイズを個別に指定できる枠(宛先・差出人) */
export type EnvelopeBlockId = "recipient" | "sender";

export const ENVELOPE_BLOCK_IDS: EnvelopeBlockId[] = ["recipient", "sender"];

export const ENVELOPE_BLOCK_LABELS: Record<EnvelopeBlockId, string> = {
  recipient: "宛先",
  sender: "差出人",
};

/**
 * 1つの枠の指定。size=null・x=null・y=null は「標準」。
 * x, y は封筒の幅・高さに対する%(0〜100)。
 * 横書き: x=文字の左端、y=1行目の上端。縦書き: x=1列目(いちばん右)の中心、y=上端。
 */
export interface EnvelopeBlockStyle {
  size: number | null;
  bold: boolean;
  x: number | null;
  y: number | null;
}

export type EnvelopeBlocks = Record<EnvelopeBlockId, EnvelopeBlockStyle>;

export function defaultBlocks(): EnvelopeBlocks {
  const b = {} as EnvelopeBlocks;
  for (const id of ENVELOPE_BLOCK_IDS) b[id] = { size: null, bold: false, x: null, y: null };
  return b;
}

/** 自由に入力するテキスト(すべての封筒に同じ内容・位置で印刷する。「在中」など) */
export interface EnvelopeFreeText {
  id: string;
  text: string;
  size: number;
  bold: boolean;
  /** 位置(封筒に対する%) */
  x: number;
  y: number;
}

export const DEFAULT_FREE_TEXT_SIZE = 14;

export function newFreeText(id: string, partial: Partial<EnvelopeFreeText> = {}): EnvelopeFreeText {
  return { id, text: "", size: DEFAULT_FREE_TEXT_SIZE, bold: false, x: 12, y: 12, ...partial };
}

/** 書字方向ごとの既定の文字サイズ(pt) */
export const DEFAULT_SIZES: Record<EnvelopeWritingMode, Record<EnvelopeBlockId, number>> = {
  vertical: { recipient: 15, sender: 8 },
  horizontal: { recipient: 16, sender: 9 },
};

export const MIN_FONT_PT = 6;
export const MAX_FONT_PT = 60;

export type Rgb = [number, number, number];
const COLOR_TEXT: Rgb = [0.1, 0.1, 0.12];

export type EnvelopeOp = { kind: "text"; x: number; y: number; size: number; text: string; bold: boolean; color: Rgb; align: "left" | "center" };

export type MeasureFn = (text: string, size: number) => number;

export interface EnvelopeLayoutInput {
  width: number;
  height: number;
  writingMode: EnvelopeWritingMode;
  honorific: EnvelopeHonorific;
  blocks: EnvelopeBlocks;
  freeTexts: EnvelopeFreeText[];
  /** この封筒の宛先(複数行。郵便番号・住所・氏名を改行で区切って入力する) */
  recipient: string | undefined;
  /** 差出人(複数行)。印刷しないときは null */
  sender: string | null;
}

export function toFullWidthDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

export function isTextEmpty(t: string): boolean {
  return t.trim() === "";
}

const HONORIFIC_PATTERN = /(様|御中|殿)$/;

/**
 * 宛先の最後の行に敬称をつける。すでに「様」「御中」「殿」で終わっているときは何もしない。
 * 横書きは「名前 様」、縦書きは「名前様」（御中も同じ）。
 */
export function applyHonorific(text: string, honorific: EnvelopeHonorific, mode: EnvelopeWritingMode): string {
  if (honorific === "none") return text;
  const lines = text.split(/\r\n|\r|\n/);
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0) return text;
  const line = lines[last].trimEnd();
  if (HONORIFIC_PATTERN.test(line)) return text;
  const label = HONORIFIC_LABELS[honorific];
  lines[last] = mode === "vertical" ? `${line}${label}` : `${line} ${label}`;
  return lines.join("\n");
}

/** Excel/CSVの列から宛先の文字を作る。郵便番号は数字7桁なら「〒123-4567」にし、空の項目は飛ばして1項目1行にする */
export function composeRecipientText(parts: { postalCode: string; address: string; name: string }): string {
  const postal = parts.postalCode.trim();
  let postalText = postal;
  if (postal !== "") {
    const digits = postal.replace(/[^0-9]/g, "");
    postalText = /^[0-9]{7}$/.test(digits) && !/[^0-9\-ー－\s]/.test(postal) ? `〒${digits.slice(0, 3)}-${digits.slice(3)}` : postal;
  }
  return [postalText, parts.address.trim(), parts.name.trim()].filter((v) => v !== "").join("\n");
}

/** 文字サイズの検証・補正。範囲外・不正な値は既定値にする */
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

/** 縦書きの文字の「行の高さ」「列の間隔」は、文字サイズに比例させる */
const V_LINE = 1.42;
const V_COL_GAP = 2.05;

/** 縦書きで使う列(改行で列を変える。列が埋まったら次の列へ) */
function verticalColumns(text: string, size: number, maxColumnHeight: number): string[][] {
  const perColumn = Math.max(1, Math.floor(maxColumnHeight / (size * V_LINE)));
  const columns: string[][] = [];
  for (const paragraph of toFullWidthDigits(text).split(/\r\n|\r|\n/)) {
    const chars = Array.from(paragraph);
    if (chars.length === 0) continue;
    for (let i = 0; i < chars.length; i += perColumn) columns.push(chars.slice(i, i + perColumn));
  }
  return columns;
}

/** 縦書き: 列を右から左へ並べる。startX は1列目の中心 */
function pushVertical(ops: EnvelopeOp[], text: string, startX: number, topY: number, size: number, maxColumnHeight: number, bold: boolean): void {
  const columns = verticalColumns(text, size, maxColumnHeight);
  const line = size * V_LINE;
  const gap = size * V_COL_GAP;
  columns.forEach((chars, col) => {
    chars.forEach((ch, row) => {
      ops.push({ kind: "text", x: startX - col * gap, y: topY + (row + 1) * line - (line - size) / 2 - size * 0.12, size, text: ch, bold, color: COLOR_TEXT, align: "center" });
    });
  });
}

/** 横書き: 折り返しながら行を並べる。topY は1行目の上端 */
function pushHorizontal(ops: EnvelopeOp[], text: string, x: number, topY: number, size: number, maxWidth: number, bold: boolean, measure: MeasureFn, step: number): void {
  const lines = wrapByMeasure(text, size, maxWidth, measure);
  lines.forEach((line, i) => {
    if (line !== "") ops.push({ kind: "text", x, y: topY + size + i * step, size, text: line, bold, color: COLOR_TEXT, align: "left" });
  });
}

export interface EnvelopeBlockPlacement {
  id: EnvelopeBlockId;
  /** 実際に使う文字サイズ(pt) */
  size: number;
  /** 実際に使う位置(封筒に対する%)。指定が無いときは標準の位置 */
  xPct: number;
  yPct: number;
  /** この枠に印刷する文字(敬称つき。空のときは何も描かない) */
  text: string;
}

const RIGHT_MARGIN_MM = 5;
const SENDER_WRAP_MM = 70;

/** 横書きの行送り。宛先は文字サイズの1.45倍、差出人は1.33倍 */
function lineStep(id: EnvelopeBlockId | "free", size: number): number {
  return size * (id === "sender" ? 1.33 : 1.45);
}

/**
 * 宛先・差出人の「文字・文字サイズ・位置」を決める。位置の指定が無い枠は標準の位置にする。
 * 画面のスライダーの現在値にも使う。
 */
export function resolveBlocks(input: EnvelopeLayoutInput, measure: MeasureFn): Record<EnvelopeBlockId, EnvelopeBlockPlacement> {
  const { width: w, height: h, writingMode, honorific, blocks } = input;
  const vertical = writingMode === "vertical";
  const landscape = w >= h;
  const d = DEFAULT_SIZES[writingMode];
  const size = {
    recipient: resolveSize(blocks.recipient.size, d.recipient),
    sender: resolveSize(blocks.sender.size, d.sender),
  };
  const text = {
    recipient: input.recipient ? applyHonorific(input.recipient.trim() === "" ? "" : input.recipient, honorific, writingMode) : "",
    sender: input.sender ?? "",
  };
  const pos = {} as Record<EnvelopeBlockId, { x: number; y: number }>; // pt
  const explicit = (id: EnvelopeBlockId, def: { x: number; y: number }) => ({
    x: blocks[id].x !== null ? (blocks[id].x! / 100) * w : def.x,
    y: blocks[id].y !== null ? (blocks[id].y! / 100) * h : def.y,
  });

  if (vertical) {
    pos.recipient = explicit("recipient", { x: w * 0.62, y: mmToPt(16) });
    pos.sender = explicit("sender", { x: mmToPt(26), y: h * 0.38 });
  } else {
    pos.recipient = explicit("recipient", { x: landscape ? w * 0.4 : w * 0.12, y: landscape ? h * 0.38 : h * 0.22 });
    // 差出人は、最後の行が封筒の下端から20mmの位置に来るように置く
    const lines = text.sender ? wrapByMeasure(text.sender, size.sender, mmToPt(SENDER_WRAP_MM), measure).length : 1;
    const step = lineStep("sender", size.sender);
    pos.sender = explicit("sender", { x: mmToPt(15), y: h - mmToPt(20) - step * Math.max(0, lines - 1) - size.sender });
  }
  const out = {} as Record<EnvelopeBlockId, EnvelopeBlockPlacement>;
  for (const id of ENVELOPE_BLOCK_IDS) {
    out[id] = {
      id,
      size: size[id],
      xPct: Math.round((pos[id].x / w) * 1000) / 10,
      yPct: Math.round((pos[id].y / h) * 1000) / 10,
      text: text[id],
    };
  }
  return out;
}

export function layoutEnvelope(input: EnvelopeLayoutInput, measure: MeasureFn): EnvelopeOp[] {
  const { width: w, height: h, writingMode, blocks, freeTexts } = input;
  const vertical = writingMode === "vertical";
  const placed = resolveBlocks(input, measure);
  const ops: EnvelopeOp[] = [];

  for (const id of ENVELOPE_BLOCK_IDS) {
    const b = placed[id];
    if (b.text.trim() === "") continue;
    const x = (b.xPct / 100) * w;
    const y = (b.yPct / 100) * h;
    if (vertical) {
      pushVertical(ops, b.text, x, y, b.size, Math.max(b.size, h - y - mmToPt(8)), blocks[id].bold);
    } else {
      const maxW = id === "sender" ? mmToPt(SENDER_WRAP_MM) : Math.max(mmToPt(20), w - x - mmToPt(RIGHT_MARGIN_MM));
      pushHorizontal(ops, b.text, x, y, b.size, maxW, blocks[id].bold, measure, lineStep(id, b.size));
    }
  }

  for (const f of freeTexts) {
    if (f.text.trim() === "") continue;
    const size = resolveSize(f.size, DEFAULT_FREE_TEXT_SIZE);
    const x = (f.x / 100) * w;
    const y = (f.y / 100) * h;
    if (vertical) pushVertical(ops, f.text, x, y, size, Math.max(size, h - y - mmToPt(8)), f.bold);
    else pushHorizontal(ops, f.text, x, y, size, Math.max(mmToPt(20), w - x - mmToPt(RIGHT_MARGIN_MM)), f.bold, measure, lineStep("free", size));
  }
  return ops;
}
