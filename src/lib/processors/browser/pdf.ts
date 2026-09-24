import { PDFDocument, StandardFonts, degrees as pdfDegrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor, type PdfProcessorOutput, type NamedFileOutput } from "../types";
import { loadImage, canvasToBlob } from "./image";
import { stripExtension } from "@/lib/utils/format";
import { parsePageSelection } from "@/lib/pdf/page-selection";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";

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
// PDF圧縮（Phase 2-B）
// ---------------------------------------------------------------------------
export interface PdfCompressInput {
  file: File;
}

export interface PdfCompressOutput {
  blob: Blob;
  url: string;
  originalSizeBytes: number;
  compressedSizeBytes: number;
  pageCount: number;
}

/**
 * PDF圧縮。
 *
 * 重要な注意（開発指示書■9・■24）: pdf-lib には埋め込み画像の
 * 再圧縮・ダウンサンプリング・不要フォントのサブセット化といった
 * 「本格的なPDF圧縮」の機能は無い。ここで行っているのは、
 * PDFの内部構造をオブジェクトストリームへまとめて再構築する
 * （save()の既定オプション useObjectStreams: true を明示指定）という
 * pdf-libの公開APIで可能な範囲の最適化のみである。
 *
 * そのため、画像が大半を占めるPDFなど、内部構造の再構築だけでは
 * サイズがほとんど変わらない（場合によっては微増する）PDFが
 * 一定数存在する。このProcessorは常に「元のサイズ」「処理後のサイズ」
 * を実測してそのまま返し、UI側で実際の数値のみを表示する。
 * 「必ず圧縮できる」「大幅に削減できる」という体裁を作らない。
 */
