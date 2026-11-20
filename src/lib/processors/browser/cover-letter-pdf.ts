import type { PDFFont, PDFPage } from "pdf-lib";
import type * as PdfLibTypes from "pdf-lib";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { ensurePdfLib, pdfLib, fontkitLib } from "@/lib/pdf/pdf-lib-loader";
import { sanitizeFileName } from "@/lib/utils/format";
import {
  COVER_LETTER_KIND_META,
  activeRecipients,
  clampLayout,
  type CoverLetterBlock,
  coverLetterBaseName,
  coverLetterTitle,
  formatJapaneseDate,
  itemLines,
  recipientLines,
  senderLines,
  validateCoverLetter,
  type CoverLetterForm,
} from "@/lib/documents/cover-letter";

/**
 * 送付状（書類送付状・FAX送付状）のPDFを作る（2026-11-20）。
 * 帳票（見積書など）と同じく、pdf-lib に日本語フォントを埋め込んで、ブラウザの中だけで作る（サーバーに送らない）。
 * 日本語フォントは subset:false（一部の文字が欠ける問題を避けるため。document-pdf.ts と同じ）。
 */

export interface CoverLetterPdfOutput {
  blob: Blob;
  url: string;
  pageCount: number;
  sizeBytes: number;
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN;
const COLOR_TEXT: [number, number, number] = [0.1, 0.1, 0.12];
const COLOR_MUTED: [number, number, number] = [0.35, 0.35, 0.38];
const COLOR_LINE: [number, number, number] = [0.55, 0.55, 0.58];

/** 日本語は単語の区切りがないため、1文字ずつ幅を測って折り返す */
export function wrapByWidth(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const ch of Array.from(paragraph)) {
      const next = current + ch;
      if (current !== "" && measure(next) > maxWidth) {
        lines.push(current);
        current = ch;
      } else current = next;
    }
    if (current !== "") lines.push(current);
  }
  return lines;
}

/** 半角の文字のまとまりと、それ以外のまとまりに分ける */
export function splitAsciiRuns(s: string): string[] {
  return s.match(/[\x20-\x7e]+|[^\x20-\x7e]+/g) ?? [];
}

export function buildCoverLetterFileName(form: CoverLetterForm): string {
  return sanitizeFileName(`${coverLetterBaseName(form)}.pdf`);
}

