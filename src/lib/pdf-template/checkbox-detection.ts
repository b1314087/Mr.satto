import { cropFieldCanvas } from "./field-extraction";
import type { RenderedPageCanvas } from "@/lib/pdf/pdfjs-client";
import type { TemplateField } from "./types";

/**
 * checkbox枠のルールベース判定（Phase 18.2 A-19）。
 *
 * 「チェックボックスはOCR文字認識だけに頼らず、塗りつぶし量・黒画素割合・
 * テンプレートとの差分などのルールベース判定を使用してください」という
 * 指示に対応する。チェックマーク（✓、レ点）・塗りつぶし・スタンプなど、
 * 記入方法によらず「枠の中が空テンプレート時点よりどれだけ暗くなったか」
 * だけで判定できる、AIを使わない決定的な処理。
 *
 * ページ描画→枠だけをcropする仕組みは field-extraction.ts の
 * cropFieldCanvas（OCR用に実装済み）をそのまま再利用し、新しい
 * canvas切り出しロジックは作らない（開発指示書I「既存Processorを
 * 最大限再利用する」）。
 */

/** 輝度がこの値未満のピクセルを「暗い（インクがある）」とみなす閾値(0-255) */
const DARK_LUMINANCE_THRESHOLD = 170;
/** 空テンプレートとの黒画素割合の差分がこの値以上ならチェックありと判定する */
const CHECKBOX_DELTA_THRESHOLD = 0.08;
/** 空テンプレート側の基準値(blankFillRatio)が無い場合に使う絶対閾値 */
const CHECKBOX_ABSOLUTE_THRESHOLD = 0.15;

/**
 * canvas内の「暗いピクセル」の割合(0〜1)を計算する。
 * チェックマークの色（黒・青インク等）によらず機能するよう、単純な
 * 明度（輝度）だけで判定し、特定の色を仮定しない。
 */
export function computeDarkPixelRatio(canvas: HTMLCanvasElement): number {
  if (canvas.width === 0 || canvas.height === 0) return 0;
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const totalPixels = canvas.width * canvas.height;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (luminance < DARK_LUMINANCE_THRESHOLD) dark += 1;
  }
  return totalPixels > 0 ? dark / totalPixels : 0;
}

export interface CheckboxExtractionParams {
  field: Pick<TemplateField, "x" | "y" | "width" | "height"> & { blankFillRatio?: number };
  /** OCR用ページ描画と同じ遅延・使い回しの仕組み（1ページにつき最大1回描画） */
  getPage: () => Promise<RenderedPageCanvas | null>;
  pageHeightPt: number;
}

export interface CheckboxExtractionResult {
  checked: boolean;
  /** 記入済みPDFのこの枠内の黒画素割合（デバッグ・将来の閾値調整用。個人情報は含まない） */
  fillRatio: number;
}

/**
 * 1つのcheckbox枠について、記入済みPDF上の黒画素割合を計算し、
 * テンプレート登録時に記録した空テンプレートの黒画素割合(blankFillRatio)との
 * 差分でチェック有無を判定する。基準値が無い場合（古いテンプレート等）は
 * 絶対閾値にフォールバックする。
 *
 * 画像PDF・テキストPDFのどちらでも必ずページ描画→枠だけのcropを経由する
 * （A-15と同じ「全ページOCRはしない・対象枠だけを見る」方針をpixel判定にも適用）。
 */
export async function extractCheckboxValue(params: CheckboxExtractionParams): Promise<CheckboxExtractionResult> {
  const { field, getPage, pageHeightPt } = params;
  try {
    const rendered = await getPage();
    if (!rendered) return { checked: false, fillRatio: 0 };
    const crop = cropFieldCanvas(rendered.canvas, field, pageHeightPt, rendered.scale);
    if (!crop) return { checked: false, fillRatio: 0 };
    const fillRatio = computeDarkPixelRatio(crop);

    if (typeof field.blankFillRatio === "number") {
      return { checked: fillRatio - field.blankFillRatio >= CHECKBOX_DELTA_THRESHOLD, fillRatio };
    }
    return { checked: fillRatio >= CHECKBOX_ABSOLUTE_THRESHOLD, fillRatio };
  } catch {
    // 1つの枠の判定失敗で全体を止めない（extractFieldValueと同じ方針）
    return { checked: false, fillRatio: 0 };
  }
}

/**
 * Excel出力・結果プレビュー編集欄で使う、チェック有無の文字列表現。
 * 未チェックは空文字列にする（開発指示書A-23「空欄Fieldは空文字として扱う」を
 * checkbox枠にも適用し、人物の有効判定(isPersonValid)でも「未記入」と
 * 同じ扱いになるようにする）。
 */
export const CHECKBOX_CHECKED_VALUE = "TRUE";
export const CHECKBOX_UNCHECKED_VALUE = "";
