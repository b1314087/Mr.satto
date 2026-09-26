import { PDFDocument, type PDFFont, type PDFImage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import type { FieldDefinition } from "./types";

/**
 * 帳票共通エンジンのPDF描画部分（開発指示書30章：将来の宛名ラベル・名札・
 * 個別通知・修了証・会員証にも使い回せるよう、「テンプレートPDF + フィールド
 * 定義 + 1人分の値」を受け取って1つのPDFを返す、という最小の関数として作る）。
 *
 * 1人ずつ独立して呼び出す設計にしている（開発指示書37章：100〜500人分を
 * 一括処理する際、大きな配列やBlobを同時に保持し続けないようにするため）。
 * 呼び出し側（form-to-individual-pdfs.ts）は、この関数が返したUint8Arrayを
 * ZIPへ追加した後、参照を手放して次の人の処理に進む。
 *
 * 日本語フォントの扱いはPhase 2-C/9と同じ既存資産（Noto Sans JP、
 * subset:false）を再利用する。1文字ずつdrawTextする理由は、Phase 9で
 * 実機検証済みの「英字+数字が連続する文字列でPDFのテキスト情報が
 * 化ける」不具合（src/lib/processors/browser/excel-to-pdf.ts 参照）への
 * 対処で、氏名・住所・電話番号などフォーム回答の値には英数字混在が
 * ありうるため、この帳票エンジンでも同じ対処を必ず適用する。
 */

let fontBytesCache: ArrayBuffer | null = null;
async function getFontBytes(): Promise<ArrayBuffer> {
  if (!fontBytesCache) {
    fontBytesCache = await loadJapaneseFontBytes();
  }
  return fontBytesCache;
}

function drawTextRobust(
  page: import("pdf-lib").PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  y: number,
  size: number
) {
  let cx = x;
  for (const ch of Array.from(text)) {
    page.drawText(ch, { x: cx, y, size, font, color: rgb(0.1, 0.1, 0.12) });
    cx += font.widthOfTextAtSize(ch, size);
  }
}

/** 日本語には単語区切りが無いため、1文字単位で幅を測って折り返す（document-pdf.tsと同じ方式） */
function wrapByWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (const ch of Array.from(text)) {
    const candidate = current + ch;
    if (current !== "" && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current !== "" || lines.length === 0) lines.push(current);
  return lines;
}

function detectImageKind(file: File): "jpg" | "png" | null {
  const type = file.type.toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  const name = file.name.toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpg";
  if (name.endsWith(".png")) return "png";
  return null;
}

export interface RenderPersonInput {
  /** テンプレートPDFの生データ。呼び出し側で使い回すことを想定し、この関数内では複製して読む */
  templateBytes: ArrayBuffer;
  fields: FieldDefinition[];
  /** フィールドID -> テキスト値（textフィールド用。未設定は空文字扱い） */
  textValues: Record<string, string>;
  /** フィールドID -> 写真ファイル（photoフィールド用。該当なしはnullまたは未設定） */
  photoValues: Record<string, File | null | undefined>;
}

/** テンプレートPDFに1人分のデータを差し込み、新しいPDFのバイト列を返す */
export async function renderPersonPdf({
  templateBytes,
  fields,
  textValues,
  photoValues,
}: RenderPersonInput): Promise<Uint8Array> {
  let doc: PDFDocument;
  let font: PDFFont;
  try {
    doc = await PDFDocument.load(templateBytes, { updateMetadata: false });
    doc.registerFontkit(fontkit);
    const fontBytes = await getFontBytes();
    // 注意: subset:false（document-pdf.ts/excel-to-pdf.tsと同じ理由。
    // サブセット化すると一部の日本語文字が欠落することを実機検証済み）
    font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
  } catch {
    throw new Error("テンプレートPDFの読み込み、またはフォントの埋め込みに失敗しました");
  }

  const pageCount = doc.getPageCount();
  const imageCache = new Map<File, PDFImage>();

  for (const field of fields) {
    if (field.page < 1 || field.page > pageCount) continue;
    const page = doc.getPage(field.page - 1);

    if (field.dataType === "text") {
      const value = (textValues[field.id] ?? "").trim();
      if (value === "") continue;

      const lines = wrapByWidth(value, font, field.fontSize, field.width);
      const lineHeight = field.fontSize * 1.25;
      const maxLines = Math.max(1, Math.floor(field.height / lineHeight) || 1);
      const visibleLines = lines.slice(0, maxLines);

      // フィールド枠の上端からテキストを描画する（原点は左下座標系）
      let cursorY = field.y + field.height - field.fontSize;
      for (const line of visibleLines) {
        const lineWidth = font.widthOfTextAtSize(line, field.fontSize);
        let drawX = field.x;
        if (field.align === "right") drawX = field.x + field.width - lineWidth;
        else if (field.align === "center") drawX = field.x + (field.width - lineWidth) / 2;
        drawTextRobust(page, font, line, drawX, cursorY, field.fontSize);
        cursorY -= lineHeight;
      }
    } else if (field.dataType === "photo") {
      const photoFile = photoValues[field.id];
      if (!photoFile) continue;

      try {
        let image = imageCache.get(photoFile);
        if (!image) {
          const kind = detectImageKind(photoFile);
          if (!kind) continue; // 未対応形式は「写真なし」と同じ扱いにする（他人の写真を代わりに使わない）
          const bytes = new Uint8Array(await photoFile.arrayBuffer());
          image = kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
          imageCache.set(photoFile, image);
        }

        // contain fit: 縦横比を保ったまま、フィールド枠に収まる最大サイズで中央に配置する
        const scale = Math.min(field.width / image.width, field.height / image.height);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        const drawX = field.x + (field.width - drawWidth) / 2;
        const drawY = field.y + (field.height - drawHeight) / 2;
        page.drawImage(image, { x: drawX, y: drawY, width: drawWidth, height: drawHeight });
      } catch {
        // 1件の写真埋め込み失敗で全体を止めない。そのフィールドだけ空欄のままにする。
        continue;
      }
    }
  }

  try {
    return await doc.save();
  } catch {
    throw new Error("PDFの書き出しに失敗しました");
  }
}
