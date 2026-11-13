/**
 * PDFを扱うツールの、1回に処理できるページ数の上限。
 *
 * 実際の制限処理（src/lib/processors/browser/ の各ファイル）と、利用者向けの説明文
 * （src/lib/seo/tool-content.ts のFAQ・使い方）の両方がこの値を参照する。
 * 数字を説明文に手書きすると、上限を変えたときに説明だけが古くなるため、ここを唯一の定義にする。
 * ファイルサイズの上限（FileDropzoneのmaxSizeMB）とは別の制限。
 *
 * 2026-11：料金プランの見直しで、PDF→Word・PDF→Excel・OCRの上限はプラン別になった（src/lib/plans/tool-limits.ts）。
 * ここの値はプレミアムでの上限（説明文と、プランを渡さずに処理を呼んだときの既定値）。
 */
import { PLAN_LIMITS } from "@/lib/plans/tool-limits";

/** PDF→Word: 1回に変換できる総ページ数。超えるとエラーにして処理しない */
export const PDF_TO_WORD_MAX_PAGES: number = PLAN_LIMITS["pdf-to-word"].premium;

/** PDF→Excel: 1回に変換できる総ページ数。超えるとエラーにして処理しない */
export const PDF_TO_EXCEL_MAX_PAGES: number = PLAN_LIMITS["pdf-to-excel"].premium;

/** PDF→Excel: 文字情報のないページ（スキャン画像）をOCRで読み取れるページ数。超えるとエラーにして処理しない */
export const PDF_TO_EXCEL_MAX_OCR_PAGES = 20;

/** OCR（PDF→テキスト）: 1回にOCRで読み取れるページ数。超えた分の、文字情報のないページは読み取らない */
export const OCR_MAX_PAGES: number = PLAN_LIMITS["pdf-ocr"].premium;

/** 領収書の読み取り: PDF1つあたりのページ数。超えるとエラーにして処理しない */
export const RECEIPT_PDF_MAX_PAGES = 20;
