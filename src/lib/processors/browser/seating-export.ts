import type { PDFFont, PDFPage } from "pdf-lib";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { rotateLayout, SEAT_H, SEAT_W, type LayoutGeometry } from "@/lib/seating/layouts";
import type { Participant } from "@/lib/seating/participants";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";

/**
 * 座席表の書き出し（画像 PNG・JPEG、PDF）。ブラウザ内だけで作る（名前は外部に送らない）。
 * 画像とPDFは、同じ描き方（paintChart）で描く。PDFは文字のまま（拡大しても粗くならず、文字を選べる）。
 * 「前後を1ページに」を選ぶと、前が上の向きと、上下を逆にした向き（前が下）の2つを、1枚に並べる
 * （黒板側から見る人と、後ろから見る人の両方がそのまま読めるように）。
 */

export interface SeatingChartModel {
  title: string;
  geometry: LayoutGeometry;
  /** 席ごとの人（geometry.seats と同じ並び。空席は null） */
  assignment: (Participant | null)[];
  /** 席に入らなかった人 */
  unseated: Participant[];
  /** 席ごとの札（「来賓」「司会」など。geometry.seats と同じ並び。無ければ空文字）。札は人ではなく席に付く */
  tags?: string[];
  /** ふりがなを付けるか（付けるときは、名前の上に小さく描く） */
  furigana?: boolean;
  /** 空席にした席（だれも座らせない席。「空席」と描く。geometry.seats と同じ並び） */
  blocked?: boolean[];
  /** 出席番号を付けるか（付けるときは、名前の前に描く。番号は Participant.number） */
  numbers?: boolean;
  /** 出席番号を赤で描くか（新工程1：授業・カスタムのときだけ。ほかの用途は名前と同じ色） */
  redNumbers?: boolean;
}

/** 出席番号を赤で描く用途（授業・カスタム） */
export function usesRedNumbers(purpose: string | null | undefined): boolean {
  return purpose === "classroom" || purpose === "custom";
}

/** 席に描く名前（出席番号を付けるときは「12 山田太郎」） */
export function seatLabel(model: Pick<SeatingChartModel, "numbers">, person: Participant): string {
  return model.numbers && person.number ? `${person.number} ${person.name}` : person.name;
}

/** 用紙（JISのA列・B列と、レター・リーガル） */
export const PAPER_SIZES = [
  { value: "A3", label: "A3（297×420mm）", mm: [297, 420] },
  { value: "A4", label: "A4（210×297mm）", mm: [210, 297] },
  { value: "A5", label: "A5（148×210mm）", mm: [148, 210] },
  { value: "A6", label: "A6（105×148mm）", mm: [105, 148] },
  { value: "B4", label: "B4（257×364mm）", mm: [257, 364] },
  { value: "B5", label: "B5（182×257mm）", mm: [182, 257] },
  { value: "B6", label: "B6（128×182mm）", mm: [128, 182] },
  { value: "Letter", label: "レター（216×279mm）", mm: [215.9, 279.4] },
  { value: "Legal", label: "リーガル（216×356mm）", mm: [215.9, 355.6] },
] as const;
export type PaperSize = (typeof PAPER_SIZES)[number]["value"];
const PT_PER_MM = 72 / 25.4;
/** 用紙の長い辺・短い辺（pt） */
export const PAPER_PT = Object.fromEntries(
  PAPER_SIZES.map((p) => [p.value, [p.mm[1] * PT_PER_MM, p.mm[0] * PT_PER_MM]])
) as Record<PaperSize, [number, number]>;

/** 用紙の向き：auto＝座席表の形に合わせる */
export type PaperOrientation = "auto" | "portrait" | "landscape";

export type ExportFormat = "png" | "jpeg" | "pdf";

export interface ExportOptions {
  paper?: PaperSize;
  orientation?: PaperOrientation;
  /** 前が上の向きと、上下を逆にした向きを、1枚に並べる */
  bothViews?: boolean;
}

