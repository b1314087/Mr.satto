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
 * 郵便番号の枠は描かない。宛先・差出人の各項目と、自由に入力したテキストは、
 * それぞれ文字サイズ・太字・位置(封筒に対する%)を指定できる。位置を指定しない項目は、標準の位置に置く。
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

/** 位置・文字サイズを個別に指定できる項目 */
export type EnvelopeBlockId = "rPostal" | "rAddress" | "rName" | "sPostal" | "sAddress" | "sName";

export const ENVELOPE_BLOCK_IDS: EnvelopeBlockId[] = ["rPostal", "rAddress", "rName", "sPostal", "sAddress", "sName"];

export const ENVELOPE_BLOCK_LABELS: Record<EnvelopeBlockId, string> = {
  rPostal: "宛先の郵便番号",
  rAddress: "宛先の住所",
  rName: "宛名",
  sPostal: "差出人の郵便番号",
  sAddress: "差出人の住所",
  sName: "差出人の名前",
};

/**
 * 1項目の指定。size=null・x=null・y=null は「標準」。
 * x, y は封筒の幅・高さに対する%(0〜100)。
 * 横書き: x=文字の左端、y=1行目の上端。縦書き: x=1列目の中心、y=上端。
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
export const DEFAULT_SIZES: Record<EnvelopeWritingMode, { name: number; address: number; sender: number }> = {
  vertical: { name: 18, address: 11, sender: 8 },
  horizontal: { name: 22, address: 13, sender: 9 },
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

/** 郵便番号の表示。数字7桁なら「〒123-4567」、それ以外は入力どおりに「〒」をつける */
export function formatPostal(raw: string): string {
  const t = raw.trim();
  if (t === "") return "";
  const digits = t.replace(/[^0-9]/g, "");
  if (/^[0-9]{7}$/.test(digits) && !/[^0-9\-ー－\s]/.test(t)) return `〒${digits.slice(0, 3)}-${digits.slice(3)}`;
  return t.startsWith("〒") ? t : `〒${t}`;
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

/** 縦書きで使う列の数(改行で列を変える。列が埋まったら次の列へ) */
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

/** 縦書き: 列を右から左へ並べる。startX は1列目の中心。戻り値は使った列数 */
function pushVertical(ops: EnvelopeOp[], text: string, startX: number, topY: number, size: number, maxColumnHeight: number, bold: boolean): number {
  const columns = verticalColumns(text, size, maxColumnHeight);
  const line = size * V_LINE;
  const gap = size * V_COL_GAP;
  columns.forEach((chars, col) => {
    chars.forEach((ch, row) => {
      ops.push({ kind: "text", x: startX - col * gap, y: topY + (row + 1) * line - (line - size) / 2 - size * 0.12, size, text: ch, bold, color: COLOR_TEXT, align: "center" });
    });
  });
  return columns.length;
}

/** 横書き: 折り返しながら行を並べる。y は1行目の上端。戻り値は行数 */
function pushHorizontal(ops: EnvelopeOp[], text: string, x: number, topY: number, size: number, maxWidth: number, bold: boolean, measure: MeasureFn, step = size * 1.4): number {
  const lines = wrapByMeasure(text, size, maxWidth, measure);
  lines.forEach((line, i) => {
    if (line !== "") ops.push({ kind: "text", x, y: topY + size + i * step, size, text: line, bold, color: COLOR_TEXT, align: "left" });
  });
  return lines.length;
}

export interface EnvelopeBlockPlacement {
  id: EnvelopeBlockId;
  /** 実際に使う文字サイズ(pt) */
  size: number;
  /** 実際に使う位置(封筒に対する%)。指定が無いときは標準の位置 */
  xPct: number;
  yPct: number;
  /** この項目に表示する文字(空のときは何も描かない) */
  text: string;
}

const RIGHT_MARGIN_MM = 5;

/**
 * 各項目の「文字・文字サイズ・位置」を決める。位置の指定が無い項目は、
 * 他の項目(住所の行数など)をふまえた標準の位置にする。
 * 画面のスライダーの現在値にも使う。
 */
export function resolveBlocks(input: EnvelopeLayoutInput, measure: MeasureFn): Record<EnvelopeBlockId, EnvelopeBlockPlacement> {
  const { width: w, height: h, writingMode, honorific, blocks, recipient: r, sender } = input;
  const d = DEFAULT_SIZES[writingMode];
  const landscape = w >= h;
  const vertical = writingMode === "vertical";
  const size = {
    rPostal: resolveSize(blocks.rPostal.size, d.address),
    rAddress: resolveSize(blocks.rAddress.size, d.address),
    rName: resolveSize(blocks.rName.size, d.name),
    sPostal: resolveSize(blocks.sPostal.size, d.sender),
    sAddress: resolveSize(blocks.sAddress.size, d.sender),
    sName: resolveSize(blocks.sName.size, Math.round(d.sender * 1.1 * 10) / 10),
  };
  const text: Record<EnvelopeBlockId, string> = {
    rPostal: r ? formatPostal(r.postalCode) : "",
    rAddress: r ? r.address.trim() : "",
    rName: r ? nameWithHonorific(r.name, honorific, writingMode) : "",
    sPostal: sender ? formatPostal(sender.postalCode) : "",
    sAddress: sender ? sender.address.trim() : "",
    sName: sender ? sender.name.trim() : "",
  };
  const pos = {} as Record<EnvelopeBlockId, { x: number; y: number }>; // pt
  const explicit = (id: EnvelopeBlockId, def: { x: number; y: number }) => ({
    x: blocks[id].x !== null ? (blocks[id].x! / 100) * w : def.x,
    y: blocks[id].y !== null ? (blocks[id].y! / 100) * h : def.y,
  });
  const maxW = (x: number) => Math.max(mmToPt(20), w - x - mmToPt(RIGHT_MARGIN_MM));
  const maxCol = (y: number) => Math.max(size.rName, h - y - mmToPt(8));

  if (vertical) {
    const top = mmToPt(18);
    const postalW = measure(text.rPostal, size.rPostal);
    pos.rPostal = explicit("rPostal", { x: w - mmToPt(20) - postalW, y: mmToPt(8) });
    pos.rAddress = explicit("rAddress", { x: w * 0.62, y: top });
    const addrCols = text.rAddress ? verticalColumns(text.rAddress, size.rAddress, maxCol(pos.rAddress.y)).length : 0;
    const addrGap = size.rAddress * V_COL_GAP;
    const nameGap = size.rName * V_COL_GAP;
    // 住所の列が増えて宛名の列とぶつからないよう、宛名の列を住所の左端より左へ寄せる
    const addrLeft = pos.rAddress.x - Math.max(0, addrCols - 1) * addrGap;
    pos.rName = explicit("rName", { x: Math.min(w * 0.46, addrLeft - (addrGap + nameGap) / 2), y: top });
    pos.sPostal = explicit("sPostal", { x: mmToPt(12), y: h * 0.34 - size.sPostal });
    pos.sAddress = explicit("sAddress", { x: mmToPt(24), y: h * 0.38 });
    const sCols = text.sAddress ? verticalColumns(text.sAddress, size.sAddress, maxCol(pos.sAddress.y)).length : 0;
    const sGap = size.sAddress * V_COL_GAP;
    pos.sName = explicit("sName", { x: Math.max(size.sName, pos.sAddress.x - sCols * sGap), y: h * 0.38 });
  } else {
    const x0 = landscape ? w * 0.4 : w * 0.12;
    const y0 = landscape ? h * 0.4 : h * 0.22;
    pos.rPostal = explicit("rPostal", { x: x0, y: y0 });
    pos.rAddress = explicit("rAddress", { x: x0, y: text.rPostal ? pos.rPostal.y + size.rPostal * 1.9 : y0 });
    const addrLines = text.rAddress ? wrapByMeasure(text.rAddress, size.rAddress, maxW(pos.rAddress.x), measure).length : 0;
    pos.rName = explicit("rName", {
      x: x0,
      y: text.rAddress ? pos.rAddress.y + addrLines * size.rAddress * 1.4 + size.rAddress * 0.6 : pos.rAddress.y,
    });
    // 差出人は、最後の行が封筒の下端から20mmの位置に来るように積む
    const step = size.sAddress * 1.33;
    const sLines = text.sAddress ? wrapByMeasure(text.sAddress, size.sAddress, mmToPt(70), measure).length : 0;
    const total = (text.sPostal ? 1 : 0) + sLines + (text.sName ? 1 : 0);
    const firstTop = h - mmToPt(20) - step * Math.max(0, total - 1) - size.sPostal;
    const sx = mmToPt(15);
    pos.sPostal = explicit("sPostal", { x: sx, y: firstTop });
    pos.sAddress = explicit("sAddress", { x: sx, y: firstTop + (text.sPostal ? step : 0) });
    pos.sName = explicit("sName", { x: sx, y: pos.sAddress.y + sLines * step + (text.sAddress ? 0 : 0) });
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
    if (b.text === "") continue;
    const x = (b.xPct / 100) * w;
    const y = (b.yPct / 100) * h;
    const postalLike = id === "rPostal" || id === "sPostal";
    if (vertical && !postalLike) {
      pushVertical(ops, b.text, x, y, b.size, Math.max(b.size, h - y - mmToPt(8)), blocks[id].bold);
    } else {
      pushHorizontal(ops, b.text, x, y, b.size, id === "sAddress" && !vertical ? mmToPt(70) : Math.max(mmToPt(20), w - x - mmToPt(RIGHT_MARGIN_MM)), blocks[id].bold, measure, id.startsWith("s") ? b.size * 1.33 : undefined);
    }
  }

  for (const f of freeTexts) {
    if (f.text.trim() === "") continue;
    const size = resolveSize(f.size, DEFAULT_FREE_TEXT_SIZE);
    const x = (f.x / 100) * w;
    const y = (f.y / 100) * h;
    if (vertical) pushVertical(ops, f.text, x, y, size, Math.max(size, h - y - mmToPt(8)), f.bold);
    else pushHorizontal(ops, f.text, x, y, size, Math.max(mmToPt(20), w - x - mmToPt(RIGHT_MARGIN_MM)), f.bold, measure);
  }
  return ops;
}
