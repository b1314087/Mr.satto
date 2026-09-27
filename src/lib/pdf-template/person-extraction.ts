import {
  loadPdfDocument,
  getPositionedTextItems,
  pageHasText,
  renderPageToCanvas,
  type PdfjsPage,
  type PositionedTextItem,
  type RenderedPageCanvas,
} from "@/lib/pdf/pdfjs-client";
import type { OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { extractFieldValue, type FieldExtractionMethod } from "./field-extraction";
import { PERSON_VALID_MIN_RATIO, type Template, type TemplateField } from "./types";

/**
 * テンプレートモードの人物・ページ単位オーケストレーション（Phase 18、
 * 開発指示書36章の Field Extraction → Person Records 段階）。
 *
 * 「テンプレートが位置を指定 → その位置だけを確認 → 文字抽出/OCR」という
 * 方式（開発指示書14章）を、記入済みPDFの全ページ・全人物に対して適用する。
 * ページ画像化（OCR用）は1ページにつき最大1回だけ行い、そのページ内の
 * 複数フィールドで使い回す（開発指示書40章：不要な画像コピー・再描画の削減）。
 */

const OCR_RENDER_SCALE = 2;
/** OCR用に描画するページ画像の最長辺の上限(px)。既存の自動抽出モードと同じ値 */
const OCR_MAX_DIMENSION = 2000;

export interface PersonFieldValue {
  fieldIndex: number;
  label: string;
  value: string;
  method: FieldExtractionMethod;
  confidence: number | null;
}

export interface PersonRecord {
  /** Reactのkey・プレビュー編集用の一意なID（個人情報を含まない） */
  id: string;
  sourceFileName: string;
  /** 元ファイル内でのページ番号（1始まり） */
  sourcePageNumber: number;
  personIndex: number;
  fields: PersonFieldValue[];
  /** ルールベースの人物存在判定結果（開発指示書32・33章） */
  valid: boolean;
  /** テンプレート設定(excludeEmptyPersons)により出力から除外されたか */
  excluded: boolean;
}

/**
 * 人物ブロックが「有効（記入あり）」かどうかを判定する。
 * AIは使わず、「有効な値を持つ項目の割合」だけで決定的に判定する
 * （開発指示書33章の例「3項目以上のうち2項目以上に値あり」を一般化した
 * 過半数ルール）。
 */
export function isPersonValid(fields: PersonFieldValue[]): boolean {
  if (fields.length === 0) return false;
  const nonEmpty = fields.filter((f) => f.value.trim() !== "").length;
  const threshold = Math.max(1, Math.ceil(fields.length * PERSON_VALID_MIN_RATIO));
  return nonEmpty >= threshold;
}

function groupFieldsByPerson(fields: TemplateField[]): Map<number, TemplateField[]> {
  const byPerson = new Map<number, TemplateField[]>();
  for (const f of fields) {
    const arr = byPerson.get(f.personIndex) ?? [];
    arr.push(f);
    byPerson.set(f.personIndex, arr);
  }
  return byPerson;
}

/** 1ページ分の「OCR用ページ描画」を遅延・使い回しするためのヘルパー */
function makeLazyOcrPage(page: PdfjsPage, markUsedOcr: () => void) {
  let promise: Promise<RenderedPageCanvas | null> | null = null;
  return () => {
    if (!promise) {
      markUsedOcr();
      promise = renderPageToCanvas(page, OCR_RENDER_SCALE, OCR_MAX_DIMENSION).catch(() => null);
    }
    return promise;
  };
}

export interface ExtractPersonsFromFileOptions {
  file: File;
  template: Template;
  language: OcrLanguageOption;
  onPageProgress?: (info: { currentPage: number; totalPages: number; method: "text-layer" | "ocr" }) => void;
}

export interface ExtractPersonsFromFileResult {
  records: PersonRecord[];
  pageCount: number;
  usedOcr: boolean;
}

/**
 * 1つの記入済みPDFファイルから、テンプレートの入力枠に基づいて人物ごとの
 * 値を抽出する。テンプレートのページ数より記入済みPDFのページ数が多い場合、
 * ページ番号をテンプレートのページ数で周期的に割り当てて適用する
 * （開発指示書12章：同一レイアウトの複数ページへの適用）。
 */
export async function extractPersonsFromFile(opts: ExtractPersonsFromFileOptions): Promise<ExtractPersonsFromFileResult> {
  const { file, template, language, onPageProgress } = opts;
  const pdf = await loadPdfDocument(file);
  const templatePageCount = Math.max(1, template.pages.length);
  const records: PersonRecord[] = [];
  let usedOcr = false;
  let idCounter = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const templatePageIndex = (pageNumber - 1) % templatePageCount;
    const fieldsOnPage = template.fields.filter((f) => f.pageIndex === templatePageIndex);

    if (fieldsOnPage.length === 0) {
      onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "text-layer" });
      continue;
    }

    let page;
    try {
      page = await pdf.getPage(pageNumber);
    } catch {
      throw new Error(`${file.name} の${pageNumber}ページ目の読み込みに失敗しました`);
    }

    const pageHeightPt = page.getViewport({ scale: 1 }).height;
    const textItems: PositionedTextItem[] = await getPositionedTextItems(page);
    const hasText = pageHasText(textItems);
    const getOcrPage = makeLazyOcrPage(page, () => {
      usedOcr = true;
    });

    onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: hasText ? "text-layer" : "ocr" });

    const byPerson = groupFieldsByPerson(fieldsOnPage);
    const personIndexes = Array.from(byPerson.keys()).sort((a, b) => a - b);

    for (const personIndex of personIndexes) {
      const sortedFields = [...(byPerson.get(personIndex) ?? [])].sort((a, b) => a.fieldIndex - b.fieldIndex);
      const values: PersonFieldValue[] = [];
      for (const field of sortedFields) {
        const result = await extractFieldValue({
          field,
          textItems: hasText ? textItems : [],
          getOcrPage,
          pageHeightPt,
          language,
        });
        values.push({
          fieldIndex: field.fieldIndex,
          label: field.label.trim() || `項目${field.fieldIndex}`,
          value: result.value,
          method: result.method,
          confidence: result.confidence,
        });
      }
      const valid = isPersonValid(values);
      const excluded = !valid && template.excludeEmptyPersons;
      idCounter += 1;
      records.push({
        id: `p${idCounter}-${pageNumber}-${personIndex}`,
        sourceFileName: file.name,
        sourcePageNumber: pageNumber,
        personIndex,
        fields: values,
        valid,
        excluded,
      });
    }
  }

  return { records, pageCount: pdf.numPages, usedOcr };
}