export const TITLE_H = 64;
const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","YuGothic","Meiryo","Noto Sans JP",sans-serif';

type Color = [number, number, number];
const INK: Color = [0.12, 0.14, 0.18];
const MUTED: Color = [0.42, 0.45, 0.5];
const SEAT_BORDER: Color = [0.62, 0.66, 0.72];
const TABLE_FILL: Color = [0.92, 0.94, 0.97];
const TABLE_BORDER: Color = [0.6, 0.66, 0.74];
const MARK_FILL: Color = [0.2, 0.25, 0.33];
const WHITE: Color = [1, 1, 1];
const EMPTY_FILL: Color = [0.97, 0.97, 0.98];
const TAG_FILL: Color = [0.98, 0.82, 0.35];
const TAG_INK: Color = [0.35, 0.2, 0.0];
const NUMBER_RED: Color = [0.8, 0.1, 0.1];

interface TextOpts {
  size: number;
  color: Color;
  bold?: boolean;
  /** 横位置の基準：中央（既定）か左 */
  align?: "center" | "left";
}

/** 描く道具（画像は canvas、PDFは pdf-lib）。座標は、上が0の点（px） */
export interface Painter {
  rect(x: number, y: number, w: number, h: number, fill: Color | null, stroke: Color | null, lineWidth?: number): void;
  circle(cx: number, cy: number, r: number, fill: Color, stroke: Color): void;
  /** y は文字の縦の中心 */
  text(text: string, x: number, y: number, opts: TextOpts): void;
  measure(text: string, size: number, bold?: boolean): number;
}

/** 幅に収まる文字の大きさ（最小 minSize） */
function fitSize(p: Painter, text: string, size: number, maxWidth: number, bold: boolean, minSize: number): number {
  const w = p.measure(text, size, bold);
  if (w <= maxWidth) return size;
  return Math.max(minSize, (size * maxWidth) / w);
}

/** 名前（出席番号つき）を描く。赤い番号のときは、番号と名前を分けて、全体が中央にくるように描く */
function paintLabel(p: Painter, model: SeatingChartModel, person: Participant, cx: number, y: number, baseSize: number, maxW: number) {
  const label = seatLabel(model, person);
  const size = fitSize(p, label, baseSize, maxW, true, 7);
  if (!(model.redNumbers && model.numbers && person.number)) {
    p.text(label, cx, y, { size, color: INK, bold: true });
    return;
  }
  const num = `${person.number} `;
  const total = p.measure(label, size, true);
  const left = cx - total / 2;
  p.text(num, left, y, { size, color: NUMBER_RED, bold: true, align: "left" });
  p.text(person.name, left + p.measure(num, size, true), y, { size, color: INK, bold: true, align: "left" });
}

