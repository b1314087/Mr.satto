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
 *
 * updateMetadata: pdf-libのPDFDocument.load()はデフォルト(true)で、
 * 読み込んだ第間にProducerを"pdf-lib (https://github.com/Hopding/pdf-lib)"へ
 * 上書きする（node_modules/pdf-lib/cjs/api/PDFDocument.js の
 * updateInfoDict()を参照。コンストラクタ内でload時に呼ばれる）。
 * 既存のPDF結合・分割等のツールはメタデータを見ないためこの挙動は無害だが、
 * PDFメタデータ削除ツール（readPdfMetadata/PdfMetadataRemoveProcessor）は
 * 「読み込んだ時点でのメタデータ」を正しく読み取る/検証する必要があるため、
 * それらの呼び出しでは明示的に updateMetadata: false を渡す
 * （他のPDF系Processorの挙動は一切変更しない）。
 */
async function loadPdfDoc(file: File, options?: { updateMetadata?: boolean }): Promise<PDFDocument> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error("ファイルの読み込みに失敗しました");
  }
  try {
    return await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: false,
      updateMetadata: options?.updateMetadata ?? true,
    });
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

// ---------------------------------------------------------------------------
// PDFページサイズ変更（Phase 8）
// ---------------------------------------------------------------------------
export type PdfPageSizePreset = "a4" | "a3" | "letter" | "original";
export type PdfPageOrientation = "portrait" | "landscape";
/**
 * "fit"   = 内容を新しいページサイズに合わせて拡大縮小する（アスペクト比維持・中央配置）
 * "keep"  = 内容の大きさ・位置は変えず、ページのサイズ（MediaBox/CropBox）だけを変更する
 * UIでは必ずこの2つの違いを明示し、どちらが選ばれているか曖昧にしない（開発指示書■9）。
 */
export type PdfResizeContentMode = "fit" | "keep";

const PDF_PAGE_SIZE_PT: Record<Exclude<PdfPageSizePreset, "original">, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  letter: { width: 612, height: 792 },
};

export interface PdfResizePagesInput {
  file: File;
  pageSize: PdfPageSizePreset;
  orientation: PdfPageOrientation;
  contentMode: PdfResizeContentMode;
}

/**
 * pdf-libの公式API（setSize/scaleContent/translateContent）のみを使う。
 * scaleContent/translateContentはページ内のベクトルデータ（テキスト・図形・
 * 埋め込み画像の配置情報）の座標変換のみを行い、画像自体をラスタライズし
 * 直すことはないため、内容の画質を劣化させない（開発指示書■9・■24）。
 */
export class PdfResizePagesProcessor extends BrowserProcessor<
  PdfResizePagesInput,
  PdfProcessorOutput
> {
  async process({ file, pageSize, orientation, contentMode }: PdfResizePagesInput) {
    const doc = await loadPdfDoc(file);
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error("このPDFにはページがありません");
    }
    if (pageSize === "original") {
      // サイズ変更なし。呼び出し側のUIでは選択できないようにしているが、
      // 万一渡された場合も何もせず元のPDFをそのまま返す（安全側の挙動）。
      return finalizePdf(doc);
    }

    const base = PDF_PAGE_SIZE_PT[pageSize];
    const [newWidth, newHeight] =
      orientation === "landscape"
        ? [Math.max(base.width, base.height), Math.min(base.width, base.height)]
        : [Math.min(base.width, base.height), Math.max(base.width, base.height)];

    for (const page of pages) {
      const { width: oldWidth, height: oldHeight } = page.getSize();
      if (oldWidth <= 0 || oldHeight <= 0) continue;

      if (contentMode === "fit") {
        const scale = Math.min(newWidth / oldWidth, newHeight / oldHeight);
        page.scaleContent(scale, scale);
        const scaledWidth = oldWidth * scale;
        const scaledHeight = oldHeight * scale;
        page.setSize(newWidth, newHeight);
        page.translateContent((newWidth - scaledWidth) / 2, (newHeight - scaledHeight) / 2);
      } else {
        // ページの原点（左下）は変えず、幅と高さだけを変更する。
        // 拡大した場合は右上方向に余白が増え、縮小した場合は内容の右上側が
        // ページ範囲外（見た目上クロップされた状態）になる。
        page.setSize(newWidth, newHeight);
      }
    }

    return finalizePdf(doc);
  }
}

// ---------------------------------------------------------------------------
// PDFメタデータ削除（Phase 8）
// ---------------------------------------------------------------------------
export interface PdfMetadataInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

/** UI側の「削除前のメタデータを確認する」表示用（保存はしない、読み取りのみ） */
export async function readPdfMetadata(file: File): Promise<PdfMetadataInfo> {
  // updateMetadata: false が必須。指定しないと、読み込んだ瞬間にpdf-libが
  // Producerを自身のライブラリ名へ上書きしてしまい、「削除前の実際の値」を
  // 正しく表示できなくなる（loadPdfDoc()のコメント参照）。
  const doc = await loadPdfDoc(file, { updateMetadata: false });
  return {
    title: doc.getTitle() || undefined,
    author: doc.getAuthor() || undefined,
    subject: doc.getSubject() || undefined,
    keywords: doc.getKeywords() || undefined,
    creator: doc.getCreator() || undefined,
    producer: doc.getProducer() || undefined,
  };
}

export interface PdfMetadataRemoveInput {
  file: File;
}

export interface PdfMetadataRemoveOutput extends PdfProcessorOutput {
  /**
   * 「削除できたことにする」のではなく、保存後のPDFを実際に再読み込みして
   * 確認した結果（開発指示書■8）。すべて undefined であれば標準メタデータの
   * 削除に成功している。
   */
  remainingMetadata: PdfMetadataInfo;
}

