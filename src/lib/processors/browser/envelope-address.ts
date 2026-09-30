/**
 * 封筒宛名作成 Processor（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * 長形3号・長形4号・角形2号の3封筒サイズに、宛先（複数可）と差出人を
 * 縦書き／横書きで印刷するPDFを生成する。1宛先につき1ページとし、
 * 複数宛先はまとめて1つのPDFとして書き出す。
 *
 * 日本語フォント埋め込みは document-pdf.ts（見積書・請求書・注文書）と
 * 同じ pdf-lib + @pdf-lib/fontkit + loadJapaneseFontBytes の組み合わせを
 * そのまま再利用する（新しいPDFライブラリ・フォント資産は追加しない）。
 *
 * 縦書き（vertical）は pdf-lib がネイティブ対応していないため、
 * 1文字ずつ縦方向へ積み上げ、列が埋まったら1列左へ折り返す単純な方式で実装する
 * （半角数字は縦書きの見た目に合わせて全角数字へ変換する）。複雑な縦中横・
 * 禁則処理までは行わない、という単純化を明示している。
 */
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { wrapTextByWidth, createTextDrawer } from "@/lib/pdf/text-draw";
import { mmToPt } from "@/lib/print/paper-sizes";
import { ENVELOPE_SIZES_MM, resolveEnvelopePageSizePt, type EnvelopeSizeId } from "@/lib/print/envelope-sizes";
import { sanitizeFileName } from "@/lib/utils/format";

export type EnvelopeWritingMode = "vertical" | "horizontal";

export interface EnvelopePerson {
  postalCode: string;
  address: string;
  name: string;
}

export interface EnvelopeAddressInput {
  envelopeSize: EnvelopeSizeId;
  writingMode: EnvelopeWritingMode;
  recipients: EnvelopePerson[];
  sender: EnvelopePerson | null;
}

export interface EnvelopeAddressOutput {
  blob: Blob;
  url: string;
  pageCount: number;
}

const MAX_RECIPIENTS = 300;
const COLOR_TEXT: [number, number, number] = [0.1, 0.1, 0.12];
const COLOR_MUTED: [number, number, number] = [0.4, 0.4, 0.42];

function toFullWidthDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
}

function isPersonEmpty(p: EnvelopePerson): boolean {
  return p.postalCode.trim() === "" && p.address.trim() === "" && p.name.trim() === "";
}

export function validateEnvelopeAddressInput(input: EnvelopeAddressInput): string | null {
  const valid = input.recipients.filter((r) => !isPersonEmpty(r));
  if (valid.length === 0) {
    return "宛先を1件以上入力してください（郵便番号・住所・宛名のいずれかが必要です）";
  }
  if (valid.length > MAX_RECIPIENTS) {
    return `宛先が多すぎます（最大${MAX_RECIPIENTS}件まで）`;
  }
  return null;
}

/** 郵便番号を1桁ずつ枠で囲んで横書きに描画する（縦書き・横書き共通で使う） */
function drawPostalBoxes(
  page: PDFPage,
  font: PDFFont,
  postalCode: string,
  rightX: number,
  topY: number,
  boxSize: number
) {
  const digits = postalCode.replace(/[^0-9]/g, "");
  if (digits.length === 0) return;
  const gap = boxSize * 0.25;
  let x = rightX - boxSize;
  for (let i = digits.length - 1; i >= 0; i--) {
    page.drawRectangle({
      x,
      y: topY - boxSize,
      width: boxSize,
      height: boxSize,
      borderColor: rgb(...COLOR_MUTED),
      borderWidth: 0.75,
    });
    const d = digits[i];
    const w = font.widthOfTextAtSize(d, boxSize * 0.6);
    page.drawText(d, {
      x: x + (boxSize - w) / 2,
      y: topY - boxSize + boxSize * 0.22,
      size: boxSize * 0.6,
      font,
      color: rgb(...COLOR_TEXT),
    });
    x -= boxSize + gap;
    // 郵便番号は通常3桁-4桁でハイフンを挟むため、4桁目の後で少し間隔を空ける
    if (digits.length - i === 4) x -= gap;
  }
}

/**
 * 1文字ずつ縦方向へ積み上げて描画する。列が埋まったら1列左へ折り返す。
 * startX: 最初（右端）の列の中心x / startY: 各列の描画開始y（上端） / 戻り値: 使用した最終x（左端）
 */
function drawVerticalText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  startX: number,
  startY: number,
  size: number,
  lineHeight: number,
  columnGap: number,
  maxColumnHeight: number,
  color: [number, number, number] = COLOR_TEXT
): number {
  const chars = Array.from(toFullWidthDigits(text)).filter((c) => c !== "\n" && c !== "\r");
  if (chars.length === 0) return startX;
  const charsPerColumn = Math.max(1, Math.floor(maxColumnHeight / lineHeight));
  let col = 0;
  let row = 0;
  for (const ch of chars) {
    const x = startX - col * columnGap;
    const y = startY - row * lineHeight;
    const w = font.widthOfTextAtSize(ch, size);
    page.drawText(ch, { x: x - w / 2, y, size, font, color: rgb(...color) });
    row++;
    if (row >= charsPerColumn) {
      row = 0;
      col++;
    }
  }
  return startX - col * columnGap;
}

