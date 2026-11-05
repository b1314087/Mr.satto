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
    const label = seatLabel(model, person);
    const reading = model.furigana ? (person.reading ?? "").trim() : "";
    const cx = x + SEAT_W / 2;
    if (reading && person.role) {
      p.text(reading, cx, y + 17, { size: fitSize(p, reading, 9, maxW, false, 5), color: MUTED });
      p.text(label, cx, y + 32, { size: fitSize(p, label, 16, maxW, true, 7), color: INK, bold: true });
      p.text(person.role, cx, y + 49, { size: fitSize(p, person.role, 10, maxW, false, 6), color: MUTED });
    } else if (reading) {
      p.text(reading, cx, y + 20, { size: fitSize(p, reading, 10, maxW, false, 5), color: MUTED });
      p.text(label, cx, y + 38, { size: fitSize(p, label, 18, maxW, true, 7), color: INK, bold: true });
    } else if (person.role) {
      p.text(label, cx, y + 27, { size: fitSize(p, label, 17, maxW, true, 7), color: INK, bold: true });
      p.text(person.role, cx, y + 46, { size: fitSize(p, person.role, 11, maxW, false, 6), color: MUTED });
    } else {
      p.text(label, cx, y + SEAT_H / 2 + 3, { size: fitSize(p, label, 18, maxW, true, 7), color: INK, bold: true });
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
// 前後を1ページに（2つの向きを並べる）
// ---------------------------------------------------------------------------

const CAPTION_H = 30;
const VIEW_GAP = 36;

interface PlacedView {
  model: SeatingChartModel;
  caption: string | null;
  dx: number;
  dy: number;
}

/** 前の印（教卓・スクリーンなど）が、座席表の上半分にあるか（印が無ければ null） */
function frontIsUp(g: LayoutGeometry): boolean | null {
  if (g.marks.length === 0) return null;
  const m = g.marks[0];
  return m.y + 15 < g.height / 2;
}

/** 書き出す絵の並べ方（1つ、または2つの向き）と、全体の大きさ */
export function composeViews(model: SeatingChartModel, bothViews: boolean): { views: PlacedView[]; width: number; height: number } {
  const size = chartSize(model);
  if (!bothViews) return { views: [{ model, caption: null, dx: 0, dy: 0 }], ...size };
  const other: SeatingChartModel = { ...model, geometry: rotateLayout(model.geometry) };
  const up = frontIsUp(model.geometry);
  const cap = (isUp: boolean | null, fallback: string) => (isUp === null ? fallback : isUp ? "前が上の向き" : "前が下の向き");
  const first = cap(up, "そのままの向き");
  const second = cap(up === null ? null : !up, "上下を逆にした向き");
  // 横長の座席表は上下に、縦長の座席表は左右に並べる（用紙に大きく入るように）
  const stacked = size.width >= size.height;
  const blockW = size.width;
  const blockH = size.height + CAPTION_H;
  const views: PlacedView[] = [
    { model, caption: first, dx: 0, dy: 0 },
    { model: other, caption: second, dx: stacked ? 0 : blockW + VIEW_GAP, dy: stacked ? blockH + VIEW_GAP : 0 },
  ];
  return {
    views,
    width: stacked ? blockW : blockW * 2 + VIEW_GAP,
    height: stacked ? blockH * 2 + VIEW_GAP : blockH,
  };
}

/** 描く位置をずらす */
function offsetPainter(p: Painter, dx: number, dy: number): Painter {
  return {
    rect: (x, y, w, h, fill, stroke, lw) => p.rect(x + dx, y + dy, w, h, fill, stroke, lw),
    circle: (cx, cy, r, fill, stroke) => p.circle(cx + dx, cy + dy, r, fill, stroke),
    text: (t, x, y, o) => p.text(t, x + dx, y + dy, o),
    measure: (t, size, bold) => p.measure(t, size, bold),
  };
}

function paintViews(p: Painter, layout: ReturnType<typeof composeViews>) {
  for (const v of layout.views) {
    if (v.caption) {
      p.rect(v.dx, v.dy + 2, chartSize(v.model).width, CAPTION_H - 6, [0.93, 0.95, 0.98], null);
      p.text(v.caption, v.dx + 12, v.dy + 2 + (CAPTION_H - 6) / 2, { size: 14, color: INK, bold: true, align: "left" });
    }
    paintChart(offsetPainter(p, v.dx, v.dy + (v.caption ? CAPTION_H : 0)), v.model);
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

export async function chartToPdfBlob(model: SeatingChartModel, options: ExportOptions = {}): Promise<Blob> {
  const { paper = "A4", orientation = "auto", bothViews = false } = options;
  await ensurePdfLib({ fontkit: true });
  const doc = await pdfLib().PDFDocument.create();
  doc.registerFontkit(fontkitLib());
  // 日本語フォントは、一部の文字が欠けないよう、サブセットにしない（帳票のPDFと同じ方針）
  const font = await doc.embedFont(await loadJapaneseFontBytes(), { subset: false });
  const layout = composeViews(model, bothViews);
  const { width, height } = layout;
  const [pageW, pageH] = pdfPageSize(paper, orientation, width, height);
  // 小さい用紙では余白も小さくする（B6・A6でも座席表を大きく入れる）
  const margin = Math.min(PDF_MARGIN, Math.min(pageW, pageH) * 0.05);
  const scale = Math.min((pageW - margin * 2) / width, (pageH - margin * 2) / height);
  const page = doc.addPage([pageW, pageH]);
  const ox = (pageW - width * scale) / 2;
  const oy = margin;
  paintViews(pdfPainter(page, font, scale, ox, pageH, oy), layout);
  doc.setTitle(model.title.trim() || "座席表");
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

export async function exportChart(model: SeatingChartModel, format: ExportFormat, options: ExportOptions = {}): Promise<Blob> {
  if (format === "png" || format === "jpeg") return chartToImageBlob(model, format, 2, options.bothViews ?? false);
  return chartToPdfBlob(model, options);
}
