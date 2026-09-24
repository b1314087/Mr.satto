import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import {
  DOCUMENT_TYPE_META,
  isBankAccountEmpty,
  type DocumentFormState,
  type ParsedLineItem,
} from "@/lib/documents/types";
import { parseLineItem, computeDocumentTotals, formatYen } from "@/lib/documents/calc";
import { validateDocumentForm } from "@/lib/documents/validation";
import { sanitizeFileName } from "@/lib/utils/format";

/**
 * 帳票共通PDF生成（Phase 2-C）。
 *
 * 見積書・請求書・注文書の3ツールが共通で利用するPDF生成Processor。
 * pdf-lib（開発指示書■9: 新しいPDFライブラリは追加せず既存を利用）に
 * @pdf-lib/fontkit を組み合わせ、日本語TrueTypeフォント(Noto Sans JP)を
 * 埋め込むことで、会社名・住所・品名・備考などの日本語をPDF上に
 * 正しく表示する（豆腐(□)化を防ぐ。開発指示書■10）。
 *
 * 重要: pdf-lib の埋め込みフォントは subset:true（サブセット化）を
 * 有効にすると、この日本語フォントでは一部の文字が欠落して
 * 表示されないことを実機検証済みのため、必ず subset:false を指定する。
 * そのためPDFのファイルサイズはやや大きくなるが、正しい日本語表示を
 * 優先する（開発指示書■10「文字化けする場合はavailableにしない」）。
 */

export interface DocumentPdfOutput {
  blob: Blob;
  url: string;
  pageCount: number;
  sizeBytes: number;
}

export interface DocumentPdfInput {
  form: DocumentFormState;
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
/** ページ下部に残す余白（ページ番号フッター分） */
const BOTTOM_LIMIT = MARGIN + 24;

const COLOR_TEXT: [number, number, number] = [0.13, 0.13, 0.15];
const COLOR_MUTED: [number, number, number] = [0.45, 0.45, 0.48];
const COLOR_LINE: [number, number, number] = [0.8, 0.8, 0.82];
const COLOR_HEADER_BG: [number, number, number] = [0.93, 0.94, 0.96];

// ---------------------------------------------------------------------------
// テキスト折り返し（日本語は単語区切りが無いため1文字単位で幅計測する）
// ---------------------------------------------------------------------------
function wrapTextByWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const paragraphs = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const candidate = current + ch;
      if (current !== "" && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

/** ファイル名を組み立てる（例: 見積書_2026-09-24.pdf）。日本語ツール共通で利用する */
export function buildDocumentFileName(form: DocumentFormState): string {
  const prefix = DOCUMENT_TYPE_META[form.type].fileNamePrefix;
  const date = form.issueDate || new Date().toISOString().slice(0, 10);
  return sanitizeFileName(`${prefix}_${date}.pdf`);
}

// 明細列のレイアウト（合計 = CONTENT_WIDTH と一致させる）
const COL_NAME_W = 220;
const COL_QTY_W = 50;
const COL_UNIT_W = 45;
const COL_PRICE_W = 90;
const COL_AMOUNT_W = CONTENT_WIDTH - COL_NAME_W - COL_QTY_W - COL_UNIT_W - COL_PRICE_W;

const COL_NAME_X = MARGIN;
const COL_QTY_X = COL_NAME_X + COL_NAME_W;
const COL_UNIT_X = COL_QTY_X + COL_QTY_W;
const COL_PRICE_X = COL_UNIT_X + COL_UNIT_W;
const COL_AMOUNT_X = COL_PRICE_X + COL_PRICE_W;

type DrawTextOptions = {
  color?: [number, number, number];
  /** "right"はxを右端、"center"はxを中心点として扱う。省略時("left")はxを左端として扱う */
  align?: "left" | "right" | "center";
};

export class DocumentPdfProcessor extends BrowserProcessor<DocumentPdfInput, DocumentPdfOutput> {
  async process({ form }: DocumentPdfInput): Promise<DocumentPdfOutput> {
    const validationError = validateDocumentForm(form);
    if (validationError) {
      throw new Error(validationError);
    }

    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error(
        "日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。"
      );
    }

    const meta = DOCUMENT_TYPE_META[form.type];
    const items: ParsedLineItem[] = form.items
      .filter((item) => !(item.name.trim() === "" && item.unitPrice.trim() === ""))
      .map(parseLineItem);
    if (items.length === 0) {
      throw new Error("明細を1件以上入力してください");
    }
    const totals = computeDocumentTotals(items, form.taxRatePercent, form.taxRounding);

    let doc: PDFDocument;
    let font: PDFFont;
    try {
      doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      // 注意: subset:false（理由はファイル冒頭のコメントを参照）
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }

    const pages: PDFPage[] = [];
    let page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    pages.push(page);
    let cursorY = A4_HEIGHT - MARGIN;

    function drawText(value: string, x: number, y: number, size: number, opts: DrawTextOptions = {}) {
      const color = opts.color ?? COLOR_TEXT;
      const width = font.widthOfTextAtSize(value, size);
      let drawX = x;
      if (opts.align === "right") drawX = x - width;
      else if (opts.align === "center") drawX = x - width / 2;
      page.drawText(value, { x: drawX, y, size, font, color: rgb(...color) });
    }

    function drawLine(x1: number, y1: number, x2: number, y2: number, color = COLOR_LINE, thickness = 0.75) {
      page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: rgb(...color) });
    }