/**
 * テンプレート登録時に、空のテンプレートPDF自身から各枠の「固定文字」
 * （ラベルの残り等）を読み取り、テンプレート定義へ記録する（開発指示書15・16章）。
 * 記入済みPDFの抽出結果からこの固定文字を除外することで、
 * 「氏名：」等が値に混ざるのを防ぐ。
 */
export async function captureFixedTextForTemplate(
  templateFile: File,
  template: Template,
  language: OcrLanguageOption
): Promise<Template> {
  const pdf = await loadPdfDocument(templateFile);
  const pageCache = new Map<
    number,
    { textItems: PositionedTextItem[]; hasText: boolean; pageHeightPt: number; getOcrPage: () => Promise<RenderedPageCanvas | null> }
  >();

  const updatedFields: TemplateField[] = [];
  for (const field of template.fields) {
    const pageNumber = field.pageIndex + 1;
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      updatedFields.push({ ...field, fixedText: undefined });
      continue;
    }

    let ctx = pageCache.get(pageNumber);
    if (!ctx) {
      const page = await pdf.getPage(pageNumber);
      const textItems = await getPositionedTextItems(page);
      const hasText = pageHasText(textItems);
      const pageHeightPt = page.getViewport({ scale: 1 }).height;
      const getOcrPage = makeLazyOcrPage(page, () => {});
      ctx = { textItems, hasText, pageHeightPt, getOcrPage };
      pageCache.set(pageNumber, ctx);
    }

    const result = await extractFieldValue({
      field: { ...field, fixedText: undefined },
      textItems: ctx.hasText ? ctx.textItems : [],
      getOcrPage: ctx.getOcrPage,
      pageHeightPt: ctx.pageHeightPt,
      language,
    });
    updatedFields.push({ ...field, fixedText: result.value || undefined });
  }

  return { ...template, fields: updatedFields };
}
