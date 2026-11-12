import type { PDFFont } from "pdf-lib";
import type * as PdfLibTypes from "pdf-lib";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";
import { loadImage } from "./image";
import {
  hexToRgb01,
  layoutPostcardImage,
  layoutPostcardText,
  postcardSizePt,
  validatePostcard,
  type PostcardImage,
  type PostcardOrientation,
  type PostcardText,
} from "@/lib/print/postcard-layout";
import {
  layoutPostcardAddress,
  postcardAddressSizePt,
  validatePostcardAddress,
  type PostcardAddressInput,
} from "@/lib/print/postcard-address-layout";

/**
 * ハガキ作成 Processor（次期機能追加 1）。
 *
 * はがき（100mm × 148mm）1枚分のPDFを作る。配置の計算は src/lib/print/postcard-layout.ts にまとめ、画面のプレビューと共通にしている。
 * - 文字：封筒宛名・帳票と同じ日本語フォント（loadJapaneseFontBytes）を埋め込み、文字のまま書き出す（拡大しても粗くならない）。
 * - 画像：ブラウザで一度読み込んでから書き出し直して埋め込む。写真の向きの情報（スマホで撮った縦の写真など）は、
 *   ブラウザが反映した向きのまま使う（PDFに元のJPEGをそのまま入れると、向きの情報が無視されて横倒しになることがあるため）。
 *   透明な部分がある画像（PNG）はPNG、それ以外はJPEGにする。とても大きな画像は、長い辺を3000pxまでに縮めてから入れる。
 * - 用紙の大きさのPDFにするので、印刷するときは用紙を「はがき」、倍率を「実際のサイズ（100%）」にすれば、配置どおりに印刷できる。
 * 処理はすべてブラウザの中で行い、ファイルは送信しない。
 */

export interface PostcardInputImage extends PostcardImage {
  file: File;
}

export interface PostcardInput {
  orientation: PostcardOrientation;
  texts: PostcardText[];
  images: PostcardInputImage[];
}

export interface PostcardOutput {
  blob: Blob;
}

const MAX_IMAGE_SIDE = 3000;

/** 画像を、PDFに入れられる形（向きを反映したJPEGかPNG）にする */
async function prepareImage(file: File): Promise<{ bytes: Uint8Array; png: boolean }> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    throw new Error(`${file.name} を画像として読み込めませんでした。JPG・PNG・WebPなどの画像を選んでください。`);
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像の準備に失敗しました。");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const png = file.type === "image/png" || /\.png$/i.test(file.name);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, png ? "image/png" : "image/jpeg", 0.92));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("画像の準備に失敗しました。");
  return { bytes: new Uint8Array(await blob.arrayBuffer()), png };
}

export class PostcardProcessor extends BrowserProcessor<PostcardInput, PostcardOutput> {
  async process({ orientation, texts, images }: PostcardInput): Promise<PostcardOutput> {
    const problem = validatePostcard(texts, images);
    if (problem) throw new Error(problem);
    await ensurePdfLib({ fontkit: true });
    const page = postcardSizePt(orientation);
    const usedTexts = texts.filter((t) => t.text.trim() !== "");

    let doc: PdfLibTypes.PDFDocument;
    let font: PDFFont | null = null;
    try {
      doc = await pdfLib().PDFDocument.create();
      if (usedTexts.length > 0) {
        let fontBytes: ArrayBuffer;
        try {
          fontBytes = await loadJapaneseFontBytes();
        } catch {
          throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
        }
        doc.registerFontkit(fontkitLib());
        font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("日本語フォント")) throw e;
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }
    doc.setTitle("はがき");
    const pdfPage = doc.addPage([page.width, page.height]);

    // 画像（下）→ 文字（上）の順に描く（プレビューと同じ重なり）
    for (const img of images) {
      const { bytes, png } = await prepareImage(img.file);
      const embedded = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const box = layoutPostcardImage(img, page);
      pdfPage.drawImage(embedded, { x: box.x, y: page.height - box.y - box.height, width: box.width, height: box.height });
    }
    if (font) {
      for (const t of usedTexts) {
        const color = pdfLib().rgb(...hexToRgb01(t.color));
        for (const line of layoutPostcardText(t, page)) {
          if (line.text === "") continue;
          const w = font.widthOfTextAtSize(line.text, t.size);
          pdfPage.drawText(line.text, { x: line.x - w / 2, y: page.height - line.baseline, size: t.size, font, color });
        }
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    return { blob: new Blob([new Uint8Array(bytes)], { type: "application/pdf" }) };
  }
}

/**
 * ハガキ作成・宛名面（総合改修 28）。
 * 配置の計算（郵便番号枠・宛先住所・宛先氏名・差出人）は src/lib/print/postcard-address-layout.ts にまとめ、プレビューと共通にしている。
 * 文字は日本語フォントを埋め込み、1文字ずつ中央揃えで縦に並べる。郵便番号枠の線は、選んだときだけ朱色で描く。
 */
export class PostcardAddressProcessor extends BrowserProcessor<PostcardAddressInput, PostcardOutput> {
  async process(input: PostcardAddressInput): Promise<PostcardOutput> {
    const problem = validatePostcardAddress(input);
    if (problem) throw new Error(problem);
    await ensurePdfLib({ fontkit: true });
    const page = postcardAddressSizePt();
    const ops = layoutPostcardAddress(input);
    let doc: PdfLibTypes.PDFDocument;
    let font: PDFFont;
    try {
      doc = await pdfLib().PDFDocument.create();
      let fontBytes: ArrayBuffer;
      try {
        fontBytes = await loadJapaneseFontBytes();
      } catch {
        throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
      }
      doc.registerFontkit(fontkitLib());
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("日本語フォント")) throw e;
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }
    doc.setTitle("はがき 宛名面");
    const pdfPage = doc.addPage([page.width, page.height]);
    const black = pdfLib().rgb(0, 0, 0);
    const vermilion = pdfLib().rgb(0.9, 0.25, 0.15); // 郵便番号枠の色（朱色）
    for (const op of ops) {
      if (op.kind === "rect") {
        // 四角は「枠線の内側」の大きさ。線の太さの半分だけ外側に広げて描く
        const half = op.lineWidth / 2;
        pdfPage.drawRectangle({
          x: op.x - half,
          y: page.height - op.y - op.height - half,
          width: op.width + op.lineWidth,
          height: op.height + op.lineWidth,
          borderColor: vermilion,
          borderWidth: op.lineWidth,
        });
      } else if (op.kind === "line") {
        pdfPage.drawLine({ start: { x: op.x1, y: page.height - op.y1 }, end: { x: op.x2, y: page.height - op.y2 }, thickness: op.lineWidth, color: vermilion });
      } else {
        const w = font.widthOfTextAtSize(op.text, op.size);
        pdfPage.drawText(op.text, { x: op.x - w / 2, y: page.height - op.y, size: op.size, font, color: black });
      }
    }
    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    return { blob: new Blob([new Uint8Array(bytes)], { type: "application/pdf" }) };
  }
}