    function newPage() {
      page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
      pages.push(page);
      cursorY = A4_HEIGHT - MARGIN;
    }

    function ensureSpace(height: number) {
      if (cursorY - height < BOTTOM_LIMIT) {
        newPage();
      }
    }

    function drawTableHeader() {
      const headerHeight = 22;
      page.drawRectangle({
        x: MARGIN,
        y: cursorY - headerHeight,
        width: CONTENT_WIDTH,
        height: headerHeight,
        color: rgb(...COLOR_HEADER_BG),
      });
      const textY = cursorY - headerHeight + 7;
      drawText("品名", COL_NAME_X + 6, textY, 9, { color: COLOR_MUTED });
      drawText("数量", COL_QTY_X + COL_QTY_W - 6, textY, 9, { align: "right", color: COLOR_MUTED });
      drawText("単位", COL_UNIT_X + COL_UNIT_W / 2, textY, 9, { align: "center", color: COLOR_MUTED });
      drawText("単価", COL_PRICE_X + COL_PRICE_W - 6, textY, 9, { align: "right", color: COLOR_MUTED });
      drawText("金額", COL_AMOUNT_X + COL_AMOUNT_W - 6, textY, 9, { align: "right", color: COLOR_MUTED });
      cursorY -= headerHeight;
    }

    // -----------------------------------------------------------------
    // 1ページ目ヘッダー: タイトル・書類番号/発行日・宛先・発行者
    // -----------------------------------------------------------------
    drawText(form.title || meta.defaultTitle, A4_WIDTH / 2, cursorY - 20, 22, { align: "center" });
    cursorY -= 46;

    const headerTopY = cursorY;
    // 宛先（左側）
    let leftY = headerTopY;
    const recipientName =
      form.recipient.companyName.trim() || form.recipient.contactName.trim() || "お客様";
    drawText(`${recipientName} 御中`, MARGIN, leftY, 13);
    leftY -= 18;
    if (form.recipient.companyName.trim() && form.recipient.contactName.trim()) {
      drawText(form.recipient.contactName, MARGIN, leftY, 10, { color: COLOR_MUTED });
      leftY -= 14;
    }
    const recipientAddressLines = wrapTextByWidth(
      [form.recipient.postalCode ? `〒${form.recipient.postalCode}` : "", form.recipient.address]
        .filter(Boolean)
        .join(" "),
      font,
      9,
      260
    );
    for (const line of recipientAddressLines) {
      if (line === "") continue;
      drawText(line, MARGIN, leftY, 9, { color: COLOR_MUTED });
      leftY -= 12;
    }
    if (form.recipient.tel.trim()) {
      drawText(`TEL: ${form.recipient.tel}`, MARGIN, leftY, 9, { color: COLOR_MUTED });
      leftY -= 12;
    }

