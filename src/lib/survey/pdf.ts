import type { PDFFont, PDFPage } from "pdf-lib";
import { ensurePdfLib, fontkitLib, pdfLib } from "@/lib/pdf/pdf-lib-loader";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { layoutSurvey, starPoints, type LaidOutSurvey, type Prim } from "./layout";
import type { Survey } from "./model";

/**
 * アンケート用紙の PDF（2026-11-17）。
 * 紙のプレビューと同じ配置（layoutSurvey）を、pdf-lib で描く。日本語は既存のツールと同じ Noto Sans JP を埋め込む。
 * 文字の幅は、埋め込むフォントで測り直してから配置する（はみ出し・重なりを防ぐ）。処理はすべてブラウザの中で行う。
 */

const PT_PER_MM = 72 / 25.4;

function hex(color: string) {
  const v = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? "000000";
  return pdfLib().rgb(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255);
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr === 0) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  return [
    `M ${x + rr} ${y}`,
    `H ${x + w - rr}`,
    `Q ${x + w} ${y} ${x + w} ${y + rr}`,
    `V ${y + h - rr}`,
    `Q ${x + w} ${y + h} ${x + w - rr} ${y + h}`,
    `H ${x + rr}`,
    `Q ${x} ${y + h} ${x} ${y + h - rr}`,
    `V ${y + rr}`,
    `Q ${x} ${y} ${x + rr} ${y}`,
    "Z",
  ].join(" ");
}

function drawPrim(page: PDFPage, font: PDFFont, heightMm: number, p: Prim) {
  const P = PT_PER_MM;
  const Y = (y: number) => (heightMm - y) * P;
  const topY = heightMm * P;
  switch (p.k) {
    case "text": {
      const w = font.widthOfTextAtSize(p.text, p.size);
      let x = p.x * P;
      if (p.anchor === "middle") x -= w / 2;
      if (p.anchor === "end") x -= w;
      page.drawText(p.text, { x, y: Y(p.y), size: p.size, font, color: hex(p.color) });
      // 太字：埋め込みフォントは1つの太さだけのため、少しずらして重ねて描く（画面のプレビューと同じ考え方）
      if (p.bold) page.drawText(p.text, { x: x + p.size * 0.035, y: Y(p.y), size: p.size, font, color: hex(p.color) });
      return;
    }
    case "line":
      page.drawLine({
        start: { x: p.x1 * P, y: Y(p.y1) },
        end: { x: p.x2 * P, y: Y(p.y2) },
        thickness: p.w * P,
        color: hex(p.color),
        dashArray: p.dash ? [1.6, 1.6] : undefined,
      });
      return;
    case "rect":
      page.drawSvgPath(roundedRectPath(p.x * P, p.y * P, p.w * P, p.h * P, (p.r ?? 0) * P), {
        x: 0,
        y: topY,
        color: p.fill ? hex(p.fill) : undefined,
        borderColor: p.stroke ? hex(p.stroke) : undefined,
        borderWidth: p.stroke ? (p.lw ?? 0.3) * P : 0,
      });
      return;
    case "circle":
      page.drawEllipse({ x: p.cx * P, y: Y(p.cy), xScale: p.r * P, yScale: p.r * P, borderColor: hex(p.stroke), borderWidth: p.lw * P });
      return;
    case "star": {
      const pts = starPoints(p.cx * P, p.cy * P, p.r * P);
      const d = `M ${pts.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
      page.drawSvgPath(d, { x: 0, y: topY, borderColor: hex(p.stroke), borderWidth: p.lw * P, borderLineCap: undefined });
      return;
    }
  }
}

export interface SurveyPdfResult {
  blob: Blob;
  pageCount: number;
  layout: LaidOutSurvey;
}

export async function buildSurveyPdf(survey: Survey): Promise<SurveyPdfResult> {
  await ensurePdfLib({ fontkit: true });
  let fontBytes: ArrayBuffer;
  try {
    fontBytes = await loadJapaneseFontBytes();
  } catch {
    throw new Error("日本語フォントを読み込めませんでした。通信状態を確かめて、もう一度お試しください。");
  }
  const { PDFDocument } = pdfLib();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkitLib());
  const font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
  const layout = layoutSurvey(survey, (text, size) => font.widthOfTextAtSize(text, size) / PT_PER_MM);
  for (const prims of layout.pages) {
    const page = doc.addPage([layout.width * PT_PER_MM, layout.height * PT_PER_MM]);
    for (const p of prims) drawPrim(page, font, layout.height, p);
  }
  doc.setTitle(survey.title.trim() || "アンケート");
  doc.setCreator("Mr.Satto アンケート用紙作成");
  const bytes = await doc.save();
  return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), pageCount: layout.pages.length, layout };
}