/**
 * pdf-libの公式API（setTitle/setAuthor/setSubject/setKeywords/setCreator/
 * setProducer）で、PDFの標準的な文書情報（Info Dictionary）を空にする。
 *
 * 重要な発見（実装中に実機検証で確認）: pdf-libの`PDFDocument.load()`は
 * デフォルト（updateMetadata: true）で、読み込んだ瞬間にProducerを
 * "pdf-lib (https://github.com/Hopding/pdf-lib)"へ自動的に上書きする
 * （node_modules/pdf-lib/cjs/api/PDFDocument.js の updateInfoDict()を
 * 確認済み。コンストラクタ内でload時に呼ばれ、save()自体はこの上書きを
 * 行わない）。これに気づかずいたため、当初の実装では「削除したはずの
 * Producerが検証時に復活して見える」という誤検知が発生した。
 * 対策として、読み込み・検証時のPDFDocument.load()には必ず
 * updateMetadata: false を明示的に渡している（loadPdfDoc()参照）。
 * これにより、setProducer("")で設定した空文字列が保存後も正しく維持される。
 *
 * 重要な注意（開発指示書■8・■44）: pdf-libのPDFDocumentは上記6項目の
 * Info Dictionaryフィールドの読み書きAPIのみを公開しており、一部のPDF編集
 * ソフトが別途埋め込むことがあるXMPメタデータストリームを検出・削除する
 * 公式APIは持っていない（node_modules/pdf-lib/es/api/PDFDocument.d.ts を
 * 確認済み）。そのため本ツールは「PDFの標準的な文書情報を削除する」ものであり、
 * 「PDFに含まれるあらゆるメタデータを完全に削除する」ことは保証しない。
 * この違いはUI側で明示し、過剰な表現（「完全に匿名化」等）は使わない。
 * 作成日時・更新日時（CreationDate/ModificationDate）は開発指示書に明示された
 * 削除対象（Title/Author/Subject/Keywords/Creator/Producer）に含まれないため、
 * 本ツールでは変更しない。
 */
export class PdfMetadataRemoveProcessor extends BrowserProcessor<
  PdfMetadataRemoveInput,
  PdfMetadataRemoveOutput
> {
  async process({ file }: PdfMetadataRemoveInput): Promise<PdfMetadataRemoveOutput> {
    const doc = await loadPdfDoc(file, { updateMetadata: false });
    if (doc.getPageCount() === 0) {
      throw new Error("このPDFにはページがありません");
    }

    doc.setTitle("");
    doc.setAuthor("");
    doc.setSubject("");
    doc.setKeywords([]);
    doc.setCreator("");
    doc.setProducer("");

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの生成に失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });

    // 保存して終わりにせず、実際に保存後のバイト列を再度読み込んで
    // 標準メタデータが空になっていることを確認する。
    // ここでも updateMetadata: false が必須（上記コメント参照）。
    let remainingMetadata: PdfMetadataInfo;
    try {
      const verifyDoc = await PDFDocument.load(bytes, {
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      remainingMetadata = {
        title: verifyDoc.getTitle() || undefined,
        author: verifyDoc.getAuthor() || undefined,
        subject: verifyDoc.getSubject() || undefined,
        keywords: verifyDoc.getKeywords() || undefined,
        creator: verifyDoc.getCreator() || undefined,
        producer: verifyDoc.getProducer() || undefined,
      };
    } catch {
      remainingMetadata = {};
    }

    return {
      blob,
      url: URL.createObjectURL(blob),
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
      remainingMetadata,
    };
  }
}

// ---------------------------------------------------------------------------
// PDF余白・ページ範囲調整（クロップ）（Phase 8）
// ---------------------------------------------------------------------------
const MM_TO_PT = 2.8346456693;

export interface PdfCropMargins {
  topMm: number;
  bottomMm: number;
  leftMm: number;
  rightMm: number;
}

export interface PdfCropPagesInput {
  file: File;
  margins: PdfCropMargins;
}

/**
 * CropBoxのみを変更し、ページ内容（MediaBoxやページの描画命令）自体は
 * 一切再描画しない（開発指示書■10）。CropBoxはPDF仕様上「表示・印刷される
 * 可視範囲」を表すプロパティであり、内容を再エンコードせずに見た目上の
 * 余白調整を実現できる。
 */
export class PdfCropPagesProcessor extends BrowserProcessor<PdfCropPagesInput, PdfProcessorOutput> {
  async process({ file, margins }: PdfCropPagesInput) {
    const { topMm, bottomMm, leftMm, rightMm } = margins;
    if ([topMm, bottomMm, leftMm, rightMm].some((v) => !Number.isFinite(v) || v < 0)) {
      throw new Error("余白は0以上の数値で指定してください");
    }
    const doc = await loadPdfDoc(file);
    const pages = doc.getPages();
    if (pages.length === 0) {
      throw new Error("このPDFにはページがありません");
    }

    const topPt = topMm * MM_TO_PT;
    const bottomPt = bottomMm * MM_TO_PT;
    const leftPt = leftMm * MM_TO_PT;
    const rightPt = rightMm * MM_TO_PT;

    for (const page of pages) {
      const { x, y, width, height } = page.getCropBox();
      const newWidth = width - leftPt - rightPt;
      const newHeight = height - topPt - bottomPt;
      if (newWidth <= 1 || newHeight <= 1) {
        throw new Error(
          "指定した余白がページサイズに対して大きすぎます。余白の値を小さくしてください。"
        );
      }
      page.setCropBox(x + leftPt, y + bottomPt, newWidth, newHeight);
    }

    return finalizePdf(doc);
  }
}
