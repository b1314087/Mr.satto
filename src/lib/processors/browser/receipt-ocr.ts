import { getPositionedTextItems, loadPdfDocument, pageHasText, type PdfjsPage } from "@/lib/pdf/pdfjs-client";
import { OCR_MAX_PAGES } from "@/lib/pdf/page-limits";
import { recognizeImageWithWords, type OcrWord } from "@/lib/ocr/tesseract-client";
import { extractReceipt, hasAnyCandidate } from "@/lib/accounting/receipt-extract";
import { isTextLayerUsable, linesFromTextItems } from "@/lib/accounting/receipt-pdf-lines";
import { RECEIPT_LIMITS, type ReadMethod, type TextLine } from "@/lib/accounting/receipt-types";
import type { ReceiptFileKind } from "@/lib/accounting/receipt-file-kind";
import { OCR_MAX_LONG_SIDE, OCR_MAX_PIXELS, planOcr, planStrips } from "@/lib/accounting/receipt-image-plan";
import { canvasToBlob, loadImage } from "./image";

/**
 * 領収書・レシートの画像・PDFを読み取って、書類ごとの文字の行にする（工程8）。
 *
 * - 画像は、ブラウザ内のOCR（既存のTesseract.js）で読む。
 * - PDFは、ページごとに、文字情報があればそれを使い（OCRしない）、無い・使えないページだけ画像にしてOCRする。
 *   文字情報が使えそうに見えても、日付・金額の候補が全く無いページ（例：スキャン画像に透かし文字だけが載っている）は、
 *   OCRでも読んで、候補が得られるほうを使う。どちらの場合も、元の画像と並べて利用者が確認する。
 * - すべてブラウザの中で処理する。ファイルの内容・読み取った文字を通信やログに出さない。
 * - 書類（画像1枚・PDF1ページ）を1つ読み終えるたびに結果を渡し、画像（canvas）の参照を手放す。
 *   大量のページを同時にメモリに載せない。
 * - 例外には、ファイル名や書類の内容を含まない定型の日本語メッセージだけを使う。
 */

/** 利用者に見せてよい（ファイル名・書類の内容を含まない）読み取りエラー */
export class ReceiptReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptReadError";
  }
}

/** 読み取った1書類（画像1枚、またはPDFの1ページ） */
export interface ReadDocument {
  /** PDFのページ番号（1始まり）。画像は null */
  pageNumber: number | null;
  /** PDFの総ページ数。画像は null */
  pageCount: number | null;
  method: ReadMethod;
  lines: TextLine[];
  /** 元の書類の画像（確認画面で見せる）。画像はファイルそのもの、PDFはページを描画した画像 */
  preview: Blob;
}

export interface ReadProgress {
  /** 何書類目か（1始まり）と、全体（PDFは総ページ数、画像は1） */
  current: number;
  total: number;
  method: ReadMethod;
  /** その書類の中での進捗（0〜1） */
  fraction: number;
}

export interface ReadOptions {
  /** 書類を1つ読み終えるたびに呼ばれる */
  onDocument: (doc: ReadDocument) => void;
  onProgress?: (progress: ReadProgress) => void;
  /** true を返すと、次の書類に進む前に打ち切る */
  isCancelled?: () => boolean;
  /** まだ受け入れられる書類の数。0以下になったら、それ以降の書類は読まない */
  remainingSlots: () => number;
}

/** 確認用のプレビュー画像の長辺の上限(px) */
const PREVIEW_MAX_LONG_SIDE = 1600;
const OCR_LANGUAGE = "ja" as const;
/** 切り分ける位置を探す範囲（OCRに渡す画像でのpx） */
const STRIP_SEARCH_RADIUS = 250;
/** 切り分け位置を探すために、画像を縮小して調べるときの幅(px) */
const ACTIVITY_PROBE_WIDTH = 240;

/** OCRに渡す画像の倍率（小さい画像は最大2倍まで拡大、大きい画像は縮小）。詳細は receipt-image-plan.ts */
export function ocrScaleFor(width: number, height: number): number {
  return planOcr(width, height).scale;
}

/** OCRの単語を、行ごとの文字と信頼度（行の中で最も低い単語の値）にまとめる */
export function linesFromOcrWords(words: OcrWord[]): TextLine[] {
  const order: number[] = [];
  const byLine = new Map<number, OcrWord[]>();
  let looseIndex = -1;
  for (const w of words) {
    const key = w.lineIndex ?? looseIndex--;
    if (!byLine.has(key)) {
      byLine.set(key, []);
      order.push(key);
    }
    byLine.get(key)!.push(w);
  }
  return order.map((key) => {
    const lineWords = [...(byLine.get(key) ?? [])].sort((a, b) => a.x0 - b.x0);
    return {
      text: lineWords.map((w) => w.text).join(" "),
      confidence: Math.min(...lineWords.map((w) => w.confidence)),
    };
  });
}

