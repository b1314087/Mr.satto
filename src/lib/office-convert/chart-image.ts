import { drawChart, type ChartRangeResolver, type ChartTextApi } from "@/lib/excel/chart-render";
import type { ChartModel } from "@/lib/excel/ooxml-charts";
import { ensurePdfLib, fontkitLib, pdfLib } from "@/lib/pdf/pdf-lib-loader";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { closePdfDocument, loadPdfDocument, renderPageToCanvas } from "@/lib/pdf/pdfjs-client";
import { canvasToBlob } from "@/lib/processors/browser/image";

/**
 * Excelのグラフを画像（PNG）にする（Excel→Word変換で、グラフをWordに入れるため）。
 *
 * 描画は、Excel→PDF変換と同じグラフの描き方（src/lib/excel/chart-render.ts）を使う：
 * 1つのPDF（グラフ1つにつき1ページ）にグラフを描き、そのページを画像にする。すべてブラウザの中で行う。
 */
export interface ChartImageRequest {
  model: ChartModel;
  widthPt: number;
  heightPt: number;
  resolve: ChartRangeResolver;
}

/** 画像の解像度（pt あたりの画素。2 = 144dpi） */
const PIXELS_PER_PT = 2;

export async function renderChartsToPng(requests: ChartImageRequest[]): Promise<(Uint8Array | null)[]> {
  if (requests.length === 0) return [];
  await ensurePdfLib({ fontkit: true });
  const lib = pdfLib();
  const doc = await lib.PDFDocument.create();
  doc.registerFontkit(fontkitLib());
  // 部分的な埋め込み（subset）にすると、日本語の文字が描かれないことがあるため、Excel→PDFと同じく全体を埋め込む（画像にしたあとは捨てる）
  const font = await doc.embedFont(new Uint8Array(await loadJapaneseFontBytes()), { subset: false });
  const safe = (text: string) => {
    // フォントに無い文字は「?」にする（グラフ全体を描けなくしない）
    try {
      font.encodeText(text);
      return text;
    } catch {
      return Array.from(text)
        .map((ch) => {
          try {
            font.encodeText(ch);
            return ch;
          } catch {
            return "?";
          }
        })
        .join("");
    }
  };
  const text: ChartTextApi = {
    width: (str, size) => font.widthOfTextAtSize(safe(str), size),
    draw: (page, str, x, y, size, color, _bold, angleDeg = 0) => {
      const h = color.replace("#", "");
      page.drawText(safe(str), {
        x,
        y,
        size,
        font,
        color: lib.rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255),
        rotate: lib.degrees(angleDeg),
      });
    },
  };
  const drawn: boolean[] = [];
  for (const req of requests) {
    const page = doc.addPage([Math.max(10, req.widthPt), Math.max(10, req.heightPt)]);
    try {
      page.drawRectangle({ x: 0, y: 0, width: req.widthPt, height: req.heightPt, color: lib.rgb(1, 1, 1) });
      drawChart(req.model, { page, lib, box: { x: 0, y: 0, w: req.widthPt, h: req.heightPt }, scale: 1, text, resolve: req.resolve, blackAndWhite: false });
      drawn.push(true);
    } catch {
      drawn.push(false);
    }
  }
  const bytes = await doc.save();
  const pdf = await loadPdfDocument(new File([bytes as BlobPart], "charts.pdf", { type: "application/pdf" }));
  const out: (Uint8Array | null)[] = [];
  try {
    for (let i = 0; i < requests.length; i++) {
      if (!drawn[i]) {
        out.push(null);
        continue;
      }
      try {
        const page = await pdf.getPage(i + 1);
        const { canvas } = await renderPageToCanvas(page, PIXELS_PER_PT, 4000);
        const blob = await canvasToBlob(canvas, "image/png");
        out.push(new Uint8Array(await blob.arrayBuffer()));
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        out.push(null);
      }
    }
  } finally {
    await closePdfDocument(pdf);
  }
  return out;
}
