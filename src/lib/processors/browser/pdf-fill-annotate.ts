import type { PDFFont, PDFPage } from "pdf-lib";
import { rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor, type PdfProcessorOutput } from "../types";
import { loadPdfDoc, finalizePdf } from "./pdf";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import {
  PDF_FILL_ANNOTATE_LIMITS,
  type AnnotationColor,
  type AnnotationObject,
} from "@/lib/pdf-annotate/types";

/**
 * PDF記入・注釈（Phase 15）の書き出しProcessor。
 *
 * 既存のPdfWatermarkProcessor（既存PDFを読み込み、日本語フォントを埋め込み、
 * 各ページに描画して書き出す）と同じ構成をそのまま踏襲する。新しいPDF
 * レンダリングライブラリ・新しい依存関係は一切追加せず、既存の pdf-lib /
 * loadJapaneseFontBytes / loadPdfDoc / finalizePdf のみで完結させている。
 *
 * 元のPDFオブジェクト(doc)は「読み込んで注釈を描き足す」だけで、
 * 既存ページの内容そのものは変更しない（ページを丸ごと差し替える、
 * 既存コンテンツを消す、といった操作は行わない）。
 */

export interface PdfFillAnnotateInput {
  file: File;
  objects: AnnotationObject[];
}

function toRgb(color: AnnotationColor) {
  return rgb(color.r, color.g, color.b);
}

/**
 * 英数字混在のテキストを1文字ずつ描画する（src/lib/forms/template-renderer.ts の
 * drawTextRobust と同じ対処。実機検証済みの「英字+数字が連続する文字列で
 * PDFのテキスト情報が化ける」不具合を避けるため、この帳票以外のテキスト
 * 描画でも同じ対処を必ず適用する）。
 *
 * 太字は、Noto Sans JPのBold版フォントファイルが本プロジェクトに存在しない
 * ため（/public/fonts/ にはRegularのみ）、新たに5MB超のフォント資産を
 * 追加導入することは「新規依存・アセットは最小限に」の方針に反すると判断し、
 * ごくわずかに右へずらして2回描画する疑似太字（faux bold）で代替する。
 */
function drawTextRobust(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number,
  color: AnnotationColor,
  bold: boolean
) {
  let cx = x;
  const boldOffset = bold ? Math.max(0.35, size * 0.018) : 0;
  for (const ch of Array.from(text)) {
    page.drawText(ch, { x: cx, y, size, font, color: toRgb(color) });
    if (bold) {
      page.drawText(ch, { x: cx + boldOffset, y, size, font, color: toRgb(color) });
    }
    cx += font.widthOfTextAtSize(ch, size);
  }
}

function drawCheckbox(page: PDFPage, x: number, y: number, size: number, checked: boolean) {
  const borderWidth = Math.max(1, size * 0.06);
  page.drawRectangle({
    x,
    y,
    width: size,
    height: size,
    borderColor: rgb(0.25, 0.25, 0.28),
    borderWidth,
  });
  if (!checked) return;
  const pad = size * 0.2;
  const thickness = Math.max(1.5, size * 0.12);
  const color = rgb(0.1, 0.4, 0.85);
  // チェックマーク（レ点）をNoto Sans JPのグリフに依存せず、2本の直線で描く
  // （フォント側のチェックマーク用グリフ有無を気にしなくてよく、表示もシンプルになる）。
  page.drawLine({
    start: { x: x + pad, y: y + size * 0.48 },
    end: { x: x + size * 0.42, y: y + pad },
    thickness,
    color,
  });
  page.drawLine({
    start: { x: x + size * 0.42, y: y + pad },
    end: { x: x + size - pad, y: y + size - pad },
    thickness,
    color,
  });
}

function drawInkStroke(page: PDFPage, obj: Extract<AnnotationObject, { type: "ink" }>) {
  const color = toRgb(obj.color);
  if (obj.points.length === 0) return;
  if (obj.points.length === 1) {
    const p = obj.points[0];
    page.drawEllipse({ x: p.x, y: p.y, xScale: obj.strokeWidth / 2, yScale: obj.strokeWidth / 2, color });
    return;
  }
  for (let i = 1; i < obj.points.length; i++) {
    page.drawLine({
      start: obj.points[i - 1],
      end: obj.points[i],
      thickness: obj.strokeWidth,
      color,
    });
  }
}

export class PdfFillAnnotateProcessor extends BrowserProcessor<PdfFillAnnotateInput, PdfProcessorOutput> {
  async process({ file, objects }: PdfFillAnnotateInput): Promise<PdfProcessorOutput> {
    if (objects.length > PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument) {
      throw new Error(
        `配置できる注釈の数は${PDF_FILL_ANNOTATE_LIMITS.maxObjectsPerDocument}個までです。数を減らしてから再度お試しください。`
      );
    }

    const doc = await loadPdfDoc(file);
    const pageCount = doc.getPageCount();
    if (pageCount === 0) {
      throw new Error("このPDFにはページがありません");
    }

    const needsFont = objects.some((o) => o.type === "text" && o.text.trim() !== "");
    let font: PDFFont | null = null;
    if (needsFont) {
      let fontBytes: ArrayBuffer;
      try {
        fontBytes = await loadJapaneseFontBytes();
      } catch {
        throw new Error(
          "日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。"
        );
      }
      try {
        doc.registerFontkit(fontkit);
        font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
      } catch {
        throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
      }
    }

    // 元のページ数・既存コンテンツはそのまま。範囲外のページを指す注釈は
    // （通常UIからは発生しないが、念のため）安全に無視する。
    for (const obj of objects) {
      if (!Number.isInteger(obj.page) || obj.page < 1 || obj.page > pageCount) continue;
      const page = doc.getPage(obj.page - 1);

      if (obj.type === "text") {
        const text = obj.text.trim();
        if (text === "" || !font) continue;
        try {
          drawTextRobust(page, font, obj.text, obj.x, obj.y, obj.fontSize, obj.color, obj.bold);
        } catch {
          // 1件の描画失敗で全体を止めない（他の注釈は正常に書き出す）
          continue;
        }
      } else if (obj.type === "checkbox") {
        try {
          drawCheckbox(page, obj.x, obj.y, obj.size, obj.checked);
        } catch {
          continue;
        }
      } else if (obj.type === "ink") {
        try {
          drawInkStroke(page, obj);
        } catch {
          continue;
        }
      } else if (obj.type === "image") {
        try {
          const image =
            obj.mimeType === "image/png" ? await doc.embedPng(obj.bytes) : await doc.embedJpg(obj.bytes);
          page.drawImage(image, { x: obj.x, y: obj.y, width: obj.width, height: obj.height });
        } catch {
          // 1枚の画像埋め込み失敗で全体を止めない（他人の写真云々ではなく単純に破損データ対策）
          continue;
        }
      }
    }

    return finalizePdf(doc);
  }
}