export class PdfCompressProcessor extends BrowserProcessor<PdfCompressInput, PdfCompressOutput> {
  async process({ file }: PdfCompressInput): Promise<PdfCompressOutput> {
    const doc = await loadPdfDoc(file);
    const originalSizeBytes = file.size;

    let bytes: Uint8Array;
    try {
      bytes = await doc.save({ useObjectStreams: true });
    } catch {
      throw new Error("PDFの圧縮処理に失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });

    return {
      blob,
      url: URL.createObjectURL(blob),
      originalSizeBytes,
      compressedSizeBytes: blob.size,
      pageCount: doc.getPageCount(),
    };
  }
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

// ---------------------------------------------------------------------------
// PDFページ抽出（Phase 6）
// ---------------------------------------------------------------------------
export interface PdfExtractPagesInput {
  file: File;
  /** "1,3,5-7" のようなページ指定文字列。指定順序を維持する */
  pageSelection: string;
}

export class PdfExtractPagesProcessor extends BrowserProcessor<
  PdfExtractPagesInput,
  PdfProcessorOutput
> {
  async process({ file, pageSelection }: PdfExtractPagesInput) {
    const src = await loadPdfDoc(file);
    const totalPages = src.getPageCount();
    if (totalPages === 0) {
      throw new Error("このPDFにはページがありません");
    }
    // parsePageSelectionが範囲・0ページ・逆順・不正文字列・重複を検証済みのエラーを投げる
    const pageNumbers = parsePageSelection(pageSelection, totalPages);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      src,
      pageNumbers.map((p) => p - 1)
    );
    copied.forEach((page) => out.addPage(page));
    return finalizePdf(out);
  }
}

// ---------------------------------------------------------------------------
// PDFページ番号追加（Phase 6）
// ---------------------------------------------------------------------------
export type PageNumberPosition = "bottom-left" | "bottom-center" | "bottom-right";

export interface PdfAddPageNumbersInput {
  file: File;
  /** 何番から数え始めるか（表示上の開始番号。1始まりが基本だが変更可能） */
  startNumber: number;
  position: PageNumberPosition;
  fontSize: number;
}

const PAGE_NUMBER_MARGIN = 24;

export class PdfAddPageNumbersProcessor extends BrowserProcessor<
  PdfAddPageNumbersInput,
  PdfProcessorOutput
> {
  async process({ file, startNumber, position, fontSize }: PdfAddPageNumbersInput) {
    if (!Number.isInteger(startNumber)) {
      throw new Error("開始番号は整数で指定してください");
    }
    if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 72) {
      throw new Error("フォントサイズは6〜72の範囲で指定してください");
    }
    const doc = await loadPdfDoc(file);
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error("このPDFにはページがありません");
    }

    // ページ番号は数字と "/" のみで構成されるため、日本語フォントの埋め込みは不要
    // （既存の帳票PDF生成と違い、追加のフォント取得を発生させない）。
    let font;
    try {
      font = await doc.embedFont(StandardFonts.Helvetica);
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    pages.forEach((page, index) => {
      const label = String(startNumber + index);
      const width = font.widthOfTextAtSize(label, fontSize);
      const { width: pageWidth } = page.getSize();
      let x: number;
      if (position === "bottom-left") {
        x = PAGE_NUMBER_MARGIN;
      } else if (position === "bottom-right") {
        x = pageWidth - PAGE_NUMBER_MARGIN - width;
      } else {
        x = (pageWidth - width) / 2;
      }
      page.drawText(label, {
        x,
        y: PAGE_NUMBER_MARGIN * 0.6,
        size: fontSize,
        font,
        color: rgb(0.3, 0.3, 0.32),
      });
    });

    return finalizePdf(doc);
  }
}

// ---------------------------------------------------------------------------
// PDF透かし（Phase 6）
// ---------------------------------------------------------------------------
export type WatermarkPosition = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface PdfWatermarkInput {
  file: File;
  text: string;
  /** 0〜1 */
  opacity: number;
  fontSize: number;
  position: WatermarkPosition;
  /** 度数（反時計回り） */
  rotation: number;
}

const WATERMARK_MARGIN = 32;

export class PdfWatermarkProcessor extends BrowserProcessor<PdfWatermarkInput, PdfProcessorOutput> {
  async process({ file, text, opacity, fontSize, position, rotation }: PdfWatermarkInput) {
    if (text.trim() === "") {
      throw new Error("透かしの文字を入力してください");
    }
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new Error("不透明度は0〜1の範囲で指定してください");
    }
    if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 200) {
      throw new Error("フォントサイズは6〜200の範囲で指定してください");
    }
    const doc = await loadPdfDoc(file);
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error("このPDFにはページがありません");
    }

    // 「CONFIDENTIAL」等の英数字だけでなく「社外秘」のような日本語も透かしに
    // 使えるよう、既存の帳票PDF生成と同じ日本語TrueTypeフォント(Noto Sans JP)を
    // 再利用する（新しいフォント資産は追加しない。subset:falseの理由は
    // document-pdf.tsのコメントを参照）。
    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error(
        "日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。"
      );
    }
    let font;
    try {
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    let width: number;
    try {
      width = font.widthOfTextAtSize(text, fontSize);
    } catch {
      throw new Error(
        "この文字は透かしとして描画できませんでした。別の文字列でお試しください。"
      );
    }
    const height = font.heightAtSize(fontSize);

    for (const page of pages) {
      const { width: pageWidth, height: pageHeight } = page.getSize();
      let x: number;
      let y: number;
      switch (position) {
        case "top-left":
          x = WATERMARK_MARGIN;
          y = pageHeight - WATERMARK_MARGIN - height;
          break;
        case "top-right":
          x = pageWidth - WATERMARK_MARGIN - width;
          y = pageHeight - WATERMARK_MARGIN - height;
          break;
        case "bottom-left":
          x = WATERMARK_MARGIN;
          y = WATERMARK_MARGIN;
          break;
        case "bottom-right":
          x = pageWidth - WATERMARK_MARGIN - width;
          y = WATERMARK_MARGIN;
          break;
        case "center":
        default:
          x = (pageWidth - width) / 2;
          y = (pageHeight - height) / 2;
          break;
      }
      try {
        page.drawText(text, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity,
          rotate: pdfDegrees(rotation),
        });
      } catch {
        throw new Error(
          "この文字は透かしとして描画できませんでした。別の文字列でお試しください。"
        );
      }
    }

    return finalizePdf(doc);
  }
}
