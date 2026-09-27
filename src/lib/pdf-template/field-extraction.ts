import type { PositionedTextItem, RenderedPageCanvas } from "@/lib/pdf/pdfjs-client";
import { groupIntoLines } from "@/lib/pdf/table-reconstruction";
import { recognizeImage, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { pdfToScreenX, pdfToScreenY } from "@/lib/pdf/coords";
import type { TemplateField } from "./types";

/**
 * テンプレートモードの「決めた位置から、決めた項目を取り出す」処理の中核
 * （開発指示書14章・36章の Field Extraction 段階）。
 *
 * 既存の自動抽出モード（filled-pdf-to-excel.ts）が「ページ全体を表として
 * 再構成する」のに対し、こちらは「テンプレートで指定した1つの矩形の中だけ」
 * を見る。PDFのテキストレイヤー抽出（src/lib/pdf/pdfjs-client.ts,
 * table-reconstruction.ts の groupIntoLines）とOCR（tesseract-client.ts）の
 * どちらも既存基盤をそのまま再利用し、新しい抽出エンジンは作らない。
 */

export type FieldExtractionMethod = "text-layer" | "ocr" | "empty";

export interface FieldExtractionResult {
  value: string;
  method: FieldExtractionMethod;
  confidence: number | null;
}

/**
 * PDFページ座標系での矩形(x, y, width, height。原点左下)に、バウンディング
 * ボックスの中心が入っているテキスト断片だけを抽出し、行ごとに読み順
 * （上→下、各行内は左→右）で連結する。
 * groupIntoLines（table-reconstruction.ts）と同じ行グルーピングロジックを
 * 再利用しており、表構造の推定とは独立に「1つの枠の中の文字列」だけを見る。
 */
export function collectTextInRegion(
  items: PositionedTextItem[],
  x: number,
  y: number,
  width: number,
  height: number
): string {
  const minX = x;
  const maxX = x + width;
  const minY = y;
  const maxY = y + height;

  const inside = items.filter((item) => {
    if (item.str.trim() === "") return false;
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
  });
  if (inside.length === 0) return "";

  const lines = groupIntoLines(inside);
  return lines
    .map((line) => line.items.map((i) => i.str).join("").replace(/\s+/g, " ").trim())
    .filter((s) => s !== "")
    .join("\n")
    .trim();
}

/**
 * テンプレート由来の固定文字（ラベルの残り等）を、抽出した値から取り除く
 * （開発指示書16章）。「氏名：」のような固定文字列そのものの完全一致・
 * 部分一致除去のみを行う決定的な処理で、あいまいな推測は行わない。
 * 結果が固定文字だけだった場合（記入なし）は空文字列を返す。
 */
export function stripFixedText(raw: string, fixedText: string | undefined): string {
  const value = raw.trim();
  if (!fixedText) return value;
  const fixed = fixedText.trim();
  if (fixed === "") return value;
  if (value === fixed) return "";
  const stripped = value.split(fixed).join("").replace(/\s+/g, " ").trim();
  return stripped;
}

/** OCR用に、ページ描画済みcanvasから対象フィールドの矩形部分だけを切り出す */
export function cropFieldCanvas(
  pageCanvas: HTMLCanvasElement,
  field: Pick<TemplateField, "x" | "y" | "width" | "height">,
  pageHeightPt: number,
  renderScale: number
): HTMLCanvasElement | null {
  const left = Math.max(0, Math.floor(pdfToScreenX(field.x, renderScale)));
  const top = Math.max(0, Math.floor(pdfToScreenY(field.y, field.height, pageHeightPt, renderScale)));
  const cropWidth = Math.max(1, Math.min(pageCanvas.width - left, Math.ceil(field.width * renderScale)));
  const cropHeight = Math.max(1, Math.min(pageCanvas.height - top, Math.ceil(field.height * renderScale)));
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  // 小さい枠はOCR精度が落ちやすいため、上限を設けつつ拡大して切り出す
  // （tesseract.jsは一般に極端に小さい文字画像の認識精度が低いため）。
  const upscale = cropWidth < 200 ? Math.min(3, 200 / cropWidth) : 1;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = Math.ceil(cropWidth * upscale);
  outCanvas.height = Math.ceil(cropHeight * upscale);
  const ctx = outCanvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(pageCanvas, left, top, cropWidth, cropHeight, 0, 0, outCanvas.width, outCanvas.height);
  return outCanvas;
}

export interface ExtractFieldParams {
  field: TemplateField;
  /** そのページのテキストレイヤー（getPositionedTextItems済み）。ページに文字情報が無ければ空配列 */
  textItems: PositionedTextItem[];
  /** テキストレイヤーだけで十分な値が取れなかった場合にのみ呼ばれる（OCR用ページ描画の遅延生成・使い回し） */
  getOcrPage: () => Promise<RenderedPageCanvas | null>;
  pageHeightPt: number;
  language: OcrLanguageOption;
}

/**
 * 1つの入力枠から値を抽出する。優先順位は開発指示書18章のとおり
 * 「PDFテキスト抽出 → 不十分ならOCR」。OCRはこの枠の小領域だけに限定する
 * （開発指示書17章・40章：OCR対象面積の削減）。
 */
export async function extractFieldValue(params: ExtractFieldParams): Promise<FieldExtractionResult> {
  const { field, textItems, getOcrPage, pageHeightPt, language } = params;

  if (textItems.length > 0) {
    const raw = collectTextInRegion(textItems, field.x, field.y, field.width, field.height);
    const stripped = stripFixedText(raw, field.fixedText);
    if (stripped !== "") {
      return { value: stripped, method: "text-layer", confidence: null };
    }
  }

  // テキストレイヤーが無い、またはこの枠だけ値が取れなかった場合はOCRへフォールバック
  try {
    const rendered = await getOcrPage();
    if (!rendered) return { value: "", method: "empty", confidence: null };
    const crop = cropFieldCanvas(rendered.canvas, field, pageHeightPt, rendered.scale);
    if (!crop) return { value: "", method: "empty", confidence: null };
    const result = await recognizeImage(crop, language);
    const stripped = stripFixedText(result.text, field.fixedText);
    if (stripped === "") return { value: "", method: "empty", confidence: result.confidence };
    return { value: stripped, method: "ocr", confidence: result.confidence };
  } catch {
    // 1つの枠のOCR失敗で全体を止めない
    return { value: "", method: "empty", confidence: null };
  }
}
