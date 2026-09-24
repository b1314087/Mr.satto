import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems, pageHasText } from "@/lib/pdf/pdfjs-client";
import { recognizeImage, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { loadImage } from "./image";

/**
 * OCR Processor（Phase 2-D）。
 *
 * 入力は「画像（JPG/PNG/WebP）」または「PDF」。
 * PDFの場合、ページ単位で「既に文字情報を持つページ（pdfjsのテキストレイヤーで
 * 抽出できる）」と「文字情報を持たないページ（スキャン画像等）」を判定し、
 * 前者はOCRを行わずそのままテキストを使い、後者だけを画像化してOCRする
 * （開発指示書■20: 既存のPDF→テキストと役割を重複させないための判定）。
 *
 * 大きなPDFを一度に全ページメモリへ乗せることは避け、1ページずつ
 * 「画像化 → OCR → 結果を確定 → 次のページ」という順序で処理する。
 * ページ数の上限・OCR時の描画解像度上限は、スマートフォンでの
 * メモリ使用量とbrowser内WASM実行の現実的な処理時間を踏まえて設定している
 * （数百ページのPDFをそのまま許可すると、ブラウザタブがクラッシュしうるため）。
 */

const MAX_OCR_PAGES = 20;
/** OCR用に描画・縮小する画像の最長辺の上限(px)。過度に大きい画像でのメモリ超過を防ぐ */
const MAX_OCR_DIMENSION = 2000;
const PDF_RENDER_SCALE = 2;

const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const SUPPORTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isSupportedImageFile(file: File): boolean {
  if (SUPPORTED_IMAGE_MIME_TYPES.includes(file.type)) return true;
  const name = file.name.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/** 画像が大きすぎる場合はOCR前に縮小する（メモリ・スマートフォン性能への配慮） */
async function downscaleForOcr(source: File | Blob): Promise<HTMLCanvasElement> {
  const img = await loadImage(source);
  const { naturalWidth: w, naturalHeight: h } = img;
  if (w === 0 || h === 0) {
    throw new Error("画像を読み込めませんでした。ファイルが破損している可能性があります。");
  }
  const longest = Math.max(w, h);
  const scale = longest > MAX_OCR_DIMENSION ? MAX_OCR_DIMENSION / longest : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export type OcrPageMethod = "text-layer" | "ocr";

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  method: OcrPageMethod;
  /** OCRを実施したページのみ0〜100。テキストレイヤー抽出のページはnull */
  confidence: number | null;
}

export interface OcrPageProgressInfo {
  currentPage: number;
  totalPages: number;
  method: OcrPageMethod;
  /** そのページ内での進捗(0〜1)。テキストレイヤー抽出は即座に1になる */
  pageProgress: number;
}

export interface OcrInput {
  file: File;
  language: OcrLanguageOption;
  onPageProgress?: (info: OcrPageProgressInfo) => void;
  /** trueを返すと、次のページに進む前に処理を打ち切る（ベストエフォートのキャンセル） */
  isCancelled?: () => boolean;
}

export interface OcrOutput {
  pages: OcrPageResult[];
  combinedText: string;
  /** 画像1枚を処理した場合はtrue（"ページ"という概念がないため） */
  isSingleImage: boolean;
  cancelled: boolean;
}

function formatPageText(p: OcrPageResult): string {
  const methodLabel = p.method === "ocr" ? "OCR" : "テキスト抽出";
  return `--- Page ${p.pageNumber} (${methodLabel}) ---\n${p.text}`;
}

export class OcrProcessor extends BrowserProcessor<OcrInput, OcrOutput> {
  async process({ file, language, onPageProgress, isCancelled }: OcrInput): Promise<OcrOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    if (isSupportedImageFile(file)) {
      let canvas: HTMLCanvasElement;
      try {
        canvas = await downscaleForOcr(file);
      } catch {
        throw new Error("画像を読み込めませんでした。ファイルが破損している可能性があります。");
      }

      const { text, confidence } = await recognizeImage(canvas, language, (p) => {
        onPageProgress?.({ currentPage: 1, totalPages: 1, method: "ocr", pageProgress: p.progress });
      });

      const trimmed = text.trim();
      return {
        pages: [{ pageNumber: 1, text: trimmed, method: "ocr", confidence }],
        combinedText: trimmed,
        isSingleImage: true,
        cancelled: false,
      };
    }

    if (!isPdfFile(file)) {
      throw new Error(
        "対応していないファイル形式です。JPG・PNG・WebP画像、またはPDFファイルを選択してください。"
      );
    }

    const pdf = await loadPdfDocument(file);
    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    if (pdf.numPages > MAX_OCR_PAGES) {
      throw new Error(
        `OCRで処理できるページ数の上限は${MAX_OCR_PAGES}ページです（このPDFは${pdf.numPages}ページあります）。ページ数を減らしてから再度お試しください。`
      );
    }

    const pages: OcrPageResult[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (isCancelled?.()) {
        return {
          pages,
          combinedText: pages.map(formatPageText).join("\n\n"),
          isSingleImage: false,
          cancelled: true,
        };
      }

      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
      }

      const items = await getPositionedTextItems(page);

      if (pageHasText(items)) {
        // 既に文字情報を持つページはOCR不要（PDF→テキストと同じ抽出方式を使う）
        const text = items
          .map((i) => i.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        pages.push({ pageNumber, text, method: "text-layer", confidence: null });
        onPageProgress?.({
          currentPage: pageNumber,
          totalPages: pdf.numPages,
          method: "text-layer",
          pageProgress: 1,
        });
        continue;
      }

      // 文字情報を持たないページ（スキャン画像等）はページ全体を画像化してOCRする。
      // 全ページ分の画像を同時に保持せず、1ページ処理するごとにcanvasの参照を手放す。
      let canvas: HTMLCanvasElement;
      try {
        const baseViewport = page.getViewport({ scale: PDF_RENDER_SCALE });
        const longest = Math.max(baseViewport.width, baseViewport.height);
        const renderScale =
          longest > MAX_OCR_DIMENSION
            ? PDF_RENDER_SCALE * (MAX_OCR_DIMENSION / longest)
            : PDF_RENDER_SCALE;
        const viewport = page.getViewport({ scale: renderScale });
        canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const canvasContext = canvas.getContext("2d");
        if (!canvasContext) throw new Error("Canvasの初期化に失敗しました");
        await page.render({ canvasContext, viewport }).promise;
      } catch {
        throw new Error(`${pageNumber}ページ目の画像化に失敗しました`);
      }

      const { text, confidence } = await recognizeImage(canvas, language, (p) => {
        onPageProgress?.({
          currentPage: pageNumber,
          totalPages: pdf.numPages,
          method: "ocr",
          pageProgress: p.progress,
        });
      });
      pages.push({ pageNumber, text: text.trim(), method: "ocr", confidence });
    }

    return {
      pages,
      combinedText: pages.map(formatPageText).join("\n\n"),
      isSingleImage: false,
      cancelled: false,
    };
  }
}
