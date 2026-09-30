/**
 * 整理券・金券・引換券作成 Processor（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * 整理券・金券・引換券は「用紙に固定サイズの券を並べて連番・QR/バーコード・
 * 切り取り線を付けて印刷する」という共通構造を持つため、開発指示書の指示通り
 * 3種類を無理に別ツールへ分けず、1つのツールとして実装する。
 *
 * 用紙上への固定サイズセルの敷き詰めは image-layout.ts の computeFixedSizeGrid()
 * をそのまま再利用する（新しいグリッド計算ロジックを増やさない）。
 * QRコードは既存の qrcode パッケージ（qrcode.ts と同じ）、バーコードは
 * このフェーズで新規に追加した jsbarcode（MIT・純JS・ブラウザ完結・
 * 既存ライブラリでは代替できないため新規追加、と判断した）を使う。
 * どちらも生成したPNGをCanvas経由のdata URLとして受け取り、
 * fetch()ではなく format.ts の dataUrlToBlob()（atob直接デコード）を使って
 * バイト列を取り出す。CSPの都合でdata URLへのfetch()は失敗するため
 * （document-pdf.ts等、既存コードのコメントで明示されている既知の制約）。
 */
import { PDFDocument, type PDFFont, type PDFImage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import JsBarcode from "jsbarcode";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { wrapTextByWidth, createTextDrawer } from "@/lib/pdf/text-draw";
import { mmToPt, resolvePaperSizePt, type PaperSizeId, type PaperOrientation } from "@/lib/print/paper-sizes";
import { computeFixedSizeGrid } from "./image-layout";
import { dataUrlToBlob, sanitizeFileName } from "@/lib/utils/format";

export interface TicketVoucherInput {
  paperSizeId: PaperSizeId;
  orientation: PaperOrientation;
  cellWidthMm: number;
  cellHeightMm: number;
  count: number;
  title: string;
  date: string;
  amount: string;
  freeText: string;
  showSerial: boolean;
  serialStart: number;
  serialDigits: number;
  showQr: boolean;
  qrContent: string;
  showBarcode: boolean;
  barcodeContent: string;
  showCutLines: boolean;
  marginMm: number;
  gapMm: number;
}

export interface TicketVoucherOutput {
  blob: Blob;
  url: string;
  pageCount: number;
  ticketsPerPage: number;
}

const MAX_TICKETS = 2000;
const COLOR_MUTED: [number, number, number] = [0.45, 0.45, 0.48];

export function validateTicketVoucherInput(input: TicketVoucherInput): string | null {
  if (!(input.cellWidthMm > 0) || !(input.cellHeightMm > 0)) {
    return "1枚あたりのサイズは0より大きい値を指定してください";
  }
  if (!Number.isInteger(input.count) || input.count < 1) {
    return "枚数は1以上の整数で指定してください";
  }
  if (input.count > MAX_TICKETS) {
    return `枚数が多すぎます（最大${MAX_TICKETS}枚まで）`;
  }
  if (input.marginMm < 0 || input.gapMm < 0) {
    return "余白・間隔にマイナスの値は指定できません";
  }
  return null;
}

function applySerialTemplate(template: string, serial: number, digits: number): string {
  if (!template.includes("{n}")) return template;
  return template.replaceAll("{n}", String(serial).padStart(Math.max(1, digits), "0"));
}

async function renderQrPng(text: string): Promise<Uint8Array> {
  const dataUrl = await QRCode.toDataURL(text, { width: 240, errorCorrectionLevel: "M", margin: 1 });
  return new Uint8Array(await dataUrlToBlob(dataUrl).arrayBuffer());
}

function renderBarcodePng(text: string): Uint8Array | null {
  const canvas = document.createElement("canvas");
  try {
    JsBarcode(canvas, text, { format: "CODE128", displayValue: false, margin: 4, height: 60, width: 2 });
  } catch {
    return null;
  }
  const dataUrl = canvas.toDataURL("image/png");
  const bin = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class TicketVoucherProcessor extends BrowserProcessor<TicketVoucherInput, TicketVoucherOutput> {
  async process(input: TicketVoucherInput): Promise<TicketVoucherOutput> {
    const validationError = validateTicketVoucherInput(input);
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

    const pageSize = resolvePaperSizePt(input.paperSizeId, input.orientation);
    const marginPt = mmToPt(input.marginMm);
    const gapPt = mmToPt(input.gapMm);
    const cellWPt = mmToPt(input.cellWidthMm);
    const cellHPt = mmToPt(input.cellHeightMm);

    const cells = computeFixedSizeGrid({
      canvasWidthPx: pageSize.width,
      canvasHeightPx: pageSize.height,
      marginPx: marginPt,
      gapPx: gapPt,
      cellWidthPx: cellWPt,
      cellHeightPx: cellHPt,
    });
    if (cells.length === 0) {
      throw new Error("この用紙サイズ・余白では券が1枚も配置できません。サイズまたは余白を見直してください");
    }
    const ticketsPerPage = cells.length;

    // 同一内容のQR/バーコードを何度も生成しないよう、内容文字列ごとにキャッシュする
    const qrCache = new Map<string, PDFImage>();
    const barcodeCache = new Map<string, PDFImage | null>();

    const pageCount = Math.ceil(input.count / ticketsPerPage);
    let ticketIndex = 0;

    for (let p = 0; p < pageCount; p++) {
      const page = doc.addPage([pageSize.width, pageSize.height]);
      const { drawText, drawLine } = createTextDrawer(page, font);

      for (const cell of cells) {
        if (ticketIndex >= input.count) break;
        const serial = input.serialStart + ticketIndex;
        const topY = pageSize.height - cell.y;
        const left = cell.x;
        const w = cell.width;
        const h = cell.height;

        if (input.showCutLines) {
          drawLine(left, topY, left + w, topY, COLOR_MUTED, 0.5, [3, 2]);
          drawLine(left, topY - h, left + w, topY - h, COLOR_MUTED, 0.5, [3, 2]);
          drawLine(left, topY, left, topY - h, COLOR_MUTED, 0.5, [3, 2]);
          drawLine(left + w, topY, left + w, topY - h, COLOR_MUTED, 0.5, [3, 2]);
        }

        const pad = Math.min(w, h) * 0.06;
        let cursorY = topY - pad - 10;
        if (input.title.trim()) {
          const titleLines = wrapTextByWidth(input.title, font, 12, w - pad * 2);
          for (const line of titleLines.slice(0, 2)) {
            drawText(line, left + pad, cursorY, 12);
            cursorY -= 15;
          }
        }
        if (input.date.trim()) {
          drawText(input.date, left + pad, cursorY, 8, { color: COLOR_MUTED });
          cursorY -= 12;
        }
        if (input.amount.trim()) {
          drawText(input.amount, left + pad, cursorY, 16);
          cursorY -= 20;
        }
        if (input.freeText.trim()) {
          const freeLines = wrapTextByWidth(input.freeText, font, 8, w - pad * 2);
          for (const line of freeLines.slice(0, 3)) {
            drawText(line, left + pad, cursorY, 8, { color: COLOR_MUTED });
            cursorY -= 11;
          }
        }
        if (input.showSerial) {
          const label = `No. ${String(serial).padStart(Math.max(1, input.serialDigits), "0")}`;
          drawText(label, left + pad, topY - h + pad + 8, 8, { color: COLOR_MUTED });
        }

        const codeSize = Math.min(w, h) * 0.28;
        if (input.showQr && codeSize > 8) {
          const content = applySerialTemplate(input.qrContent || "{n}", serial, input.serialDigits);
          let img = qrCache.get(content);
          if (!img) {
            try {
              const bytes = await renderQrPng(content);
              img = await doc.embedPng(bytes);
              qrCache.set(content, img);
            } catch {
              img = undefined;
            }
          }
          if (img) {
            page.drawImage(img, {
              x: left + w - pad - codeSize,
              y: topY - pad - codeSize,
              width: codeSize,
              height: codeSize,
            });
          }
        }

        if (input.showBarcode && w > mmToPt(20)) {
          const content = applySerialTemplate(input.barcodeContent || "{n}", serial, input.serialDigits);
          let img = barcodeCache.has(content) ? barcodeCache.get(content) : undefined;
          if (img === undefined) {
            const bytes = renderBarcodePng(content);
            if (bytes) {
              try {
                img = await doc.embedPng(bytes);
              } catch {
                img = null;
              }
            } else {
              img = null;
            }
            barcodeCache.set(content, img ?? null);
          }
          if (img) {
            const bw = w - pad * 2;
            const bh = Math.min(h * 0.18, 28);
            page.drawImage(img, { x: left + pad, y: topY - h + pad, width: bw, height: bh });
          }
        }

        ticketIndex++;
      }
      if (ticketIndex >= input.count) break;
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return { blob, url: URL.createObjectURL(blob), pageCount: doc.getPageCount(), ticketsPerPage };
  }
}

export function buildTicketVoucherFileName(title: string): string {
  const base = title.trim() || "整理券";
  return sanitizeFileName(`${base}.pdf`);
}