export function paintChart(p: Painter, model: SeatingChartModel) {
  const { geometry: g } = model;
  const title = model.title.trim() || "座席表";
  p.text(title, 28, 32, { size: fitSize(p, title, 26, g.width - 56, true, 12), color: INK, bold: true, align: "left" });
  const oy = TITLE_H;

  for (const sh of g.shapes) {
    if (sh.kind === "rect") {
      p.rect(sh.x, sh.y + oy, sh.w, sh.h, TABLE_FILL, TABLE_BORDER, 1.2);
      if (sh.label) p.text(sh.label, sh.x + sh.w / 2, sh.y + oy + sh.h / 2, { size: 13, color: MUTED });
    } else {
      p.circle(sh.cx, sh.cy + oy, sh.r, TABLE_FILL, TABLE_BORDER);
      if (sh.label) p.text(sh.label, sh.cx, sh.cy + oy, { size: 14, color: MUTED });
    }
  }
  for (const m of g.marks) {
    p.rect(m.x, m.y + oy, m.w, 30, MARK_FILL, null);
    p.text(m.text, m.x + m.w / 2, m.y + oy + 15, { size: 14, color: WHITE, bold: true });
  }
  g.seats.forEach((seat, i) => {
    const person = model.assignment[i];
    const x = seat.x;
    const y = seat.y + oy;
    p.rect(x, y, SEAT_W, SEAT_H, person ? WHITE : EMPTY_FILL, SEAT_BORDER, 1);
    p.text(String(i + 1), x + 6, y + 10, { size: 10, color: MUTED, align: "left" });
    const tag = (model.tags?.[i] ?? "").trim();
    if (tag) {
      const size = fitSize(p, tag, 10, SEAT_W - 40, true, 6);
      const w = p.measure(tag, size, true) + 10;
      p.rect(x + SEAT_W - w - 4, y + 3, w, 15, TAG_FILL, null);
      p.text(tag, x + SEAT_W - w / 2 - 4, y + 10.5, { size, color: TAG_INK, bold: true });
    }
    if (!person) {
      if (model.blocked?.[i]) p.text("空席", x + SEAT_W / 2, y + SEAT_H / 2 + 3, { size: 14, color: MUTED, bold: true });
      return;
    }
    const maxW = SEAT_W - 14;
    const reading = model.furigana ? (person.reading ?? "").trim() : "";
    const cx = x + SEAT_W / 2;
    if (reading && person.role) {
      p.text(reading, cx, y + 17, { size: fitSize(p, reading, 9, maxW, false, 5), color: MUTED });
      paintLabel(p, model, person, cx, y + 32, 16, maxW);
      p.text(person.role, cx, y + 49, { size: fitSize(p, person.role, 10, maxW, false, 6), color: MUTED });
    } else if (reading) {
      p.text(reading, cx, y + 20, { size: fitSize(p, reading, 10, maxW, false, 5), color: MUTED });
      paintLabel(p, model, person, cx, y + 38, 18, maxW);
    } else if (person.role) {
      paintLabel(p, model, person, cx, y + 27, 17, maxW);
      p.text(person.role, cx, y + 46, { size: fitSize(p, person.role, 11, maxW, false, 6), color: MUTED });
    } else {
      paintLabel(p, model, person, cx, y + SEAT_H / 2 + 3, 18, maxW);
    }
  });
}

// ---------------------------------------------------------------------------
// 画像（canvas）
// ---------------------------------------------------------------------------

function css([r, g, b]: Color): string {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

export function canvasPainter(ctx: CanvasRenderingContext2D): Painter {
  const font = (size: number, bold?: boolean) => `${bold ? "bold " : ""}${size}px ${FONT}`;
  return {
    rect(x, y, w, h, fill, stroke, lineWidth = 1) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      if (fill) {
        ctx.fillStyle = css(fill);
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = css(stroke);
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }
    },
    circle(cx, cy, r, fill, stroke) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = css(fill);
      ctx.fill();
      ctx.strokeStyle = css(stroke);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    },
    text(text, x, y, opts) {
      ctx.font = font(opts.size, opts.bold);
      ctx.fillStyle = css(opts.color);
      ctx.textAlign = opts.align === "left" ? "left" : "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
    },
    measure(text, size, bold) {
      ctx.font = font(size, bold);
      return ctx.measureText(text).width;
    },
  };
}

export function chartSize(model: SeatingChartModel): { width: number; height: number } {
  return { width: Math.ceil(model.geometry.width), height: Math.ceil(model.geometry.height + TITLE_H) };
}

// ---------------------------------------------------------------------------
// 前後を1ページに（2つの向きを、用紙のちょうど半分ずつに並べる）
// ---------------------------------------------------------------------------
//
// 新工程1：用紙（画像は書き出す絵全体）を、真ん中の線でちょうど半分に分け、
// 片方に「前が上の向き」、もう片方に「前が下の向き」を入れる。それぞれの図は、自分の半分の中だけに収まるように縮小する
// （真ん中の線をまたがない・重ならない）。真ん中には、折る・切るときの目安の細い線を引く。

const CAPTION_H = 30;
/** 半分の中の余白（真ん中の線から図までの間も、この分あける） */
const HALF_PAD = 18;

