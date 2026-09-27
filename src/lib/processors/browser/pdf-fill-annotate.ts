import type { PDFFont, PDFPage } from "pdf-lib";
import { rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor, type PdfProcessorOutput } from "../types";
import { loadPdfDoc, finalizePdf } from "./pdf";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import {
  PDF_FILL_ANNOTATE_LIMITS,
  type AnnotationColor,
  type AnnotationObject,
  type ShapeAnnotationObject,
} from "@/lib/pdf-annotate/types";
import { rectPivotForCenterRotation } from "@/lib/pdf-annotate/geometry";

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
function drawTextLineRobust(
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

function measureLineWidth(font: PDFFont, text: string, size: number): number {
  let w = 0;
  for (const ch of Array.from(text)) w += font.widthOfTextAtSize(ch, size);
  return w;
}

/**
 * Phase 17: 複数行（\nで区切る）・左/中央/右揃えに対応したテキスト描画。
 * obj.yは（Phase 15と同じ意味で）最終行（一番下の行）のベースラインとして扱い、
 * それより上の行は行間ぶんだけyを積み増して描画する。
 */
function drawTextObject(page: PDFPage, font: PDFFont, obj: Extract<AnnotationObject, { type: "text" }>) {
  const lines = obj.text.split("\n");
  const lineHeight = obj.fontSize * 1.3;
  const align = obj.align ?? "left";
  const lineWidths = lines.map((l) => measureLineWidth(font, l, obj.fontSize));
  const boxWidth = obj.width ?? Math.max(...lineWidths, 0);
  const numLines = lines.length;
  lines.forEach((line, i) => {
    if (line === "") return;
    const lineY = obj.y + (numLines - 1 - i) * lineHeight;
    const lineWidth = lineWidths[i];
    let lineX = obj.x;
    if (align === "center") lineX = obj.x + Math.max(0, (boxWidth - lineWidth) / 2);
    else if (align === "right") lineX = obj.x + Math.max(0, boxWidth - lineWidth);
    drawTextLineRobust(page, font, line, lineX, lineY, obj.fontSize, obj.color, obj.bold);
  });
}

function drawCheckbox(
  page: PDFPage,
  x: number,
  y: number,
  size: number,
  checked: boolean,
  markStyle: "check" | "cross" | "circle" = "check"
) {
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
  if (markStyle === "circle") {
    // ○（丸）：フォント非依存、円で表現する
    page.drawEllipse({
      x: x + size / 2,
      y: y + size / 2,
      xScale: size / 2 - pad / 2,
      yScale: size / 2 - pad / 2,
      borderColor: color,
      borderWidth: thickness,
    });
    return;
  }
  if (markStyle === "cross") {
    // ×（バツ）：対角線2本
    page.drawLine({ start: { x: x + pad, y: y + pad }, end: { x: x + size - pad, y: y + size - pad }, thickness, color });
    page.drawLine({ start: { x: x + pad, y: y + size - pad }, end: { x: x + size - pad, y: y + pad }, thickness, color });
    return;
  }
  // check（レ点、既定）：Noto Sans JPのグリフに依存せず、2本の直線で描く
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

/**
 * Phase 17: 図形オブジェクト（矩形・円/楕円・直線）の描画。
 *
 * 矩形・円は「中心を軸に回転」させたいため rectPivotForCenterRotation() で
 * pdf-libに渡す軸点を補正する（円はpdf-lib自体が中心基準のため補正不要だが、
 * 関数はrotation=0のときx,yをそのまま素通しするため呼んでも問題ない）。
 * 直線はpdf-libのdrawLineにrotateオプションが無いため、UI側で既に回転後の
 * 座標（x1,y1,x2,y2）へ書き換え済みの値をそのまま使う。
 */
function drawShape(page: PDFPage, obj: ShapeAnnotationObject) {
  const color = toRgb(obj.color);
  if (obj.shapeKind === "line") {
    page.drawLine({
      start: { x: obj.x1, y: obj.y1 },
      end: { x: obj.x2, y: obj.y2 },
      thickness: obj.strokeWidth,
      color,
    });
    return;
  }
  if (obj.shapeKind === "rectangle") {
    const pivot = rectPivotForCenterRotation(obj.x, obj.y, obj.width, obj.height, obj.rotation);
    page.drawRectangle({
      x: pivot.x,
      y: pivot.y,
      width: obj.width,
      height: obj.height,
      rotate: degrees(obj.rotation),
      borderColor: color,
      borderWidth: obj.strokeWidth,
      color: obj.fill ? color : undefined,
    });
    return;
  }
  // circle / ellipse: pdf-libのdrawEllipseは(x,y)自体が中心なので、回転補正は不要
  const centerX = obj.x + obj.width / 2;
  const centerY = obj.y + obj.height / 2;
  page.drawEllipse({
    x: centerX,
    y: centerY,
    xScale: obj.width / 2,
    yScale: obj.height / 2,
    rotate: degrees(obj.rotation),
    borderColor: color,
    borderWidth: obj.strokeWidth,
    color: obj.fill ? color : undefined,
  });
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
          drawTextObject(page, font, obj);
        } catch {
          // 1件の描画失敗で全体を止めない（他の注釈は正常に書き出す）
          continue;
        }
      } else if (obj.type === "checkbox") {
        try {
          drawCheckbox(page, obj.x, obj.y, obj.size, obj.checked, obj.markStyle ?? "check");
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
          const rotation = obj.rotation ?? 0;
          const pivot = rectPivotForCenterRotation(obj.x, obj.y, obj.width, obj.height, rotation);
          page.drawImage(image, {
            x: pivot.x,
            y: pivot.y,
            width: obj.width,
            height: obj.height,
            rotate: degrees(rotation),
          });
        } catch {
          // 1枚の画像埋め込み失敗で全体を止めない（他人の写真云々ではなく単純に破損データ対策）
          continue;
        }
      } else if (obj.type === "shape") {
        try {
          drawShape(page, obj);
        } catch {
          continue;
        }
      }
    }

    return finalizePdf(doc);
  }
}
