import { PDFDocument, degrees as pdfDegrees } from "pdf-lib";
import { BrowserProcessor, type PdfProcessorOutput, type NamedFileOutput } from "../types";
import { loadImage, canvasToBlob } from "./image";
import { stripExtension } from "@/lib/utils/format";

/**
 * PDF系Processor（Phase 2-A）。
 *
 * すべてブラウザ上で完結する（pdf-lib はWASM/ネイティブ依存を持たない
 * 純粋なJavaScript実装のため、ファイルは外部に送信されない）。
 * 画像→PDF変換では、画像の読み込み・Canvas変換に image.ts の
 * loadImage/canvasToBlob を再利用し、処理ロジックの重複を避けている。
 */

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

function zeroPad(n: number, totalDigits: number): string {
  return String(n).padStart(totalDigits, "0");
}

/**
 * PDFファイルを読み込む。破損・パスワード保護のケースを
 * ユーザーに分かりやすいメッセージへ変換する。
 */
async function loadPdfDoc(file: File): Promise<PDFDocument> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error("ファイルの読み込みに失敗しました");
  }
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: false });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const message = e instanceof Error ? e.message : "";
    if (name === "EncryptedPDFError" || /encrypt/i.test(message)) {
      throw new Error(
        "パスワード保護されたPDFは処理できません。パスワードを解除してから再度お試しください。"
      );
    }
    throw new Error(
      `${file.name} の読み込みに失敗しました。PDFファイルが破損している可能性があります。`
    );
  }
}

async function finalizePdf(doc: PDFDocument): Promise<PdfProcessorOutput> {
  const bytes = await doc.save();
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  return {
    blob,
    url: URL.createObjectURL(blob),
    pageCount: doc.getPageCount(),
    sizeBytes: blob.size,
  };
}

/** ページ数を確認するためだけの軽量ヘルパー（UI側のページ一覧表示に使う） */
export async function getPdfPageCount(file: File): Promise<number> {
  const doc = await loadPdfDoc(file);
  return doc.getPageCount();
}

// ---------------------------------------------------------------------------
// PDF結合
// ---------------------------------------------------------------------------
export interface PdfMergeInput {
  /** 結合する順序 = 配列の順序 */
  files: File[];
}

export class PdfMergeProcessor extends BrowserProcessor<PdfMergeInput, PdfProcessorOutput> {
  async process({ files }: PdfMergeInput) {
    if (files.length < 2) {
      throw new Error("結合するには2つ以上のPDFファイルを選択してください");
    }
    const merged = await PDFDocument.create();
    for (const file of files) {
      const src = await loadPdfDoc(file);
      if (src.getPageCount() === 0) {
        throw new Error(`${file.name} にはページがないため結合できません`);
      }
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach((page) => merged.addPage(page));
    }
    return finalizePdf(merged);
  }
}

// ---------------------------------------------------------------------------
// PDF分割
// ---------------------------------------------------------------------------
export type PdfSplitInput =
  | { file: File; mode: "each-page" }
  | { file: File; mode: "range"; ranges: { start: number; end: number }[] };

export class PdfSplitProcessor extends BrowserProcessor<PdfSplitInput, NamedFileOutput[]> {
  async process(input: PdfSplitInput): Promise<NamedFileOutput[]> {
    const src = await loadPdfDoc(input.file);
    const totalPages = src.getPageCount();
    if (totalPages === 0) {
      throw new Error("このPDFにはページがないため分割できません");
    }
    const base = stripExtension(input.file.name);

    if (input.mode === "each-page") {
      const pad = String(totalPages).length;
      const outputs: NamedFileOutput[] = [];
      for (let i = 0; i < totalPages; i++) {
        const out = await PDFDocument.create();
        const [page] = await out.copyPages(src, [i]);
        out.addPage(page);
        const bytes = await out.save();
        const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
        outputs.push({
          blob,
          suggestedName: `${base}-${zeroPad(i + 1, pad)}.pdf`,
          sizeBytes: blob.size,
        });
      }
      return outputs;
    }

    // range モード
    if (input.ranges.length === 0) {
      throw new Error("分割するページ範囲を指定してください");
    }
    const outputs: NamedFileOutput[] = [];
    for (const range of input.ranges) {
      if (
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        range.start < 1 ||
        range.end < range.start ||
        range.end > totalPages
      ) {
        throw new Error(
          `ページ範囲の指定が正しくありません（1〜${totalPages}の範囲で指定してください）`
        );
      }
      const indices = [];
      for (let p = range.start; p <= range.end; p++) indices.push(p - 1);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, indices);
      copied.forEach((page) => out.addPage(page));
      const bytes = await out.save();
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
      outputs.push({
        blob,
        suggestedName:
          range.start === range.end
            ? `${base}-p${range.start}.pdf`
            : `${base}-p${range.start}-${range.end}.pdf`,
        sizeBytes: blob.size,
      });
    }
    return outputs;
  }
}

// ---------------------------------------------------------------------------
// PDFページ削除
// ---------------------------------------------------------------------------
export interface PdfDeletePagesInput {
  file: File;
  /** 削除するページ番号（1始まり） */
  pagesToDelete: number[];
}