interface PlacedView {
  model: SeatingChartModel;
  caption: string | null;
  dx: number;
  dy: number;
  /** この図を描く倍率（1＝元の大きさ） */
  scale: number;
}

/** 区切りの線（真ん中の線）。stacked＝上下に分ける */
export interface HalfDivider {
  stacked: boolean;
  /** 線の位置（上下に分けるときは y、左右に分けるときは x） */
  at: number;
}

export interface ComposedViews {
  views: PlacedView[];
  width: number;
  height: number;
  divider: HalfDivider | null;
}

/** 前の印（教卓・スクリーンなど）が、座席表の上半分にあるか（印が無ければ null） */
function frontIsUp(g: LayoutGeometry): boolean | null {
  if (g.marks.length === 0) return null;
  const m = g.marks[0];
  return m.y + 15 < g.height / 2;
}

/** 2つの向きの図と、見出し */
function twoViews(model: SeatingChartModel): { model: SeatingChartModel; caption: string }[] {
  const other: SeatingChartModel = { ...model, geometry: rotateLayout(model.geometry) };
  const up = frontIsUp(model.geometry);
  const cap = (isUp: boolean | null, fallback: string) => (isUp === null ? fallback : isUp ? "前が上の向き" : "前が下の向き");
  return [
    { model, caption: cap(up, "そのままの向き") },
    { model: other, caption: cap(up === null ? null : !up, "上下を逆にした向き") },
  ];
}

/** 1つの向きの図（見出しを含む）の大きさ */
function blockSize(model: SeatingChartModel): { w: number; h: number } {
  const size = chartSize(model);
  return { w: size.width, h: size.height + CAPTION_H };
}

/**
 * 幅 W・高さ H の面を、真ん中でちょうど半分に分け、2つの向きを1つずつ入れる（それぞれ半分の中で中央に置く）。
 * pad は半分の外側の余白（用紙の余白）、HALF_PAD は真ん中の線の両側の余白。
 */
export function composeHalves(model: SeatingChartModel, W: number, H: number, stacked: boolean, pad = 0): ComposedViews {
  const halfW = stacked ? W : W / 2;
  const halfH = stacked ? H / 2 : H;
  const block = blockSize(model);
  const innerW = Math.max(1, halfW - HALF_PAD * 2 - (stacked ? pad * 2 : pad));
  const innerH = Math.max(1, halfH - HALF_PAD * 2 - (stacked ? pad : pad * 2));
  const scale = Math.min(innerW / block.w, innerH / block.h);
  const views = twoViews(model).map((v, k) => {
    // 半分の範囲（用紙の余白は、外側の辺にだけとる）
    const x0 = stacked ? pad : k === 0 ? pad : W / 2;
    const y0 = stacked ? (k === 0 ? pad : H / 2) : pad;
    const x1 = stacked ? W - pad : k === 0 ? W / 2 : W - pad;
    const y1 = stacked ? (k === 0 ? H / 2 : H - pad) : H - pad;
    const dx = (x0 + x1) / 2 - (block.w * scale) / 2;
    const dy = (y0 + y1) / 2 - (block.h * scale) / 2;
    return { model: v.model, caption: v.caption, dx, dy, scale };
  });
  return { views, width: W, height: H, divider: { stacked, at: stacked ? H / 2 : W / 2 } };
}

/** 横長の座席表は上下に、縦長の座席表は左右に分ける（画像のとき） */
function stackedFor(model: SeatingChartModel): boolean {
  const size = chartSize(model);
  return size.width >= size.height;
}

/** 書き出す絵の並べ方（1つ、または2つの向き）と、全体の大きさ（画像用。2つの向きのときは、ちょうど半分ずつ） */
export function composeViews(model: SeatingChartModel, bothViews: boolean): ComposedViews {
  const size = chartSize(model);
  if (!bothViews) return { views: [{ model, caption: null, dx: 0, dy: 0, scale: 1 }], ...size, divider: null };
  const stacked = stackedFor(model);
  const block = blockSize(model);
  const halfW = block.w + HALF_PAD * 2;
  const halfH = block.h + HALF_PAD * 2;
  return composeHalves(model, stacked ? halfW : halfW * 2, stacked ? halfH * 2 : halfH, stacked);
}