    // 書類番号・発行日・secondaryDate（右側上部）
    const rightX = A4_WIDTH - MARGIN;
    let rightY = headerTopY;
    drawText(`書類番号: ${form.documentNumber}`, rightX, rightY, 10, { align: "right" });
    rightY -= 14;
    drawText(`発行日: ${form.issueDate}`, rightX, rightY, 10, { align: "right" });
    rightY -= 14;
    if (form.secondaryDate.trim()) {
      drawText(`${meta.secondaryDateLabel}: ${form.secondaryDate}`, rightX, rightY, 10, {
        align: "right",
      });
      rightY -= 14;
    }
    rightY -= 6;

    // 発行者情報（右側下部）
    if (form.issuer.companyName.trim()) {
      drawText(form.issuer.companyName, rightX, rightY, 11, { align: "right" });
      rightY -= 14;
    }
    if (form.issuer.contactName.trim()) {
      drawText(form.issuer.contactName, rightX, rightY, 9, { align: "right", color: COLOR_MUTED });
      rightY -= 12;
    }
    const issuerAddressLines = wrapTextByWidth(
      [form.issuer.postalCode ? `〒${form.issuer.postalCode}` : "", form.issuer.address]
        .filter(Boolean)
        .join(" "),
      font,
      9,
      220
    );
    for (const line of issuerAddressLines) {
      if (line === "") continue;
      drawText(line, rightX, rightY, 9, { align: "right", color: COLOR_MUTED });
      rightY -= 12;
    }
    if (form.issuer.tel.trim()) {
      drawText(`TEL: ${form.issuer.tel}`, rightX, rightY, 9, { align: "right", color: COLOR_MUTED });
      rightY -= 12;
    }
    if (form.issuer.email.trim()) {
      drawText(form.issuer.email, rightX, rightY, 9, { align: "right", color: COLOR_MUTED });
      rightY -= 12;
    }

    cursorY = Math.min(leftY, rightY) - 10;

    // 合計金額の強調表示
    ensureSpace(40);
    page.drawRectangle({
      x: MARGIN,
      y: cursorY - 32,
      width: CONTENT_WIDTH,
      height: 32,
      color: rgb(...COLOR_HEADER_BG),
    });
    drawText(
      form.type === "invoice" ? "ご請求金額（税込）" : "合計金額（税込）",
      MARGIN + 10,
      cursorY - 21,
      11
    );
    drawText(formatYen(totals.total), A4_WIDTH - MARGIN - 10, cursorY - 22, 16, { align: "right" });
    cursorY -= 44;

    // -----------------------------------------------------------------
    // 明細テーブル
    // -----------------------------------------------------------------
    ensureSpace(22);
    drawTableHeader();

    const rowPaddingV = 6;
    const lineHeight = 12;
    for (const item of items) {
      const nameLines = wrapTextByWidth(item.name || "（品名未入力）", font, 9, COL_NAME_W - 12);
      const unitLines = wrapTextByWidth(item.unit || "", font, 9, COL_UNIT_W - 4);
      const rowLineCount = Math.max(nameLines.length, unitLines.length, 1);
      const rowHeight = rowLineCount * lineHeight + rowPaddingV * 2;

      const beforeBreakY = cursorY;
      ensureSpace(rowHeight);
      // ensureSpace が改ページした場合、新しいページにテーブルヘッダーを再描画する
      if (cursorY !== beforeBreakY) {
        drawText(`${form.title || meta.defaultTitle}（続き）`, MARGIN, cursorY, 11, {
          color: COLOR_MUTED,
        });
        cursorY -= 20;
        drawTableHeader();
      }

      const rowTop = cursorY;
      const firstLineY = rowTop - rowPaddingV - lineHeight + 3;
      nameLines.forEach((line, idx) => {
        drawText(line, COL_NAME_X + 6, firstLineY - idx * lineHeight, 9);
      });
      drawText(String(item.quantity), COL_QTY_X + COL_QTY_W - 6, firstLineY, 9, { align: "right" });
      unitLines.forEach((line, idx) => {
        drawText(line, COL_UNIT_X + COL_UNIT_W / 2, firstLineY - idx * lineHeight, 9, {
          align: "center",
        });
      });
      drawText(formatYen(item.unitPrice), COL_PRICE_X + COL_PRICE_W - 6, firstLineY, 9, {
        align: "right",
      });
      drawText(formatYen(item.amount), COL_AMOUNT_X + COL_AMOUNT_W - 6, firstLineY, 9, {
        align: "right",
      });

      cursorY = rowTop - rowHeight;
      drawLine(MARGIN, cursorY, MARGIN + CONTENT_WIDTH, cursorY);
    }