async function ocrCanvas(canvas: HTMLCanvasElement, onFraction: (fraction: number) => void): Promise<TextLine[]> {
  try {
    const result = await recognizeImageWithWords(canvas, OCR_LANGUAGE, (p) => onFraction(p.progress));
    return linesFromOcrWords(result.words);
  } catch {
    throw new ReceiptReadError("文字の読み取りに失敗しました。別の画像でお試しください。");
  }
}

function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

async function readImageFile(file: File, options: ReadOptions): Promise<void> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    throw new ReceiptReadError("画像を読み込めませんでした。ファイルが壊れている可能性があります。");
  }
  const { naturalWidth: w, naturalHeight: h } = img;
  if (w === 0 || h === 0) throw new ReceiptReadError("画像を読み込めませんでした。ファイルが壊れている可能性があります。");
  if (w * h > RECEIPT_LIMITS.maxImagePixels) {
    throw new ReceiptReadError("画像の解像度が大きすぎます。画像を縮小してからお試しください。");
  }

  const plan = planOcr(w, h);
  const total = { current: 1, total: 1, method: "ocr" as const };
  if (plan.stripHeight !== null) {
    // 細長い画像：縮小すると文字が潰れるため、縦に切り分けて、倍率を保ったまま1本ずつ読む
    const strips = planStrips(h, Math.round(plan.stripHeight / plan.scale), probeRowActivity(img, w, h), Math.round(STRIP_SEARCH_RADIUS / plan.scale));
    const lines: TextLine[] = [];
    for (let i = 0; i < strips.length; i++) {
      if (options.isCancelled?.()) break;
      const strip = strips[i];
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * plan.scale));
      canvas.height = Math.max(1, Math.round(strip.height * plan.scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new ReceiptReadError("画像を処理できませんでした。");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, strip.top, w, strip.height, 0, 0, canvas.width, canvas.height);
      try {
        lines.push(...(await ocrCanvas(canvas, (fraction) => options.onProgress?.({ ...total, fraction: (i + fraction) / strips.length }))));
      } finally {
        releaseCanvas(canvas);
      }
    }
    options.onDocument({ pageNumber: null, pageCount: null, method: "ocr", lines, preview: file });
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * plan.scale));
  canvas.height = Math.max(1, Math.round(h * plan.scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ReceiptReadError("画像を処理できませんでした。");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    const lines = await ocrCanvas(canvas, (fraction) => options.onProgress?.({ ...total, fraction }));
    options.onDocument({ pageNumber: null, pageCount: null, method: "ocr", lines, preview: file });
  } finally {
    releaseCanvas(canvas);
  }
}

/** 画像を縮小し、行ごとの明るさのばらつき（文字がある行ほど大きい）を調べる。失敗したら null（等間隔で切る） */
function probeRowActivity(img: HTMLImageElement, w: number, h: number): number[] | null {
  try {
    const pw = Math.max(1, Math.min(w, ACTIVITY_PROBE_WIDTH));
    const ph = Math.max(1, Math.min(h, 6000));
    const probe = document.createElement("canvas");
    probe.width = pw;
    probe.height = ph;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pw, ph);
    ctx.drawImage(img, 0, 0, pw, ph);
    const data = ctx.getImageData(0, 0, pw, ph).data;
    const rows: number[] = [];
    for (let y = 0; y < ph; y++) {
      let sum = 0;
      let sumSq = 0;
      for (let x = 0; x < pw; x++) {
        const i = (y * pw + x) * 4;
        const v = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        sum += v;
        sumSq += v * v;
      }
      const mean = sum / pw;
      rows.push(Math.sqrt(Math.max(0, sumSq / pw - mean * mean)));
    }
    releaseCanvas(probe);
    return rows;
  } catch {
    return null;
  }
}

async function renderPage(page: PdfjsPage, wantedScale: number, longSideMax: number, pixelMax: number): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(
    wantedScale,
    longSideMax / Math.max(base.width, base.height),
    Math.sqrt(pixelMax / (base.width * base.height)),
  );
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new ReceiptReadError("PDFのページを画像にできませんでした。");
  // 背景が透明なPDFでも、文字が読めるよう白で塗る
  canvasContext.fillStyle = "#ffffff";
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext, viewport }).promise;
  return canvas;
}

