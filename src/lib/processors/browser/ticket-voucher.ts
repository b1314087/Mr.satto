/**
 * 整理券・金券・引換券作成 Processor（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * 整理券・金券・引換券は「用紙に固定サイズの券を並べて連番・QR/バーコード・
 * 切り取り線を付けて印刷する」という共通構造を持つため、開発指示書の指示通り
 * 3種類を無理に別ツールへ分けず、1つのツールとして実装する。
 *
 * 用紙上への固定サイズセルの敷き詰めは image-layout.ts の computeFixedSizeGrid()
 * をそのまま再利用する（新しいグリッド計算ロジックを増やさない）。
 * 二次元コードは既存の qrcode パッケージ（qrcode.ts と同じ）、バーコードは
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
import { createTextDrawer } from "@/lib/pdf/text-draw";
import { mmToPt, resolvePaperSizePt, type PaperSizeId, type PaperOrientation } from "@/lib/print/paper-sizes";
import { computeFixedSizeGrid } from "./image-layout";
import { dataUrlToBlob, sanitizeFileName } from "@/lib/utils/format";
import {
  buildTickets,
  layoutTicket,
  validateTicketInput,
  type TicketCodeSettings,
  type TicketGroup,
  type TicketRow,
} from "@/lib/tickets/ticket-layout";

/**
 * 券の入力。「券の種類」(groups。タイトル・金額・開始番号〜終了番号)を複数並べるか、
 * Excelから読み込んだ行(rows。1行=1枚)を使う。どちらの場合も、配置は
 * src/lib/tickets/ticket-layout.ts で計算する(画面のプレビューと共通)。
 */
export interface TicketVoucherInput {
  paperSizeId: PaperSizeId;
  orientation: PaperOrientation;
  cellWidthMm: number;
  cellHeightMm: number;
  marginMm: number;
  gapMm: number;
  showSerial: boolean;
  serialDigits: number;
  showCutLines: boolean;
  codes: TicketCodeSettings;
  groups: TicketGroup[];
  rows: TicketRow[] | null;
  rowsSerialStart: number;
}

export interface TicketVoucherOutput {
  blob: Blob;
  pageCount: number;
  ticketsPerPage: number;
  ticketCount: number;
}

export function validateTicketVoucherInput(input: TicketVoucherInput): string | null {
  return validateTicketInput(input);
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
    const cells = computeFixedSizeGrid({
      canvasWidthPx: pageSize.width,
      canvasHeightPx: pageSize.height,
      marginPx: mmToPt(input.marginMm),
      gapPx: mmToPt(input.gapMm),
      cellWidthPx: mmToPt(input.cellWidthMm),
      cellHeightPx: mmToPt(input.cellHeightMm),
    });
    if (cells.length === 0) {
      throw new Error("この用紙サイズ・余白では券が1枚も配置できません。サイズまたは余白を見直してください");
    }
    const ticketsPerPage = cells.length;
    const tickets = buildTickets(input);
    const measure = (t: string, size: number) => font.widthOfTextAtSize(t, size);

    // 同一内容のコードを何度も生成しないよう、内容文字列ごとにキャッシュする
    const qrCache = new Map<string, PDFImage | null>();
    const barcodeCache = new Map<string, PDFImage | null>();

    const pageCount = Math.ceil(tickets.length / ticketsPerPage);
    let ticketIndex = 0;

    for (let p = 0; p < pageCount; p++) {
      const page = doc.addPage([pageSize.width, pageSize.height]);
      const { drawText, drawLine } = createTextDrawer(page, font);

      for (const cell of cells) {
        if (ticketIndex >= tickets.length) break;
        const ticket = tickets[ticketIndex];
        const left = cell.x;
        const topY = pageSize.height - cell.y;
        const ops = layoutTicket(
          { w: cell.width, h: cell.height, showSerial: input.showSerial, showCutLines: input.showCutLines, codes: input.codes, ticket },
          measure
        );
        for (const op of ops) {
          if (op.kind === "cutRect") {
            const x0 = left + op.x;
            const y0 = topY - op.y;
            drawLine(x0, y0, x0 + op.w, y0, [0.45, 0.45, 0.48], 0.5, [3, 2]);
            drawLine(x0, y0 - op.h, x0 + op.w, y0 - op.h, [0.45, 0.45, 0.48], 0.5, [3, 2]);
            drawLine(x0, y0, x0, y0 - op.h, [0.45, 0.45, 0.48], 0.5, [3, 2]);
            drawLine(x0 + op.w, y0, x0 + op.w, y0 - op.h, [0.45, 0.45, 0.48], 0.5, [3, 2]);
          } else if (op.kind === "text") {
            // 英字・ピリオドの直後の数字は、フォントの文脈置換で別字形になり文字列として抽出できなくなるため、
            // 数字の連続ごとに分けて描画する（見た目と幅は変わらない）
            let tx = left + op.x;
            for (const part of op.text.split(/(\d+)/).filter((t) => t !== "")) {
              drawText(part, tx, topY - op.y, op.size, { color: op.color });
              tx += font.widthOfTextAtSize(part, op.size);
            }
          } else if (op.kind === "qr") {
            let img = qrCache.get(op.content);
            if (img === undefined) {
              try {
                img = await doc.embedPng(await renderQrPng(op.content));
              } catch {
                img = null;
              }
              qrCache.set(op.content, img);
            }
            if (img) page.drawImage(img, { x: left + op.x, y: topY - op.y - op.size, width: op.size, height: op.size });
          } else {
            let img = barcodeCache.get(op.content);
            if (img === undefined) {
              const bytes = renderBarcodePng(op.content);
              try {
                img = bytes ? await doc.embedPng(bytes) : null;
              } catch {
                img = null;
              }
              barcodeCache.set(op.content, img);
            }
            if (img) page.drawImage(img, { x: left + op.x, y: topY - op.y - op.h, width: op.w, height: op.h });
          }
        }
        ticketIndex++;
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return { blob, pageCount: doc.getPageCount(), ticketsPerPage, ticketCount: tickets.length };
  }
}

export function buildTicketVoucherFileName(title: string): string {
  const base = title.trim() || "整理券";
  return sanitizeFileName(`${base}.pdf`);
}