    cursorY -= 10;

    // -----------------------------------------------------------------
    // 小計・消費税・合計
    // -----------------------------------------------------------------
    const summaryHeight = 3 * 16 + 12;
    ensureSpace(summaryHeight);
    const summaryLabelX = A4_WIDTH - MARGIN - 160;
    const summaryValueX = A4_WIDTH - MARGIN;
    drawText("小計", summaryLabelX, cursorY, 10, { color: COLOR_MUTED });
    drawText(formatYen(totals.subtotal), summaryValueX, cursorY, 10, { align: "right" });
    cursorY -= 16;
    drawText(`消費税（${form.taxRatePercent}%）`, summaryLabelX, cursorY, 10, { color: COLOR_MUTED });
    drawText(formatYen(totals.tax), summaryValueX, cursorY, 10, { align: "right" });
    cursorY -= 16;
    drawLine(summaryLabelX, cursorY + 10, summaryValueX, cursorY + 10);
    drawText("合計", summaryLabelX, cursorY, 12);
    drawText(formatYen(totals.total), summaryValueX, cursorY, 12, { align: "right" });
    cursorY -= 26;

    // -----------------------------------------------------------------
    // 振込先情報（請求書のみ）
    // -----------------------------------------------------------------
    if (meta.showBankAccount && !isBankAccountEmpty(form.bankAccount)) {
      const details = [
        [form.bankAccount.bankName, form.bankAccount.branchName].filter(Boolean).join(" "),
        [form.bankAccount.accountType, form.bankAccount.accountNumber].filter(Boolean).join(" "),
        form.bankAccount.accountHolder,
      ].filter((line) => line.trim() !== "");
      const blockHeight = 16 + details.length * 14 + 10;
      ensureSpace(blockHeight);
      drawText("【お振込先】", MARGIN, cursorY, 10);
      cursorY -= 16;
      for (const line of details) {
        drawText(line, MARGIN, cursorY, 9, { color: COLOR_MUTED });
        cursorY -= 14;
      }
      cursorY -= 10;
    }

    // -----------------------------------------------------------------
    // 備考
    // -----------------------------------------------------------------
    if (form.notes.trim() !== "") {
      const noteLines = wrapTextByWidth(form.notes, font, 9, CONTENT_WIDTH - 12);
      ensureSpace(16 + Math.min(noteLines.length, 3) * 13);
      drawText("備考", MARGIN, cursorY, 10);
      cursorY -= 16;
      for (const line of noteLines) {
        ensureSpace(13);
        drawText(line, MARGIN, cursorY, 9, { color: COLOR_MUTED });
        cursorY -= 13;
      }
    }

    // -----------------------------------------------------------------
    // ページ番号（全ページ共通フッター）
    // -----------------------------------------------------------------
    pages.forEach((p, idx) => {
      const label = `${idx + 1} / ${pages.length}`;
      const w = font.widthOfTextAtSize(label, 8);
      p.drawText(label, {
        x: A4_WIDTH - MARGIN - w,
        y: MARGIN - 20,
        size: 8,
        font,
        color: rgb(...COLOR_MUTED),
      });
    });

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return {
      blob,
      url: URL.createObjectURL(blob),
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
    };
  }
}
