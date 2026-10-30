import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFObject } from "pdf-lib";
import { BrowserProcessor, type PdfProcessorOutput } from "../types";
import { canvasToBlob } from "./image";
import { loadPdfDoc } from "./pdf";
import { loadPdfDocument } from "@/lib/pdf/pdfjs-client";
import {
  REDACT_COLOR,
  RedactError,
  regionToPixelRect,
  renderScaleFor,
  validateRedactPlan,
  type RedactRegion,
} from "@/lib/pdf/redact";

/**
 * PDF黒塗り・墨消し（ブラウザ内だけで処理する。ファイルは外部に送らず、元のファイルも書き換えない）。
 *
 * 範囲を指定したページは、ページ全体を画像にして、範囲を黒で塗りつぶし、画像だけのページとして新しいPDFに入れる。
 * 元のページの文字・画像・図形は、新しいPDFに入れない（元のデータが黒い四角形の下に残る方式は使わない）。
 * 範囲を指定しなかったページは元のまま新しいPDFへ移す（リンク・注釈などは、他のページを参照して
 * 元のページを持ち込んでしまうのを防ぐため、取り除く）。
 * 書き出したあと、新しいPDFを開き直して、黒塗りしたページに文字が残っていないことを確認する。
 */

export interface PdfRedactInput {
  file: File;
  regions: RedactRegion[];
}

export interface PdfRedactOutput extends PdfProcessorOutput {
  /** 画像にして黒塗りしたページ（0始まり） */
  redactedPages: number[];
  regionCount: number;
}

/** 元のページから引き継がない項目（他のページや外部を参照して、黒塗りしたページのデータを持ち込む可能性があるもの） */
const DROPPED_PAGE_KEYS = ["Annots", "B", "Thumb", "PieceInfo", "AA"];

function sourceUnreadableMessage(fileName: string): string {
  return `${fileName} の読み込みに失敗しました。PDFファイルが破損している可能性があります。`;
}

export class PdfRedactProcessor extends BrowserProcessor<PdfRedactInput, PdfRedactOutput> {
  async process({ file, regions }: PdfRedactInput): Promise<PdfRedactOutput> {
    // 読み込み（パスワード付き・破損したPDFは、ここで分かりやすいエラーになる）
    const view = await loadPdfDocument(file);
    const pageCount = view.numPages;
    const grouped = validateRedactPlan(pageCount, regions);
    const source = await loadPdfDoc(file, { updateMetadata: false });
    if (source.getPageCount() !== pageCount) throw new RedactError(sourceUnreadableMessage(file.name));

    // 引き継がない項目は、コピーする前に元のページ（メモリ上の複製）から取り除く。
    // コピーしてから取り除くと、リンクの行き先として、黒塗りするページ（の文字）がコピーに巻き込まれる。
    for (const page of source.getPages()) {
      for (const key of DROPPED_PAGE_KEYS) page.node.delete(PDFName.of(key));
    }

    const out = await PDFDocument.create();
    out.setProducer("Mr.Satto");
    out.setCreator("Mr.Satto");

    try {
      for (let index = 0; index < pageCount; index++) {
        const pageRegions = grouped.get(index);
        if (!pageRegions) {
          const [copied] = await out.copyPages(source, [index]);
          out.addPage(copied);
          continue;
        }

        const page = await view.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: renderScaleFor(base.width, base.height) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new RedactError("Canvasの初期化に失敗しました。ブラウザを更新してから、もう一度お試しください。");
        try {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          // 範囲を黒で塗りつぶす（画像の中のピクセルを置き換えるので、元の内容は画像に残らない）
          ctx.fillStyle = REDACT_COLOR;
          for (const region of pageRegions) {
            const rect = regionToPixelRect(region, canvas.width, canvas.height);
            if (rect.width > 0 && rect.height > 0) ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
          }
          const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
          const image = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
          const outPage = out.addPage([base.width, base.height]);
          outPage.drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
        } finally {
          // 画像のメモリをすぐに手放す
          canvas.width = 0;
          canvas.height = 0;
        }
        page.cleanup();
      }
    } finally {
      await view.destroy();
    }

    // どこからも参照されていないデータ（コピーの際に紛れ込んだ、黒塗りするページの一部など）は、念のため書き出さない
    pruneUnreachableObjects(out);
    const bytes = await out.save({ useObjectStreams: false });
    const redactedPages = [...grouped.keys()].sort((a, b) => a - b);
    await verifyRedactedOutput(bytes, pageCount, redactedPages);

    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    return {
      blob,
      url: URL.createObjectURL(blob),
      pageCount,
      sizeBytes: blob.size,
      redactedPages,
      regionCount: [...grouped.values()].reduce((sum, list) => sum + list.length, 0),
    };
  }
}

/**
 * 書き出したPDFを開き直して確認する（確認できなければ、ダウンロードさせずにエラーにする）。
 * - 開けること、ページ数が元と同じであること
 * - 黒塗りしたページに、文字が1つも残っていないこと（ページ全体が画像になっているため、文字は0のはず）
 */
async function verifyRedactedOutput(bytes: Uint8Array, pageCount: number, redactedPages: number[]): Promise<void> {
  const fail = () =>
    new RedactError("黒塗り後のPDFの確認に失敗したため、ファイルを作成しませんでした。もう一度お試しください。");
  const pdfjs = await (await import("@/lib/pdf/pdfjs-client")).getPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch {
    throw fail();
  }
  try {
    if (doc.numPages !== pageCount) throw fail();
    for (const index of redactedPages) {
      const page = await doc.getPage(index + 1);
      const content = await page.getTextContent();
      const hasText = content.items.some((item) => "str" in item && item.str.trim() !== "");
      page.cleanup();
      if (hasText) throw fail();
    }
  } finally {
    await doc.destroy();
  }
}

function collectRefs(value: PDFObject | undefined, found: PDFRef[]): void {
  if (!value) return;
  if (value instanceof PDFRef) found.push(value);
  else if (value instanceof PDFDict) for (const [, v] of value.entries()) collectRefs(v, found);
  else if (value instanceof PDFArray) for (let i = 0; i < value.size(); i++) collectRefs(value.get(i), found);
  else if (value instanceof PDFStream) collectRefs(value.dict, found);
}

/** 書き出すPDFのルート（文書カタログ・文書情報）から辿れないデータを、PDFから取り除く */
function pruneUnreachableObjects(doc: PDFDocument): void {
  const context = doc.context;
  const reachable = new Set<PDFRef>();
  const queue: PDFRef[] = [];
  const trailerRefs: PDFRef[] = [];
  collectRefs(context.trailerInfo.Root, trailerRefs);
  collectRefs(context.trailerInfo.Info, trailerRefs);
  queue.push(...trailerRefs);
  while (queue.length > 0) {
    const ref = queue.pop() as PDFRef;
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    const found: PDFRef[] = [];
    collectRefs(context.lookup(ref), found);
    queue.push(...found);
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) context.delete(ref);
  }
}
