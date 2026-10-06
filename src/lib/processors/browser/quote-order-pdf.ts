import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import type { DocumentFormState } from "@/lib/documents/types";
import { validateDocumentForm } from "@/lib/documents/validation";
import { layoutQuoteOrder, overflowMessage, PAGE_H, PAGE_W, type QuoteOrderExtra } from "@/lib/documents/quote-order-layout";
import { sanitizeFileName } from "@/lib/utils/format";

/**
 * 見積書・注文書一体型PDF(A4・1枚。上半分が見積書、下半分が注文書)。
 * 配置はquote-order-layout.tsが計算し、ここでは図形をpdf-libで描くだけ。
 * 日本語フォントは subset:false で埋め込む(document-pdf.ts冒頭の注意と同じ理由)。
 */
export interface QuoteOrderPdfInput {
  form: DocumentFormState;
  extra: QuoteOrderExtra;
}

export interface QuoteOrderPdfOutput {
  blob: Blob;
  url: string;
  sizeBytes: number;
}

export function buildQuoteOrderFileName(form: DocumentFormState): string {
  const date = form.issueDate || new Date().toISOString().slice(0, 10);
  return sanitizeFileName(`見積書・注文書_${date}.pdf`);
}

export class QuoteOrderPdfProcessor extends BrowserProcessor<QuoteOrderPdfInput, QuoteOrderPdfOutput> {
  async process({ form, extra }: QuoteOrderPdfInput): Promise<QuoteOrderPdfOutput> {
    const validationError = validateDocumentForm(form);
    if (validationError) throw new Error(validationError);

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }

    let doc: PDFDocument;
    let font: PDFFont;
    try {
      doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    const layout = layoutQuoteOrder(form, extra, (t, size) => font.widthOfTextAtSize(t, size));
    const tooMany = overflowMessage(layout);
    if (tooMany) throw new Error(tooMany);

    const page = doc.addPage([PAGE_W, PAGE_H]);
    for (const op of layout.ops) {
      if (op.kind === "rect") {
        page.drawRectangle({
          x: op.x,
          y: PAGE_H - op.y - op.h,
          width: op.w,
          height: op.h,
          color: op.fill ? rgb(...op.fill) : undefined,
          borderColor: op.stroke ? rgb(...op.stroke) : undefined,
          borderWidth: op.stroke ? 0.75 : 0,
        });
      } else if (op.kind === "line") {
        page.drawLine({
          start: { x: op.x1, y: PAGE_H - op.y1 },
          end: { x: op.x2, y: PAGE_H - op.y2 },
          thickness: 0.75,
          color: rgb(...op.color),
          dashArray: op.dashed ? [4, 3] : undefined,
        });
      } else {
        const w = font.widthOfTextAtSize(op.text, op.size);
        const x = op.align === "right" ? op.x - w : op.align === "center" ? op.x - w / 2 : op.x;
        page.drawText(op.text, { x, y: PAGE_H - op.y, size: op.size, font, color: rgb(...op.color) });
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの生成に失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return { blob, url: URL.createObjectURL(blob), sizeBytes: blob.size };
  }
}
