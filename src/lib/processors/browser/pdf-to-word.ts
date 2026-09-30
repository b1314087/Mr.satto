import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems, pageHasText, renderPageToCanvas } from "@/lib/pdf/pdfjs-client";
import { reconstructParagraphs, type DocumentBlock } from "@/lib/pdf/paragraph-reconstruction";
import { recognizeImageWithWords, ocrWordsToPositionedTextItems, type OcrLanguageOption } from "@/lib/ocr/tesseract-client";

/**
 * PDF→Word Processor（Phase 2-D、外出先PC修正指示書§27-28でスキャンPDF対応を追加）。
 *
 * 目標は「PDFの見た目を100%再現すること」ではなく、
 * 「編集しやすいWord文書に変換すること」（開発指示書に明記された優先順位）。
 * 2段組・ヘッダー/フッター・特殊フォント・画像等、完全な再現が難しい要素は
 * 無理をして再現しない（今回のバージョンでは画像の抽出・埋め込みも対象外）。
 *
 * DOCX生成には `docx` パッケージを利用する。選定理由：
 *   - MITライセンス／依存パッケージが少ない（xml, jszip, nanoid, xml-js, hash.js, @types/node）
 *   - ブラウザ・Node(Vercel実行環境)のどちらでも動作する（Packer.toBlob() / toBuffer()）
 *   - Paragraph/Heading/Table等、Word文書生成に必要な機能を素で持つ
 *   - 生成したDOCXが実際にLibreOffice/Wordで開けることを検証済み
 *     （日本語テキストの埋め込み・往復も確認済み。詳細は最終報告参照）
 *
 * スキャンPDF対応（§27-28）: 以前は文字レイヤーが無いページ（紙をスキャンした
 * 画像PDF）に遭遇すると、そのページに限らずファイル全体を「未対応」として
 * エラーにしていた。記入済みPDF→Excel(filled-pdf-to-excel.ts)が既に確立している
 * 「ページに文字レイヤーが無ければ画像化してOCRし、単語のbounding boxを
 * table-reconstruction.ts / paragraph-reconstruction.tsが期待する
 * PositionedTextItem形状へ変換して、以後は文字レイヤーのページと全く同じ
 * 座標ベースの構造推定ロジックに渡す」というアーキテクチャをそのまま再利用し、
 * ページ単位で「文字レイヤーがあればそれを使い、無ければOCRする」判定に変更した
 * （新しいOCRエンジン・新しい構造推定ロジックは追加せず、既存基盤の組み合わせのみ）。
 */

const MAX_PDF_TO_WORD_PAGES = 50;
/** OCR用に描画するページ画像の解像度。filled-pdf-to-excel.tsと同じ値を踏襲する */
const PDF_RENDER_SCALE = 2;
const MAX_OCR_DIMENSION = 2000;

export interface PdfToWordInput {
  file: File;
  /** スキャンPDF（文字レイヤーの無いページ）を検出した場合にOCRする言語。省略時は"ja+en"。 */
  ocrLanguage?: OcrLanguageOption;
  onPageProgress?: (info: { currentPage: number; totalPages: number; method?: "text-layer" | "ocr"; ocrProgress?: number }) => void;
}

export interface PdfToWordOutput {
  blob: Blob;
  sizeBytes: number;
  pageCount: number;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
  /** OCR（スキャンPDFページ）を1ページでも使用したか */
  usedOcr: boolean;
  /** OCRしたページの平均信頼度(0〜100)。OCRを使わなかった場合はnull */
  ocrConfidence: number | null;
}

export class PdfToWordProcessor extends BrowserProcessor<PdfToWordInput, PdfToWordOutput> {
  async process({ file, ocrLanguage, onPageProgress }: PdfToWordInput): Promise<PdfToWordOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    const pdf = await loadPdfDocument(file);
    if (pdf.numPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    if (pdf.numPages > MAX_PDF_TO_WORD_PAGES) {
      throw new Error(
        `変換できるページ数の上限は${MAX_PDF_TO_WORD_PAGES}ページです（このPDFは${pdf.numPages}ページあります）。ページ数を減らしてから再度お試しください。`
      );
    }

    const allBlocks: DocumentBlock[] = [];
    let anyTextFound = false;
    let usedOcr = false;
    const ocrConfidences: number[] = [];
    const language = ocrLanguage ?? "ja+en";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
      }

      const textItems = await getPositionedTextItems(page);
      let blocks: DocumentBlock[];

      if (pageHasText(textItems)) {
        onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "text-layer" });
        anyTextFound = true;
        blocks = reconstructParagraphs(textItems);
      } else {
        // 文字レイヤーの無いページ（紙をスキャンした画像PDF等）は、
        // filled-pdf-to-excel.tsと同じ方式でページを画像化してOCRする(§27-28)。
        usedOcr = true;
        onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "ocr", ocrProgress: 0 });
        let canvas: HTMLCanvasElement;
        try {
          const rendered = await renderPageToCanvas(page, PDF_RENDER_SCALE, MAX_OCR_DIMENSION);
          canvas = rendered.canvas;
        } catch {
          throw new Error(`${pageNumber}ページ目の画像化に失敗しました`);
        }
        const result = await recognizeImageWithWords(canvas, language, (p) => {
          onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages, method: "ocr", ocrProgress: p.progress });
        });
        ocrConfidences.push(result.confidence);
        if (result.words.some((w) => w.text.trim() !== "")) anyTextFound = true;
        const ocrItems = ocrWordsToPositionedTextItems(result.words);
        blocks = reconstructParagraphs(ocrItems);
      }

      if (pageNumber > 1 && blocks.length > 0 && allBlocks.length > 0) {
        // ページの区切りが分かるよう、空段落を1つはさむ（見た目の再現よりも
        // 読みやすさ・編集しやすさを優先する方針のため、明示的な改ページは入れない）
        allBlocks.push({ type: "paragraph", text: "" });
      }
      allBlocks.push(...blocks);
    }

    if (!anyTextFound) {
      throw new Error(
        usedOcr
          ? "このPDFから文字を読み取れませんでした。スキャン画像の解像度が低いか、手書き文字の可能性があります。"
          : "このPDFから文字情報を抽出できませんでした。"
      );
    }
    if (allBlocks.length === 0) {
      throw new Error("変換できる文章が見つかりませんでした。");
    }

    const headingCount = allBlocks.filter(
      (b) => b.type === "heading1" || b.type === "heading2"
    ).length;
    const tableCount = allBlocks.filter((b) => b.type === "table").length;
    const paragraphCount = allBlocks.filter(
      (b) => b.type === "paragraph" && b.text !== ""
    ).length;

    let blob: Blob;
    try {
      blob = await buildDocxBlob(allBlocks);
    } catch {
      throw new Error("Word文書の生成に失敗しました");
    }

    return {
      blob,
      sizeBytes: blob.size,
      pageCount: pdf.numPages,
      paragraphCount,
      headingCount,
      usedOcr,
      ocrConfidence: ocrConfidences.length > 0 ? ocrConfidences.reduce((a, b) => a + b, 0) / ocrConfidences.length : null,
      tableCount,
    };
  }
}

async function buildDocxBlob(blocks: DocumentBlock[]): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } =
    await import("docx");

  const children = blocks.map((block) => {
    if (block.type === "heading1") {
      return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 });
    }
    if (block.type === "heading2") {
      return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 });
    }
    if (block.type === "table") {
      return new Table({
        rows: block.rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cellText) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun(cellText)] })],
                  })
              ),
            })
        ),
      });
    }
    return new Paragraph({ children: [new TextRun(block.text)] });
  });

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBlob(doc);
}