export class CoverLetterPdfProcessor extends BrowserProcessor<{ form: CoverLetterForm }, CoverLetterPdfOutput> {
  async process({ form }: { form: CoverLetterForm }): Promise<CoverLetterPdfOutput> {
    const problem = validateCoverLetter(form);
    if (problem) throw new Error(problem);
    await ensurePdfLib({ fontkit: true });
    let fontBytes: ArrayBuffer;
    try {
      fontBytes = await loadJapaneseFontBytes();
    } catch {
      throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
    }
    let doc: PdfLibTypes.PDFDocument;
    let font: PDFFont;
    try {
      doc = await pdfLib().PDFDocument.create();
      doc.registerFontkit(fontkitLib());
      font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
    } catch {
      throw new Error("PDFの作成に失敗しました（フォントの埋め込みでエラーが発生しました）");
    }
    doc.setTitle(`${COVER_LETTER_KIND_META[form.kind].label}`);

    const layout = clampLayout(form.layout);
    const PT_PER_MM = 72 / 25.4;
    const dx = (b: CoverLetterBlock) => layout[b].x * PT_PER_MM;
    const dy = (b: CoverLetterBlock) => layout[b].y * PT_PER_MM;
    const pages: PDFPage[] = [];
    let page!: PDFPage;
    let y = 0;
    const rgb = (c: [number, number, number]) => pdfLib().rgb(...c);
    const width = (s: string, size: number) => font.widthOfTextAtSize(s, size);
    const text = (s: string, x: number, yy: number, size: number, align: "left" | "right" | "center" = "left", color = COLOR_TEXT) => {
      const w = width(s, size);
      let tx = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
      // 半角の文字（数字・英字）と全角の文字を分けて描く。「FAX：03-…」のように全角の「：」のすぐ後に数字が続くと、
      // フォントの組版で数字の間が大きく空いてしまうため（実際に確かめた不具合）
      for (const run of splitAsciiRuns(s)) {
        page.drawText(run, { x: tx, y: yy, size, font, color: rgb(color) });
        tx += width(run, size);
      }
    };
    const newPage = () => {
      page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
      pages.push(page);
      y = A4_HEIGHT - MARGIN;
    };
    const ensure = (h: number) => {
      if (y - h < BOTTOM_LIMIT) newPage();
    };
    const paragraph = (s: string, size: number, lineH: number, x = MARGIN, maxW = CONTENT_WIDTH, color = COLOR_TEXT) => {
      for (const line of wrapByWidth(s, (t) => width(t, size), maxW)) {
        ensure(lineH);
        y -= lineH;
        if (line !== "") text(line, x, y, size, "left", color);
      }
    };
    /** ずらし量（縦）をあける。上へのずらし（マイナス）は、ページの上の余白を越えない */
    const moveDown = (b: CoverLetterBlock, base: number) => {
      y = Math.min(A4_HEIGHT - MARGIN / 2, y - Math.max(0, base + dy(b)));
    };

    const recipients = activeRecipients(form);
    for (const recipient of recipients) {
      const firstPageOfLetter = pages.length;
      newPage();

      // 日付（右上）
      moveDown("date", 12);
      text(formatJapaneseDate(form.date), A4_WIDTH - MARGIN + dx("date"), y, 10.5, "right");

      // 宛先（左）
      moveDown("recipient", 26);
      const recipientTop = y;
      const toLines = recipientLines(recipient);
      for (const [i, line] of toLines.entries()) {
        const isLast = i === toLines.length - 1;
        const size = isLast ? 14 : 12;
        y -= size + 6;
        const x = MARGIN + dx("recipient");
        text(line, x, y, size);
        if (isLast) page.drawLine({ start: { x, y: y - 4 }, end: { x: x + Math.max(200, width(line, size) + 8), y: y - 4 }, thickness: 0.8, color: rgb(COLOR_LINE) });
      }
      if (form.kind === "fax") {
        const faxInfo = [recipient.fax.trim() && `FAX：${recipient.fax.trim()}`, recipient.tel.trim() && `TEL：${recipient.tel.trim()}`].filter(Boolean).join("　");
        if (faxInfo) {
          y -= 18;
          text(faxInfo, MARGIN + dx("recipient"), y, 10, "left", COLOR_MUTED);
        }
      }
      const recipientBottom = y;

      // 差出人（右）。宛先の下から始める（宛先と重ならないように）
      y = Math.min(recipientBottom, recipientTop - 40);
      moveDown("sender", 18);
      const senderX = Math.max(MARGIN, Math.min(A4_WIDTH - MARGIN - 60, A4_WIDTH / 2 + 30 + dx("sender")));
      for (const [i, line] of senderLines(form.sender).entries()) {
        const size = i === 0 ? 11 : 9.5;
        for (const part of wrapByWidth(line, (t) => width(t, size), A4_WIDTH - MARGIN - senderX)) {
          y -= size + 5;
          text(part, senderX, y, size);
        }
      }

      // 見出し
      moveDown("title", 36);
      text(coverLetterTitle(form), A4_WIDTH / 2 + dx("title"), y, 18, "center");
      y -= 18;

      // あいさつ文。「敬具」は右寄せ
      if (form.greeting.trim() !== "") {
        moveDown("body", 6);
        const bx = MARGIN + dx("body");
        const bw = Math.max(120, CONTENT_WIDTH - Math.max(0, dx("body")));
        for (const line of form.greeting.replace(/\s+$/, "").split(/\r\n|\r|\n/)) {
          if (/^\s*(敬具|敬白|草々|以上)\s*$/.test(line)) {
            ensure(20);
            y -= 20;
            text(line.trim(), Math.min(A4_WIDTH - 12, A4_WIDTH - MARGIN + dx("body")), y, 10.5, "right");
          } else {
            paragraph(line, 10.5, 20, bx, bw);
          }
        }
      }

      // 記
      const items = itemLines(form.items);
      const pagesLine = form.kind === "fax" && form.faxPages.trim() ? `送信枚数：${form.faxPages.trim()}枚（本紙を含む）` : "";
      if (items.length > 0 || pagesLine) {
        ensure(60);
        moveDown("items", 34);
        text("記", A4_WIDTH / 2 + dx("items"), y, 12, "center");
        y -= 10;
        const boxX = MARGIN + 40 + dx("items");
        const boxW = Math.max(120, CONTENT_WIDTH - 80 - Math.max(0, dx("items")));
        for (const [i, line] of items.entries()) paragraph(`${i + 1}．${line}`, 11, 22, boxX, boxW);
        if (pagesLine) {
          y -= 4;
          paragraph(pagesLine, 11, 22, boxX, boxW);
        }
      }

      // 連絡事項
      if (form.notes.trim() !== "") {
        ensure(48);
        moveDown("notes", 26);
        const nx = MARGIN + dx("notes");
        text("【連絡事項】", nx, y, 10.5);
        y -= 4;
        paragraph(form.notes.trim(), 10, 18, nx + 10, Math.max(120, CONTENT_WIDTH - 10 - Math.max(0, dx("notes"))), COLOR_TEXT);
      }

      // 以上
      ensure(30);
      y -= 26;
      text("以上", A4_WIDTH - MARGIN, y, 10.5, "right");

      // 1通が2ページ以上になったときだけ、その通の中のページ番号を付ける
      const letterPages = pages.slice(firstPageOfLetter);
      if (letterPages.length > 1) {
        letterPages.forEach((p, idx) => {
          const label = `${idx + 1} / ${letterPages.length}`;
          p.drawText(label, { x: A4_WIDTH - MARGIN - width(label, 8), y: MARGIN - 28, size: 8, font, color: rgb(COLOR_MUTED) });
        });
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return { blob, url: URL.createObjectURL(blob), pageCount: doc.getPageCount(), sizeBytes: blob.size };
  }
}