/** 描く位置をずらし、大きさを変える（文字の幅の計り方も、同じ倍率で合わせる） */
function transformPainter(p: Painter, dx: number, dy: number, s: number): Painter {
  return {
    rect: (x, y, w, h, fill, stroke, lw = 1) => p.rect(x * s + dx, y * s + dy, w * s, h * s, fill, stroke, lw * s),
    circle: (cx, cy, r, fill, stroke) => p.circle(cx * s + dx, cy * s + dy, r * s, fill, stroke),
    text: (t, x, y, o) => p.text(t, x * s + dx, y * s + dy, { ...o, size: o.size * s }),
    measure: (t, size, bold) => p.measure(t, size * s, bold) / s,
  };
}

const DIVIDER: Color = [0.7, 0.73, 0.78];

function paintViews(p: Painter, layout: ComposedViews) {
  for (const v of layout.views) {
    const q = transformPainter(p, v.dx, v.dy, v.scale);
    if (v.caption) {
      q.rect(0, 2, chartSize(v.model).width, CAPTION_H - 6, [0.93, 0.95, 0.98], null);
      q.text(v.caption, 12, 2 + (CAPTION_H - 6) / 2, { size: 14, color: INK, bold: true, align: "left" });
    }
    paintChart(transformPainter(q, 0, v.caption ? CAPTION_H : 0, 1), v.model);
  }
  // 真ん中の線（折る・切るときの目安。点線）
  const d = layout.divider;
  if (d) {
    const len = d.stacked ? layout.width : layout.height;
    for (let t = 0; t < len; t += 12) {
      const seg = Math.min(6, len - t);
      if (d.stacked) p.rect(t, d.at - 0.4, seg, 0.8, DIVIDER, null);
      else p.rect(d.at - 0.4, t, 0.8, seg, DIVIDER, null);
    }
  }
}

export async function chartToImageBlob(model: SeatingChartModel, format: "png" | "jpeg", scale = 2, bothViews = false): Promise<Blob> {
  const layout = composeViews(model, bothViews);
  const width = Math.ceil(layout.width);
  const height = Math.ceil(layout.height);
  // 大きすぎる画像は作れないブラウザがあるため、辺の長さを抑える
  const s = Math.min(scale, 8000 / width, 8000 / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * s);
  canvas.height = Math.round(height * s);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("この環境では画像を作れませんでした");
  ctx.scale(s, s);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  paintViews(canvasPainter(ctx), layout);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画像を作れませんでした"))), format === "png" ? "image/png" : "image/jpeg", 0.92);
  });
}

// ---------------------------------------------------------------------------
// PDF（pdf-lib・文字のまま）
// ---------------------------------------------------------------------------

const PDF_MARGIN = 28;

function pdfPainter(page: PDFPage, font: PDFFont, scale: number, ox: number, pageH: number, oy: number): Painter {
  const X = (x: number) => ox + x * scale;
  const Y = (y: number) => pageH - (oy + y * scale);
  return {
    rect(x, y, w, h, fill, stroke, lineWidth = 1) {
      page.drawRectangle({
        x: X(x),
        y: Y(y + h),
        width: w * scale,
        height: h * scale,
        color: fill ? pdfLib().rgb(...fill) : undefined,
        borderColor: stroke ? pdfLib().rgb(...stroke) : undefined,
        borderWidth: stroke ? lineWidth * scale : 0,
      });
    },
    circle(cx, cy, r, fill, stroke) {
      page.drawCircle({ x: X(cx), y: Y(cy), size: r * scale, color: pdfLib().rgb(...fill), borderColor: pdfLib().rgb(...stroke), borderWidth: 1.2 * scale });
    },
    text(text, x, y, opts) {
      const size = opts.size * scale;
      const w = font.widthOfTextAtSize(text, size);
      const left = opts.align === "left" ? X(x) : X(x) - w / 2;
      page.drawText(text, { x: left, y: Y(y) - size * 0.36, size, font, color: pdfLib().rgb(...opts.color) });
    },
    measure(text, size) {
      return font.widthOfTextAtSize(text, size);
    },
  };
}

