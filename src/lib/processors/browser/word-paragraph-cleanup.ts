import { BrowserProcessor } from "../types";
import {
  loadDocxPackage,
  parseDocumentXml,
  serializeDocumentXml,
  buildDocxBlob,
  getBodyElement,
  getAllTextRuns,
  getTopLevelParagraphs,
  isParagraphBlank,
  getParagraphText,
} from "@/lib/word/docx-text-ops";

/**
 * Word段落整理（次工程・軽量便利ツール一括追加 Tool 9）。
 *
 * テキストレベルの整形（全角/半角スペース変換・連続スペースの圧縮）は、
 * 表のセル内も含む文書全体の全テキストラン(w:t)へ適用する（純粋な文字列の
 * 書き換えのため、構造上のリスクがない）。
 * 一方、段落そのものの削除・整理（空白行の削除・連続する改行の整理）は、
 * 本文直下の段落だけを対象にする（表のセル内の段落を削除すると、セルが
 * 空になってOOXMLとして不正な状態になり得るため、意図的に対象外にする）。
 */
export interface ParagraphCleanupOptions {
  fullToHalfSpace: boolean;
  halfToFullSpace: boolean;
  collapseRepeatedSpaces: boolean;
  collapseConsecutiveBlankLines: boolean;
  removeBlankLines: boolean;
}

export interface WordParagraphCleanupInput {
  file: File;
  options: ParagraphCleanupOptions;
}

export interface WordParagraphCleanupOutput {
  blob: Blob;
  beforeText: string;
  afterText: string;
  removedParagraphCount: number;
}

function normalizeTextRun(text: string, options: ParagraphCleanupOptions): string {
  let result = text;
  if (options.fullToHalfSpace) result = result.replace(/　/g, " ");
  if (options.halfToFullSpace) result = result.replace(/ /g, "　");
  if (options.collapseRepeatedSpaces) result = result.replace(/[ 　]{2,}/g, (m) => m[0]);
  return result;
}

function joinParagraphTexts(paragraphs: Element[]): string {
  return paragraphs.map((p) => getParagraphText(p)).join("\n");
}

/**
 * 解析済みのdocument.xml(DOM)に整理を適用する(出力とプレビューで共通)。
 * doc は直接書き換えられる。
 */
export function applyParagraphCleanup(
  doc: Document,
  options: ParagraphCleanupOptions
): {
  beforeText: string;
  afterText: string;
  removedParagraphCount: number;
  /** 本文直下の段落ごとの処理前テキストと処理後テキスト(削除された段落は after が null) */
  paragraphs: { before: string; after: string | null }[];
} {
  const body = getBodyElement(doc);

  const originalParagraphs = getTopLevelParagraphs(body);
  const originalTexts = originalParagraphs.map((p) => getParagraphText(p));
  const beforeText = originalTexts.join("\n");

  // 1) テキストレベルの整形（文書全体、表のセル内も含む）
  if (options.fullToHalfSpace || options.halfToFullSpace || options.collapseRepeatedSpaces) {
    for (const run of getAllTextRuns(doc)) {
      const original = run.textContent ?? "";
      const updated = normalizeTextRun(original, options);
      if (updated !== original) run.textContent = updated;
    }
  }

  // 2) 段落レベルの整理（本文直下の段落のみ）
  let removedParagraphCount = 0;
  if (options.collapseConsecutiveBlankLines || options.removeBlankLines) {
    const paragraphs = getTopLevelParagraphs(body);
    const blankFlags = paragraphs.map((p) => isParagraphBlank(p));

    if (options.collapseConsecutiveBlankLines) {
      let previousWasBlank = false;
      for (let i = 0; i < paragraphs.length; i++) {
        if (blankFlags[i] && previousWasBlank) {
          body.removeChild(paragraphs[i]);
          removedParagraphCount++;
        } else if (blankFlags[i]) {
          previousWasBlank = true;
        } else {
          previousWasBlank = false;
        }
      }
    }

    if (options.removeBlankLines) {
      // 上のステップで一部が既にDOMから除去されている可能性があるため、
      // 現時点でまだ本文に残っている段落だけを対象に再評価する
      const remaining = getTopLevelParagraphs(body);
      for (const p of remaining) {
        if (isParagraphBlank(p)) {
          body.removeChild(p);
          removedParagraphCount++;
        }
      }
    }
  }

  const afterText = joinParagraphTexts(getTopLevelParagraphs(body));
  const paragraphs = originalParagraphs.map((p, i) => ({
    before: originalTexts[i],
    after: p.parentNode === body ? getParagraphText(p) : null,
  }));
  return { beforeText, afterText, removedParagraphCount, paragraphs };
}

/** document.xmlのテキストから、整理後の段落テキスト(処理前→処理後)だけを求める(プレビュー用) */
export function previewParagraphCleanup(documentXmlText: string, options: ParagraphCleanupOptions) {
  return applyParagraphCleanup(parseDocumentXml(documentXmlText), options);
}

export class WordParagraphCleanupProcessor extends BrowserProcessor<
  WordParagraphCleanupInput,
  WordParagraphCleanupOutput
> {
  async process(input: WordParagraphCleanupInput): Promise<WordParagraphCleanupOutput> {
    const pkg = await loadDocxPackage(input.file);
    const doc = parseDocumentXml(pkg.documentXmlText);

    const { beforeText, afterText, removedParagraphCount } = applyParagraphCleanup(doc, input.options);

    const newXml = serializeDocumentXml(doc, pkg.xmlDeclaration);
    const blob = buildDocxBlob(pkg, newXml);

    return { blob, beforeText, afterText, removedParagraphCount };
  }
}