export class PdfDeletePagesProcessor extends BrowserProcessor<
  PdfDeletePagesInput,
  PdfProcessorOutput
> {
  async process({ file, pagesToDelete }: PdfDeletePagesInput) {
    const src = await loadPdfDoc(file);
    const totalPages = src.getPageCount();
    if (totalPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    const uniqueValid = Array.from(new Set(pagesToDelete)).filter(
      (p) => Number.isInteger(p) && p >= 1 && p <= totalPages
    );
    if (uniqueValid.length === 0) {
      throw new Error("削除するページを選択してください");
    }
    if (uniqueValid.length >= totalPages) {
      throw new Error(
        "すべてのページを削除することはできません。少なくとも1ページは残してください"
      );
    }
    const deleteSet = new Set(uniqueValid);
    const keepIndices = src.getPageIndices().filter((idx) => !deleteSet.has(idx + 1));
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, keepIndices);
    copied.forEach((page) => out.addPage(page));
    return finalizePdf(out);
  }
}

// ---------------------------------------------------------------------------
// PDFページ並び替え
// ---------------------------------------------------------------------------
export interface PdfReorderPagesInput {
  file: File;
  /** 新しいページ順序（1始まりのページ番号の並び。totalPages分すべて必要） */
  newOrder: number[];
}

export class PdfReorderPagesProcessor extends BrowserProcessor<
  PdfReorderPagesInput,
  PdfProcessorOutput
> {
  async process({ file, newOrder }: PdfReorderPagesInput) {
    const src = await loadPdfDoc(file);
    const totalPages = src.getPageCount();
    if (totalPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    const isValidPermutation =
      newOrder.length === totalPages &&
      new Set(newOrder).size === totalPages &&
      newOrder.every((p) => Number.isInteger(p) && p >= 1 && p <= totalPages);
    if (!isValidPermutation) {
      throw new Error("ページの並び順が正しくありません");
    }
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      src,
      newOrder.map((p) => p - 1)
    );
    copied.forEach((page) => out.addPage(page));
    return finalizePdf(out);
  }
}

// ---------------------------------------------------------------------------
// PDF回転
// ---------------------------------------------------------------------------
export interface PdfRotateInput {
  file: File;
  rotateBy: 90 | 180 | 270;
  /** 未指定または空配列なら全ページを回転する */
  pageNumbers?: number[];
}

export class PdfRotateProcessor extends BrowserProcessor<PdfRotateInput, PdfProcessorOutput> {
  async process({ file, rotateBy, pageNumbers }: PdfRotateInput) {
    const doc = await loadPdfDoc(file);
    const totalPages = doc.getPageCount();
    if (totalPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    const targets =
      pageNumbers && pageNumbers.length > 0
        ? Array.from(new Set(pageNumbers)).filter(
            (p) => Number.isInteger(p) && p >= 1 && p <= totalPages
          )
        : doc.getPageIndices().map((i) => i + 1);
    if (targets.length === 0) {
      throw new Error("回転するページを選択してください");
    }
    const pages = doc.getPages();
    for (const pageNumber of targets) {
      const page = pages[pageNumber - 1];
      const current = page.getRotation().angle;
      page.setRotation(pdfDegrees((current + rotateBy) % 360));
    }
    return finalizePdf(doc);
  }
}

// ---------------------------------------------------------------------------
// 画像 → PDF
// ---------------------------------------------------------------------------
async function toEmbeddableImage(
  file: File
): Promise<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }> {
  if (file.type === "image/png" || file.type === "image/jpeg") {
    return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type };
  }
  // WebP等、pdf-libが直接埋め込めない形式はCanvas経由でPNGへ変換してから埋め込む
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  ctx.drawImage(img, 0, 0);
  const blob = await canvasToBlob(canvas, "image/png");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: "image/png" };
}

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

export interface ImageToPdfInput {
  /** PDFに追加する順序 = 配列の順序 */
  files: File[];
  /** "fit" = 画像サイズそのままの1ページ / "a4" = A4中央配置 */
  pageSize?: "fit" | "a4";
}

export class ImagesToPdfProcessor extends BrowserProcessor<ImageToPdfInput, PdfProcessorOutput> {
  async process({ files, pageSize = "fit" }: ImageToPdfInput) {
    if (files.length === 0) {
      throw new Error("PDF化する画像を選択してください");
    }
    const doc = await PDFDocument.create();
    for (const file of files) {
      let embeddable: { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" };
      try {
        embeddable = await toEmbeddableImage(file);
      } catch {
        throw new Error(`${file.name} の読み込みに失敗しました`);
      }
      const image =
        embeddable.mimeType === "image/png"
          ? await doc.embedPng(embeddable.bytes)
          : await doc.embedJpg(embeddable.bytes);

      if (pageSize === "a4") {
        const page = doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
        const scale = Math.min(A4_WIDTH_PT / image.width, A4_HEIGHT_PT / image.height, 1);
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, {
          x: (A4_WIDTH_PT - w) / 2,
          y: (A4_HEIGHT_PT - h) / 2,
          width: w,
          height: h,
        });
      } else {
        const page = doc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      }
    }
    return finalizePdf(doc);
  }
}