/** 用紙の幅・高さ（pt）。向きが auto のときは、絵の形に合わせる */
export function pdfPageSize(paper: PaperSize, orientation: PaperOrientation, contentW: number, contentH: number): [number, number] {
  const [long, short] = PAPER_PT[paper] ?? PAPER_PT.A4;
  const landscape = orientation === "landscape" || (orientation === "auto" && contentW >= contentH);
  return landscape ? [long, short] : [short, long];
}

/**
 * 「前後を1ページに」のときの用紙の向きと分け方。用紙は真ん中でちょうど半分に分ける。
 * 向きが「自動」のときは、縦・横と、上下・左右の分け方のうち、図がいちばん大きく入るものにする
 * （縦・横を選んだときは、その向きのまま、上下・左右のうち大きく入る方）。
 */
export function bothViewsPagePlan(model: SeatingChartModel, paper: PaperSize, orientation: PaperOrientation): { pageW: number; pageH: number; stacked: boolean; margin: number } {
  const [long, short] = PAPER_PT[paper] ?? PAPER_PT.A4;
  const sizes: [number, number][] = orientation === "portrait" ? [[short, long]] : orientation === "landscape" ? [[long, short]] : [[short, long], [long, short]];
  let best: { pageW: number; pageH: number; stacked: boolean; margin: number; scale: number } | null = null;
  for (const [pageW, pageH] of sizes) {
    const margin = Math.min(PDF_MARGIN, Math.min(pageW, pageH) * 0.05);
    for (const stacked of [true, false]) {
      const scale = composeHalves(model, pageW, pageH, stacked, margin).views[0].scale;
      if (!best || scale > best.scale + 1e-9) best = { pageW, pageH, stacked, margin, scale };
    }
  }
  const { scale: _s, ...plan } = best!;
  void _s;
  return plan;
}

export async function chartToPdfBlob(model: SeatingChartModel, options: ExportOptions = {}): Promise<Blob> {
  const { paper = "A4", orientation = "auto", bothViews = false } = options;
  await ensurePdfLib({ fontkit: true });
  const doc = await pdfLib().PDFDocument.create();
  doc.registerFontkit(fontkitLib());
  // 日本語フォントは、一部の文字が欠けないよう、サブセットにしない（帳票のPDFと同じ方針）
  const font = await doc.embedFont(await loadJapaneseFontBytes(), { subset: false });
  if (!bothViews) {
    const layout = composeViews(model, false);
    const { width, height } = layout;
    const [pageW, pageH] = pdfPageSize(paper, orientation, width, height);
    // 小さい用紙では余白も小さくする（B6・A6でも座席表を大きく入れる）
    const margin = Math.min(PDF_MARGIN, Math.min(pageW, pageH) * 0.05);
    const scale = Math.min((pageW - margin * 2) / width, (pageH - margin * 2) / height);
    const pg = doc.addPage([pageW, pageH]);
    const ox = (pageW - width * scale) / 2;
    paintViews(pdfPainter(pg, font, scale, ox, pageH, margin), layout);
  } else {
    const plan = bothViewsPagePlan(model, paper, orientation);
    const pg = doc.addPage([plan.pageW, plan.pageH]);
    paintViews(pdfPainter(pg, font, 1, 0, plan.pageH, 0), composeHalves(model, plan.pageW, plan.pageH, plan.stacked, plan.margin));
  }
  doc.setTitle(model.title.trim() || "座席表");
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

export async function exportChart(model: SeatingChartModel, format: ExportFormat, options: ExportOptions = {}): Promise<Blob> {
  if (format === "png" || format === "jpeg") return chartToImageBlob(model, format, 2, options.bothViews ?? false);
  return chartToPdfBlob(model, options);
}