async function readPdfFile(file: File, options: ReadOptions): Promise<void> {
  let pdf: Awaited<ReturnType<typeof loadPdfDocument>>;
  try {
    pdf = await loadPdfDocument(file);
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message.includes("パスワード")) {
      throw new ReceiptReadError("パスワード保護されたPDFは処理できません。パスワードを解除してから、もう一度お試しください。");
    }
    throw new ReceiptReadError("PDFを開けませんでした。ファイルが壊れている可能性があります。");
  }
  try {
    if (pdf.numPages === 0) throw new ReceiptReadError("このPDFにはページがありません。");
    if (pdf.numPages > OCR_MAX_PAGES) {
      throw new ReceiptReadError(`PDFは1つ${OCR_MAX_PAGES}ページまでです（このPDFは${pdf.numPages}ページあります）。ページを分けてからお試しください。`);
    }

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      if (options.isCancelled?.()) return;
      if (options.remainingSlots() <= 0) return;
      const progress = (method: ReadMethod, fraction: number) =>
        options.onProgress?.({ current: pageNumber, total: pdf.numPages, method, fraction });

      let page: PdfjsPage;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new ReceiptReadError(`${pageNumber}ページ目を読み込めませんでした。`);
      }

      const items = await getPositionedTextItems(page);
      const textLines = linesFromTextItems(items);
      const hasUsableText = pageHasText(items) && isTextLayerUsable(textLines);

      let method: ReadMethod = "text-layer";
      let lines = textLines;
      let canvas: HTMLCanvasElement | null = null;
      try {
        if (hasUsableText) {
          progress("text-layer", 1);
          // 文字情報から日付・金額の候補が全く得られないページは、画像を読み取った結果も試す
          if (!hasAnyCandidate(extractReceipt(textLines))) {
            canvas = await renderPage(page, 3, OCR_MAX_LONG_SIDE, OCR_MAX_PIXELS);
            const ocrLines = await ocrCanvas(canvas, (fraction) => progress("ocr", fraction));
            if (hasAnyCandidate(extractReceipt(ocrLines))) {
              method = "ocr";
              lines = ocrLines;
            }
          }
        } else {
          canvas = await renderPage(page, 3, OCR_MAX_LONG_SIDE, OCR_MAX_PIXELS);
          method = "ocr";
          lines = await ocrCanvas(canvas, (fraction) => progress("ocr", fraction));
        }

        // 確認用のプレビュー画像（OCRに使った画像があればそれを縮小して使い、なければ小さめに描画する）
        let previewCanvas: HTMLCanvasElement;
        if (canvas) {
          previewCanvas = canvas;
          if (Math.max(canvas.width, canvas.height) > PREVIEW_MAX_LONG_SIDE) {
            const ratio = PREVIEW_MAX_LONG_SIDE / Math.max(canvas.width, canvas.height);
            const small = document.createElement("canvas");
            small.width = Math.max(1, Math.round(canvas.width * ratio));
            small.height = Math.max(1, Math.round(canvas.height * ratio));
            small.getContext("2d")?.drawImage(canvas, 0, 0, small.width, small.height);
            previewCanvas = small;
          }
        } else {
          previewCanvas = await renderPage(page, 2, PREVIEW_MAX_LONG_SIDE, OCR_MAX_PIXELS);
        }
        let preview: Blob;
        try {
          preview = await canvasToBlob(previewCanvas, "image/jpeg", 0.85);
        } finally {
          if (previewCanvas !== canvas) releaseCanvas(previewCanvas);
        }
        options.onDocument({ pageNumber, pageCount: pdf.numPages, method, lines, preview });
      } finally {
        if (canvas) releaseCanvas(canvas);
      }
    }
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // 後始末の失敗は無視する
    }
  }
}

/**
 * 1つのファイルを読み取る。画像は1書類、PDFはページごとに1書類を、options.onDocument に渡す。
 * 失敗したときは ReceiptReadError（利用者に見せてよい定型の日本語）を投げる。それ以外の例外は、定型の文に置き換える。
 */
export async function readReceiptFile(file: File, kind: ReceiptFileKind, options: ReadOptions): Promise<void> {
  try {
    if (kind === "pdf") await readPdfFile(file, options);
    else await readImageFile(file, options);
  } catch (e) {
    if (e instanceof ReceiptReadError) throw e;
    throw new ReceiptReadError("このファイルを読み取れませんでした。別のファイルでお試しください。");
  }
}