function drawRecipientHorizontal(page: PDFPage, font: PDFFont, w: number, h: number, r: EnvelopePerson) {
  const { drawText } = createTextDrawer(page, font);
  const rightX = w - mmToPt(15);
  let y = h * 0.6;
  if (r.postalCode.trim()) {
    drawPostalBoxes(page, font, r.postalCode, rightX, y, mmToPt(6));
    y -= mmToPt(12);
  }
  const addrLines = wrapTextByWidth(r.address, font, 13, w * 0.42);
  for (const line of addrLines) {
    drawText(line, w * 0.4, y, 13);
    y -= 20;
  }
  y -= 10;
  if (r.name.trim()) {
    drawText(`${r.name} 様`, w * 0.4, y, 22);
  }
}

function drawSenderHorizontal(page: PDFPage, font: PDFFont, s: EnvelopePerson) {
  const { drawText } = createTextDrawer(page, font);
  const x = mmToPt(15);
  let y = mmToPt(20);
  if (s.postalCode.trim()) {
    drawText(`〒${s.postalCode}`, x, y, 9, { color: COLOR_MUTED });
    y -= 12;
  }
  const lines = wrapTextByWidth(s.address, font, 9, mmToPt(70));
  for (const line of lines) {
    drawText(line, x, y, 9, { color: COLOR_MUTED });
    y -= 12;
  }
  if (s.name.trim()) {
    drawText(s.name, x, y, 10);
  }
}

function drawRecipientVertical(page: PDFPage, font: PDFFont, w: number, h: number, r: EnvelopePerson) {
  const topMargin = mmToPt(18);
  if (r.postalCode.trim()) {
    drawPostalBoxes(page, font, r.postalCode, w - mmToPt(20), h - mmToPt(6), mmToPt(6));
  }
  const bodyTopY = h - topMargin;
  const maxColHeight = h - topMargin - mmToPt(15);
  if (r.address.trim()) {
    drawVerticalText(page, font, r.address, w * 0.62, bodyTopY, 11, mmToPt(5.5), mmToPt(8), maxColHeight, COLOR_MUTED);
  }
  if (r.name.trim()) {
    drawVerticalText(page, font, `${r.name}様`, w * 0.46, bodyTopY, 18, mmToPt(9), mmToPt(13), maxColHeight, COLOR_TEXT);
  }
}

function drawSenderVertical(page: PDFPage, font: PDFFont, h: number, s: EnvelopePerson) {
  const startY = h * 0.62;
  const maxColHeight = h * 0.5;
  if (s.postalCode.trim()) {
    const { drawText } = createTextDrawer(page, font);
    drawText(`〒${s.postalCode}`, mmToPt(12), h * 0.66, 7, { color: COLOR_MUTED });
  }
  const combined = [s.address, s.name].filter((v) => v.trim() !== "").join("　");
  if (combined.trim()) {
    drawVerticalText(page, font, combined, mmToPt(15), startY, 8, mmToPt(4.5), mmToPt(6), maxColHeight, COLOR_MUTED);
  }
}

export class EnvelopeAddressProcessor extends BrowserProcessor<EnvelopeAddressInput, EnvelopeAddressOutput> {
  async process(input: EnvelopeAddressInput): Promise<EnvelopeAddressOutput> {
    const validationError = validateEnvelopeAddressInput(input);
    if (validationError) throw new Error(validationError);

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }

    let doc: PDFDocument;
    let font: PDFFont;
    try {
      doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    const { width, height } = resolveEnvelopePageSizePt(input.envelopeSize);
    const recipients = input.recipients.filter((r) => !isPersonEmpty(r));

    for (const recipient of recipients) {
      const page = doc.addPage([width, height]);
      if (input.writingMode === "vertical") {
        drawRecipientVertical(page, font, width, height, recipient);
        if (input.sender && !isPersonEmpty(input.sender)) {
          drawSenderVertical(page, font, height, input.sender);
        }
      } else {
        drawRecipientHorizontal(page, font, width, height, recipient);
        if (input.sender && !isPersonEmpty(input.sender)) {
          drawSenderHorizontal(page, font, input.sender);
        }
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return { blob, url: URL.createObjectURL(blob), pageCount: doc.getPageCount() };
  }
}

export function buildEnvelopeFileName(size: EnvelopeSizeId): string {
  const label = size === "chou3" ? "長形3号" : size === "chou4" ? "長形4号" : "角形2号";
  return sanitizeFileName(`封筒宛名_${label}.pdf`);
}

export { ENVELOPE_SIZES_MM };
