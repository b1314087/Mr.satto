/**
 * ページ番号・透かしのプレビュー用フォント。
 * 実際の出力(lib/processors/browser/pdf.ts)と同じpdf-libのフォントで文字の幅を測り、
 * 画面表示用に同じフォントファイルをブラウザへ登録する(ブラウザ内で完結)。
 */
import type { PDFFont } from "pdf-lib";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";

let helveticaPromise: Promise<PDFFont> | null = null;

/** ページ番号と同じ標準フォント(Helvetica)。文字幅の測定用 */
export function getHelveticaFont(): Promise<PDFFont> {
  if (!helveticaPromise) {
    // PDFを作る部品は、ここで初めて読み込む（ロードマップC 工程2）
    helveticaPromise = ensurePdfLib()
      .then(() => pdfLib().PDFDocument.create())
      .then((doc) => doc.embedFont(pdfLib().StandardFonts.Helvetica))
      .catch((e) => {
        helveticaPromise = null;
        throw e;
      });
  }
  return helveticaPromise;
}

/** プレビュー表示に使うCSSのfont-family名(透かしと同じNoto Sans JP) */
export const WATERMARK_PREVIEW_FONT_FAMILY = "PdfWatermarkPreviewNotoSansJP";

let watermarkFontPromise: Promise<PDFFont> | null = null;

/** 透かしと同じ日本語フォント。文字幅の測定に使い、同時に画面表示用のフォントも登録する */
export function getWatermarkFont(): Promise<PDFFont> {
  if (!watermarkFontPromise) {
    watermarkFontPromise = (async () => {
      await ensurePdfLib({ fontkit: true });
      const bytes = await loadJapaneseFontBytes();
      const face = new FontFace(WATERMARK_PREVIEW_FONT_FAMILY, new Uint8Array(bytes));
      await face.load();
      document.fonts.add(face);
      const doc = await pdfLib().PDFDocument.create();
      doc.registerFontkit(fontkitLib());
      return doc.embedFont(new Uint8Array(bytes), { subset: false });
    })().catch((e) => {
      watermarkFontPromise = null;
      throw e;
    });
  }
  return watermarkFontPromise;
}
