import { BrowserProcessor, type NamedFileOutput } from "../types";
import { canvasToBlob } from "./image";
import { stripExtension } from "@/lib/utils/format";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";

/**
 * PDF→画像 Processor（Phase 2-A）。
 *
 * pdf.ts の他のPDF系Processorは pdf-lib（PDF生成・編集用）を使うが、
 * PDFページをラスタ画像として描画する処理はpdf-libの対象外のため、
 * レンダリング専用の pdfjs-dist（Mozilla PDF.js）を別途利用する。
 * 目的の異なるライブラリのため、既存の pdf.ts に混在させず
 * ファイルを分けている。
 *
 * レンダリングはCanvas 2D経由でブラウザ上で完結し、ファイルは
 * 外部に送信されない。
 *
 * pdfjs-dist の読み込み・PDF読み込み自体は、Phase 2-Dで
 * OCR/PDF→Excel/PDF→Wordと共通化するため src/lib/pdf/pdfjs-client.ts
 * へ移設した（ロジックは変更していない）。
 */

export interface PdfToImageInput {
  file: File;
  mimeType: "image/png" | "image/jpeg";
  /** 描画解像度の倍率。既定値2（画面表示の等倍PDF座標に対して2倍精細） */
  scale?: number;
}

export interface PdfToImageOutputItem extends NamedFileOutput {
  pageNumber: number;
  width: number;
  height: number;
}

export class PdfToImageProcessor extends BrowserProcessor<
  PdfToImageInput,
  PdfToImageOutputItem[]
> {
  async process({ file, mimeType, scale = 2 }: PdfToImageInput): Promise<PdfToImageOutputItem[]> {
    const pdf = await loadPdfDocument(file);

    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }

    const base = stripExtension(file.name);
    const pad = String(pdf.numPages).length;
    const ext = mimeType === "image/png" ? "png" : "jpg";
    const outputs: PdfToImageOutputItem[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("Canvasの初期化に失敗しました");

        await page.render({ canvasContext, viewport }).promise;
        const blob = await canvasToBlob(canvas, mimeType, 0.92);

        outputs.push({
          blob,
          suggestedName: `${base}-${String(pageNumber).padStart(pad, "0")}.${ext}`,
          sizeBytes: blob.size,
          pageNumber,
          width: canvas.width,
          height: canvas.height,
        });
      }
    } catch {
      throw new Error("PDFのページ画像化に失敗しました");
    }

    return outputs;
  }
}

// ---------------------------------------------------------------------------
// PDF → テキスト（Phase 2-B）
// ---------------------------------------------------------------------------
export interface PdfToTextInput {
  file: File;
}

export interface PdfToTextPage {
  pageNumber: number;
  text: string;
}

export interface PdfToTextOutput {
  pageCount: number;
  pages: PdfToTextPage[];
  /** "--- Page N ---" 区切りで連結した全文 */
  combinedText: string;
  /** 1文字も抽出できなかった場合はfalse（スキャン画像PDFの可能性） */
  hasExtractableText: boolean;
}

/**
 * PDF→テキスト Processor。
 *
 * pdfjs-dist の getTextContent() は「文字情報として埋め込まれた
 * テキスト」のみを取得できる。スキャン画像として保存されたPDF
 * （文字情報を持たないPDF）からはテキストを取得できないため、
 * その場合は例外にはせず hasExtractableText: false を返し、
 * UI側でその旨を案内する（OCRは今回のスコープ外）。
 */
export class PdfToTextProcessor extends BrowserProcessor<PdfToTextInput, PdfToTextOutput> {
  async process({ file }: PdfToTextInput): Promise<PdfToTextOutput> {
    const pdf = await loadPdfDocument(file);

    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }

    const pages: PdfToTextPage[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const textContent = await page.getTextContent();

        let raw = "";
        for (const item of textContent.items) {
          if ("str" in item) {
            raw += item.str;
            raw += item.hasEOL ? "\n" : " ";
          }
        }
        // 連続する空白・過剰な空行を整理して読みやすくする
        const text = raw
          .replace(/[ \t]+/g, " ")
          .replace(/ *\n */g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        pages.push({ pageNumber, text });
      }
    } catch {
      throw new Error("PDFからのテキスト抽出に失敗しました");
    }

    const hasExtractableText = pages.some((p) => p.text.length > 0);
    const combinedText = pages
      .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
      .join("\n\n");

    return { pageCount: pdf.numPages, pages, combinedText, hasExtractableText };
  }
}
