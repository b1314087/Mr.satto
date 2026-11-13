import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems, pageHasText, closePdfDocument, type PdfjsPage } from "@/lib/pdf/pdfjs-client";
import { pageTextFromItems } from "@/lib/pdf/page-text";
import { getPageImageBoxes, type PageImageBox } from "@/lib/pdf/pdf-style-sampling";
import { recognizeImage, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { loadImage } from "./image";
import { OCR_MAX_PAGES } from "@/lib/pdf/page-limits";

/**
 * PDF・画像の文字抽出（OCR対応）Processor（Phase 2-D のOCRを、工程4でPDF→テキストと統合）。
 *
 * 工程4で追加したこと:
 * - 文字情報のあるページは、改行・段落を残して取り出す（src/lib/pdf/page-text.ts。PDF→テキストと同じ）。
 * - 文字情報があり、さらに文字を含みうる画像も置かれたページ（文字と画像の混在）は、文字情報を取り出したうえで、
 *   画像の部分だけを切り出してOCRし、その結果を「画像の中の文字」として後ろに添える（文字情報の部分は読み直さない）。
 * - ページ番号だけ等のわずかな文字情報しかなく、ページの大部分が画像のページは、スキャンしたページとしてOCRする。
 * - ocrAllowed:false（OCRを使えないプラン）のときは、文字情報のあるページだけを取り出し、OCRが必要なページは
 *   「未読み取り」として返す（文字情報の抽出は、だれでもこれまでどおり使える）。
 *
 * 以下は Phase 2-D からの説明。
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

const MAX_OCR_PAGES = OCR_MAX_PAGES;
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

export type OcrPageMethod =
  /** 文字情報（テキストレイヤー）から取り出した */
  | "text-layer"
  /** ページ全体を画像にしてOCRした */
  | "ocr"
  /** 文字情報から取り出し、さらにページ内の画像の部分をOCRした */
  | "mixed"
  /** OCRが必要だが、OCRを使わない設定のため読み取っていない */
  | "needs-ocr";

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  method: OcrPageMethod;
  /** OCRを実施したページ（ocr・mixed）のみ0〜100。テキストレイヤー抽出のページはnull */
  confidence: number | null;
  /** mixed のとき：文字情報から取り出した部分と、画像の中から読み取った部分 */
  layerText?: string;
  imageText?: string;
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
  /** OCRを使ってよいか（省略時は true）。false のとき、OCRが必要なページは読み取らずに "needs-ocr" とする */
  ocrAllowed?: boolean;
  /**
   * OCRで読み取るページ数の上限（料金プランによって変わる。省略時は OCR_MAX_PAGES）。
   * 超えた分のOCRが必要なページは、読み取らずに "needs-ocr" とする（文字情報のあるページは上限に数えない）。
   */
  maxOcrPages?: number;
}

export interface OcrOutput {
  pages: OcrPageResult[];
  combinedText: string;
  /** 画像1枚を処理した場合はtrue（"ページ"という概念がないため） */
  isSingleImage: boolean;
  cancelled: boolean;
  /** OCRが必要だったのに、読み取らなかったページがあるか（ocrAllowed:false のとき） */
  hasUnreadPages: boolean;
}

/** ページの区切りの見出しにつける、読み取り方の名前 */
export const OCR_METHOD_LABELS: Record<OcrPageMethod, string> = {
  "text-layer": "テキスト抽出",
  ocr: "OCR",
  mixed: "テキスト抽出＋画像OCR",
  "needs-ocr": "未読み取り（OCRが必要）",
};

/** ダウンロードするテキストの、ページの区切り（ページ番号と読み取り方） */
export function formatPageText(p: OcrPageResult): string {
  return `--- ${p.pageNumber}ページ（${OCR_METHOD_LABELS[p.method]}） ---\n${p.text}`;
}

export function combinePages(pages: readonly OcrPageResult[]): string {
  return pages.map(formatPageText).join("\n\n");
}

/**
 * 文字と画像の混在の判定に使う値。
 * - 画像の部分をOCRするのは、ある程度の大きさの画像だけ（小さなロゴ・アイコン・罫線の画像は読まない）
 * - ページの大部分を画像が覆い、文字情報がわずかなページは、スキャンしたページとしてページ全体をOCRする
 */
export const MIXED_PAGE_RULES = {
  /** OCRする画像の最小の幅・高さ(pt) */
  minImageSidePt: 40,
  /** OCRする画像の最小の面積(ページの面積に対する割合) */
  minImageAreaRatio: 0.03,
  /** 1ページでOCRする画像の数の上限 */
  maxImagesPerPage: 6,
  /** これ以上の割合を1つの画像が覆うページは「スキャンしたページ」とみなせる */
  scanCoverageRatio: 0.6,
  /** スキャンしたページとみなすときの、文字情報の文字数の上限 */
  scanMaxLayerChars: 40,
} as const;

