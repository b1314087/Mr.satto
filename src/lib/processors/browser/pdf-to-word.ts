import { BrowserProcessor } from "../types";
import { loadPdfDocument, getPositionedTextItems } from "@/lib/pdf/pdfjs-client";
import { reconstructParagraphs, type DocumentBlock } from "@/lib/pdf/paragraph-reconstruction";

/**
 * PDF→Word Processor（Phase 2-D）。
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
 */

const MAX_PDF_TO_WORD_PAGES = 50;

export interface PdfToWordInput {
  file: File;
  onPageProgress?: (info: { currentPage: number; totalPages: number }) => void;
}

export interface PdfToWordOutput {
  blob: Blob;
  sizeBytes: number;
  pageCount: number;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
}

export class PdfToWordProcessor extends BrowserProcessor<PdfToWordInput, PdfToWordOutput> {
  async process({ file, onPageProgress }: PdfToWordInput): Promise<PdfToWordOutput> {
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

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onPageProgress?.({ currentPage: pageNumber, totalPages: pdf.numPages });

      let page;
      try {
        page = await pdf.getPage(pageNumber);
      } catch {
        throw new Error(`${pageNumber}ページ目の読み込みに失敗しました`);
      }

      const items = await getPositionedTextItems(page);
      if (items.some((i) => i.str.trim() !== "")) anyTextFound = true;

      const blocks = reconstructParagraphs(items);
      if (pageNumber > 1 && blocks.length > 0 && allBlocks.length > 0) {
        // ページの区切りが分かるよう、空段落を1つはさむ（見た目の再現よりも
        // 読みやすさ・編集しやすさを優先する方針のため、明示的な改ページは入れない）
        allBlocks.push({ type: "paragraph", text: "" });
      }
      allBlocks.push(...blocks);
    }

    if (!anyTextFound) {
      throw new Error(
        "このPDFから文字情報を抽出できませんでした。スキャンした画像のPDFの可能性があります（画像PDFのWord変換は今回のバージョンでは未対応です。OCRツールでのテキスト化をお試しください）。"
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
