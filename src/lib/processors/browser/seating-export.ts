import type { PDFFont, PDFPage } from "pdf-lib";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { SEAT_H, SEAT_W, type LayoutGeometry } from "@/lib/seating/layouts";
import type { Participant } from "@/lib/seating/participants";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";

/**
 * 座席表の書き出し（画像 PNG・JPEG、PDF、Excel）。ブラウザ内だけで作る（名前は外部に送らない）。
 * 画像とPDFは、同じ描き方（paintChart）で描く。PDFは文字のまま（拡大しても粗くならず、文字を選べる）。
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
  /** ふりがなを付けるか（付けるときは、名前の上に小さく描き、Excelに「ふりがな」の列を足す） */
  furigana?: boolean;
  /** 空席にした席（だれも座らせない席。「空席」と描く。geometry.seats と同じ並び） */
  blocked?: boolean[];
}

export type PaperSize = "A4" | "B4" | "A3";
/** 用紙の長い辺・短い辺（pt） */
export const PAPER_PT: Record<PaperSize, [number, number]> = {
  A4: [841.89, 595.28],
  B4: [1031.81, 728.5],
  A3: [1190.55, 841.89],
};

export type ExportFormat = "png" | "jpeg" | "pdf" | "xlsx";

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
    const reading = model.furigana ? (person.reading ?? "").trim() : "";
    const cx = x + SEAT_W / 2;
    if (reading && person.role) {
      p.text(reading, cx, y + 17, { size: fitSize(p, reading, 9, maxW, false, 5), color: MUTED });
      p.text(person.name, cx, y + 32, { size: fitSize(p, person.name, 16, maxW, true, 7), color: INK, bold: true });
      p.text(person.role, cx, y + 49, { size: fitSize(p, person.role, 10, maxW, false, 6), color: MUTED });
    } else if (reading) {
      p.text(reading, cx, y + 20, { size: fitSize(p, reading, 10, maxW, false, 5), color: MUTED });
      p.text(person.name, cx, y + 38, { size: fitSize(p, person.name, 18, maxW, true, 7), color: INK, bold: true });
    } else if (person.role) {
      p.text(person.name, cx, y + 27, { size: fitSize(p, person.name, 17, maxW, true, 7), color: INK, bold: true });
      p.text(person.role, cx, y + 46, { size: fitSize(p, person.role, 11, maxW, false, 6), color: MUTED });
    } else {
      p.text(person.name, cx, y + SEAT_H / 2 + 3, { size: fitSize(p, person.name, 18, maxW, true, 7), color: INK, bold: true });
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

export async function chartToImageBlob(model: SeatingChartModel, format: "png" | "jpeg", scale = 2): Promise<Blob> {
  const { width, height } = chartSize(model);
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
  paintChart(canvasPainter(ctx), model);
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

export async function chartToPdfBlob(model: SeatingChartModel, paper: PaperSize = "A4"): Promise<Blob> {
  await ensurePdfLib({ fontkit: true });
  const doc = await pdfLib().PDFDocument.create();
  doc.registerFontkit(fontkitLib());
  // 日本語フォントは、一部の文字が欠けないよう、サブセットにしない（帳票のPDFと同じ方針）
  const font = await doc.embedFont(await loadJapaneseFontBytes(), { subset: false });
  const { width, height } = chartSize(model);
  const landscape = width >= height;
  const [long, short] = PAPER_PT[paper];
  const pageW = landscape ? long : short;
  const pageH = landscape ? short : long;
  const scale = Math.min((pageW - PDF_MARGIN * 2) / width, (pageH - PDF_MARGIN * 2) / height);
  const page = doc.addPage([pageW, pageH]);
  const ox = (pageW - width * scale) / 2;
  const oy = PDF_MARGIN;
  paintChart(pdfPainter(page, font, scale, ox, pageH, oy), model);
  doc.setTitle(model.title.trim() || "座席表");
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

// ---------------------------------------------------------------------------
// Excel（席の一覧）
// ---------------------------------------------------------------------------

export function seatingListRows(model: SeatingChartModel): (string | number)[][] {
  const kana = !!model.furigana;
  const reading = (p: Participant | null) => (p?.reading ?? "").trim();
  const rows: (string | number)[][] = [kana ? ["席番号", "名前", "ふりがな", "役職", "場所", "札"] : ["席番号", "名前", "役職", "場所", "札"]];
  model.geometry.seats.forEach((seat, i) => {
    const p = model.assignment[i];
    const tag = (model.tags?.[i] ?? "").trim();
    const name = p ? p.name : "（空席）";
    rows.push(kana ? [i + 1, name, reading(p), p ? p.role : "", seat.group, tag] : [i + 1, name, p ? p.role : "", seat.group, tag]);
  });
  for (const p of model.unseated) rows.push(kana ? ["（席なし）", p.name, reading(p), p.role, "", ""] : ["（席なし）", p.name, p.role, "", ""]);
  return rows;
}

export async function chartToXlsxBlob(model: SeatingChartModel): Promise<Blob> {
  const rows = seatingListRows(model);
  const columns = model.furigana
    ? [{ width: 10 }, { width: 24 }, { width: 24 }, { width: 18 }, { width: 28 }, { width: 12 }]
    : [{ width: 10 }, { width: 24 }, { width: 18 }, { width: 28 }, { width: 12 }];
  return writeXlsxSheets([{ name: "座席表", rows: [[model.title.trim() || "座席表"], [], ...rows], columns }]);
}

export async function exportChart(model: SeatingChartModel, format: ExportFormat, paper: PaperSize = "A4"): Promise<Blob> {
  if (format === "png" || format === "jpeg") return chartToImageBlob(model, format);
  if (format === "pdf") return chartToPdfBlob(model, paper);
  return chartToXlsxBlob(model);
}