export interface PageClassification {
  kind: "text-layer" | "ocr" | "mixed";
  /** mixed のとき、OCRする画像の範囲（PDFのページ座標） */
  regions: PageImageBox[];
}

/**
 * 1ページの読み取り方を決める（テスト用に、PDFを使わない純粋な関数にしている）。
 * layerChars は文字情報の文字数（空白を除く）、boxes は画像の範囲、page はページの大きさ(pt)
 */
export function classifyPage(
  layerChars: number,
  boxes: readonly PageImageBox[],
  page: { x0: number; y0: number; width: number; height: number }
): PageClassification {
  const area = Math.max(1, page.width * page.height);
  // ページからはみ出した部分は数えない
  const clipped = boxes
    .map((b) => ({
      x0: Math.max(b.x0, page.x0),
      y0: Math.max(b.y0, page.y0),
      x1: Math.min(b.x1, page.x0 + page.width),
      y1: Math.min(b.y1, page.y0 + page.height),
    }))
    .filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
  if (layerChars === 0) return { kind: "ocr", regions: [] };
  const maxCoverage = clipped.reduce((m, b) => Math.max(m, ((b.x1 - b.x0) * (b.y1 - b.y0)) / area), 0);
  if (maxCoverage >= MIXED_PAGE_RULES.scanCoverageRatio && layerChars <= MIXED_PAGE_RULES.scanMaxLayerChars) {
    return { kind: "ocr", regions: [] };
  }
  const seen = new Set<string>();
  const regions = clipped
    .filter((b) => {
      const w = b.x1 - b.x0;
      const h = b.y1 - b.y0;
      if (w < MIXED_PAGE_RULES.minImageSidePt || h < MIXED_PAGE_RULES.minImageSidePt) return false;
      if ((w * h) / area < MIXED_PAGE_RULES.minImageAreaRatio) return false;
      const key = [b.x0, b.y0, b.x1, b.y1].map((v) => Math.round(v)).join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // 上から下、左から右の順に読む
    .sort((a, b) => b.y1 - a.y1 || a.x0 - b.x0)
    .slice(0, MIXED_PAGE_RULES.maxImagesPerPage);
  return regions.length > 0 ? { kind: "mixed", regions } : { kind: "text-layer", regions: [] };
}

/** ページを、OCR用の大きさの画像にする */
async function renderPageForOcr(page: PdfjsPage): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const baseViewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const longest = Math.max(baseViewport.width, baseViewport.height);
  const scale = longest > MAX_OCR_DIMENSION ? PDF_RENDER_SCALE * (MAX_OCR_DIMENSION / longest) : PDF_RENDER_SCALE;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const canvasContext = canvas.getContext("2d");
  if (!canvasContext) throw new Error("Canvasの初期化に失敗しました");
  // 透明な部分は白にする（OCRの読み取りを安定させる）
  canvasContext.fillStyle = "#ffffff";
  canvasContext.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext, viewport }).promise;
  return { canvas, scale };
}

