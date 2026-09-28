import { BrowserProcessor } from "../types";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import type { OcrLanguageOption } from "@/lib/ocr/tesseract-client";
import { extractPersonsFromFile, type PersonRecord } from "@/lib/pdf-template/person-extraction";
import { TEMPLATE_LIMITS, type Template } from "@/lib/pdf-template/types";

/**
 * 記入されたPDF→Excel「テンプレートモード」の抽出Processor（Phase 18）。
 *
 * 既存の自動抽出モード（filled-pdf-to-excel.ts）と同じ BrowserProcessor
 * アーキテクチャ・同じページ数上限方針（複数ファイルの合計ページ数で判定）を
 * 踏襲する。ただしこちらは最終的なExcelファイルまでは生成せず、
 * 人物ごとの抽出結果（PersonRecord[]）を返す。プレビュー画面での確認・修正
 * （開発指示書23・24章）を経てから、別途 excel-export.ts でExcel化するため
 * （UI ⇔ 重い処理(OCR) ⇔ 出力、の責務分離。開発指示書36章）。
 */

export interface FilledPdfToExcelTemplateInput {
  template: Template;
  files: File[];
  language: OcrLanguageOption;
  maxTotalPages?: number;
  onPageProgress?: (info: {
    fileName: string;
    currentPage: number;
    totalPagesInFile: number;
    fileIndex: number;
    fileCount: number;
    method: "text-layer" | "ocr";
  }) => void;
}

export interface FilledPdfToExcelTemplateOutput {
  records: PersonRecord[];
  pageCount: number;
  usedOcr: boolean;
  /** ルールベース判定で除外された人物の数（開発指示書32・33章） */
  excludedPersonCount: number;
}

export class FilledPdfToExcelTemplateProcessor extends BrowserProcessor<
  FilledPdfToExcelTemplateInput,
  FilledPdfToExcelTemplateOutput
> {
  async process({ template, files, language, maxTotalPages, onPageProgress }: FilledPdfToExcelTemplateInput): Promise<FilledPdfToExcelTemplateOutput> {
    if (files.length === 0) {
      throw new Error("記入済みのPDFファイルを選択してください");
    }
    if (files.some((f) => f.size === 0)) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }
    if (template.fields.length === 0) {
      throw new Error("テンプレートに入力枠が1つも登録されていません。先にテンプレートの枠を指定してください。");
    }

    const pdfDocs: { file: File; pdf: Awaited<ReturnType<typeof loadPdfDocument>> }[] = [];
    for (const file of files) {
      let pdf;
      try {
        pdf = await loadPdfDocument(file);
      } catch {
        throw new Error(`${file.name} の読み込みに失敗しました`);
      }
      if (pdf.numPages === 0) {
        throw new Error(`${file.name} にはページがありません`);
      }
      pdfDocs.push({ file, pdf });
    }

    const totalPages = pdfDocs.reduce((sum, d) => sum + d.pdf.numPages, 0);
    const effectiveLimit = Math.min(maxTotalPages ?? TEMPLATE_LIMITS.maxFilledPagesHard, TEMPLATE_LIMITS.maxFilledPagesHard);
    if (totalPages > effectiveLimit) {
      throw new Error(
        `このプラン・利用条件で処理できるページ数の上限は合計${effectiveLimit}ページです（選択したファイルの合計は${totalPages}ページです）。`
      );
    }

    const allRecords: PersonRecord[] = [];
    let usedOcr = false;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const { records, usedOcr: fileUsedOcr } = await extractPersonsFromFile({
        file,
        template,
        language,
        fileIndex,
        onPageProgress: (info) => {
          onPageProgress?.({
            fileName: file.name,
            currentPage: info.currentPage,
            totalPagesInFile: info.totalPages,
            fileIndex,
            fileCount: files.length,
            method: info.method,
          });
        },
      });
      if (fileUsedOcr) usedOcr = true;
      allRecords.push(...records);
    }

    const excludedPersonCount = allRecords.filter((r) => r.excluded).length;

    return {
      records: allRecords,
      pageCount: totalPages,
      usedOcr,
      excludedPersonCount,
    };
  }
}