/** ページの画像から、画像の範囲（PDFのページ座標）を切り出す。ページの回転も反映する */
function cropRegion(page: PdfjsPage, rendered: { canvas: HTMLCanvasElement; scale: number }, b: PageImageBox): HTMLCanvasElement | null {
  const viewport = page.getViewport({ scale: rendered.scale });
  const pts = [
    viewport.convertToViewportPoint(b.x0, b.y0),
    viewport.convertToViewportPoint(b.x1, b.y0),
    viewport.convertToViewportPoint(b.x0, b.y1),
    viewport.convertToViewportPoint(b.x1, b.y1),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const sx = Math.max(0, Math.floor(Math.min(...xs)));
  const sy = Math.max(0, Math.floor(Math.min(...ys)));
  const sw = Math.min(rendered.canvas.width - sx, Math.ceil(Math.max(...xs) - sx));
  const sh = Math.min(rendered.canvas.height - sy, Math.ceil(Math.max(...ys) - sy));
  if (sw < 16 || sh < 16) return null;
  const crop = document.createElement("canvas");
  crop.width = sw;
  crop.height = sh;
  const ctx = crop.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(rendered.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return crop;
}

export class OcrProcessor extends BrowserProcessor<OcrInput, OcrOutput> {
  async process({ file, language, onPageProgress, isCancelled, ocrAllowed = true, maxOcrPages = MAX_OCR_PAGES }: OcrInput): Promise<OcrOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    if (isSupportedImageFile(file)) {
      if (!ocrAllowed) {
        return {
          pages: [{ pageNumber: 1, text: "", method: "needs-ocr", confidence: null }],
          combinedText: "",
          isSingleImage: true,
          cancelled: false,
          hasUnreadPages: true,
        };
      }
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
        hasUnreadPages: false,
      };
    }

    if (!isPdfFile(file)) {
      throw new Error(
        "対応していないファイル形式です。JPG・PNG・WebP画像、またはPDFファイルを選択してください。"
      );
    }

    const pdf = await loadPdfDocument(file);
    try {
      if (pdf.numPages === 0) {
        throw new Error("このPDFにはページがありません");
      }
      // OCRで読み取るページ数の上限（料金プラン）。文字情報だけで読めるページは数えない
      let ocrPagesLeft = Math.max(0, maxOcrPages);

      const pages: OcrPageResult[] = [];
      const finish = (cancelled: boolean): OcrOutput => ({
        pages,
        combinedText: combinePages(pages),
        isSingleImage: false,
        cancelled,
        hasUnreadPages: pages.some((p) => p.method === "needs-ocr"),
      });

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        if (isCancelled?.()) return finish(true);

        let page: PdfjsPage;
        try {
          page = await pdf.getPage(pageNumber);
        } catch {
          throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
        }

        const items = await getPositionedTextItems(page);
        const layerText = pageHasText(items) ? pageTextFromItems(items) : "";
        const layerChars = layerText.replace(/\s/g, "").length;
        const [vx0, vy0, vx1, vy1] = page.view;
        const boxes = await getPageImageBoxes(page);
        const kind = classifyPage(layerChars, boxes, { x0: vx0, y0: vy0, width: vx1 - vx0, height: vy1 - vy0 });

        if (kind.kind === "text-layer" || (kind.kind === "mixed" && (!ocrAllowed || ocrPagesLeft <= 0))) {
          // 文字情報のあるページはOCRしない（OCRを使えないときは、混在ページも文字情報の部分だけを使う）
          pages.push({ pageNumber, text: layerText, method: "text-layer", confidence: null });
          onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "text-layer", pageProgress: 1 });
          continue;
        }

        if (!ocrAllowed || ocrPagesLeft <= 0) {
          // OCRが必要なページ（OCRを使えない・上限に達した）。わずかな文字情報（ページ番号など）があれば、それだけは残す
          pages.push({ pageNumber, text: layerText, method: "needs-ocr", confidence: null });
          onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "needs-ocr", pageProgress: 1 });
          continue;
        }

        ocrPagesLeft -= 1;
        // 全ページ分の画像を同時に保持せず、1ページ処理するごとにcanvasの参照を手放す。
        let rendered: { canvas: HTMLCanvasElement; scale: number };
        try {
          rendered = await renderPageForOcr(page);
        } catch {
          throw new Error(`${pageNumber}ページ目の画像化に失敗しました`);
        }

        if (kind.kind === "ocr") {
          const { text, confidence } = await recognizeImage(rendered.canvas, language, (p) => {
            onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "ocr", pageProgress: p.progress });
          });
          pages.push({ pageNumber, text: text.trim(), method: "ocr", confidence });
          continue;
        }

        // 文字と画像の混在ページ：文字情報はそのまま使い、画像の部分だけをOCRする
        const parts: string[] = [];
        const confidences: number[] = [];
        for (let i = 0; i < kind.regions.length; i++) {
          const crop = cropRegion(page, rendered, kind.regions[i]);
          if (!crop) continue;
          const { text, confidence } = await recognizeImage(crop, language, (p) => {
            onPageProgress?.({
              currentPage: pageNumber,
              totalPages: pdf.numPages,
              method: "mixed",
              pageProgress: (i + p.progress) / kind.regions.length,
            });
          });
          const t = text.trim();
          if (t) {
            parts.push(t);
            confidences.push(confidence);
          }
        }
        const imageText = parts.join("\n\n");
        const confidence = confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
        if (!imageText) {
          // 画像の中に文字が見つからなかった（写真・図など）。文字情報だけのページとして扱う
          pages.push({ pageNumber, text: layerText, method: "text-layer", confidence: null });
          continue;
        }
        pages.push({
          pageNumber,
          text: `${layerText}\n\n[画像の中の文字（OCR）]\n${imageText}`,
          method: "mixed",
          confidence,
          layerText,
          imageText,
        });
      }

      return finish(false);
    } finally {
      await closePdfDocument(pdf);
    }
  }
}
