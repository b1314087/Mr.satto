/**
 * 年度カレンダーのPDF出力（月別12ページ・A4）。
 *
 * Excelを経由せず、同じ共通モデル（FiscalCalendar）から pdf-lib で直接描く。日本語はNoto Sans JPを埋め込む。
 * 1ページ=1か月。日付の数字と祝日名は各マスの左上に置き、祝日名がマスに収まらないときは
 * 文字を小さくし、それでも収まらなければ2行に折り返す（マスからはみ出す・隣と重なることがないようにする）。
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { createTextDrawer, wrapTextByWidth } from "@/lib/pdf/text-draw";
import { mmToPt, resolvePaperSizePt } from "@/lib/print/paper-sizes";
import { holidayDisplayName, monthNote, type CalendarMonth, type FiscalCalendar } from "./model";
import { hexToRgb01, type CalendarTheme } from "./themes";

export type CalendarPdfOrientation = "landscape" | "portrait";

export interface CalendarPdfOptions {
  calendar: FiscalCalendar;
  theme: CalendarTheme;
  orientation: CalendarPdfOrientation;
  showAdjacentDays?: boolean;
  /** 日本語フォントのバイト列。省略するとアプリの /fonts/NotoSansJP-Regular.ttf を取得する（テストでは直接渡す） */
  fontBytes?: ArrayBuffer | Uint8Array;
}

export const PDF_MARGIN_MM = 10;
const TITLE_H = 34;
const HEADER_H = 20;
const NOTE_H = 16;
const CELL_PAD = 4;
const MIN_NAME_SIZE_SAME_LINE = 6.5;
const MIN_NAME_SIZE = 6;

export interface PdfMonthLayout {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  contentWidth: number;
  cellWidth: number;
  rowHeight: number;
  /** グリッド（日付のマス）の上端のY座標（PDF座標、原点左下） */
  gridTop: number;
  titleTop: number;
  headerTop: number;
  noteBaselineY: number;
}

export function pdfMonthLayout(weekCount: number, orientation: CalendarPdfOrientation): PdfMonthLayout {
  const page = resolvePaperSizePt("A4", orientation);
  const margin = mmToPt(PDF_MARGIN_MM);
  const contentWidth = page.width - margin * 2;
  const contentHeight = page.height - margin * 2;
  const titleTop = page.height - margin;
  const headerTop = titleTop - TITLE_H;
  const gridTop = headerTop - HEADER_H;
  const gridHeight = contentHeight - TITLE_H - HEADER_H - NOTE_H;
  return {
    pageWidth: page.width,
    pageHeight: page.height,
    margin,
    contentWidth,
    cellWidth: contentWidth / 7,
    rowHeight: gridHeight / weekCount,
    gridTop,
    titleTop,
    headerTop,
    noteBaselineY: margin + 4,
  };
}

const rgbOf = (hex: string) => rgb(...hexToRgb01(hex));

interface NameLayout {
  lines: string[];
  size: number;
  /** 日付の数字と同じ行（右隣）に置くか、数字の下の行に置くか */
  sameLine: boolean;
}

/** 祝日名の置き方を決める（マスの幅に収まるように、同じ行→小さくする→下の行→折り返し、の順に試す） */
export function layoutHolidayName(
  font: PDFFont,
  name: string,
  baseSize: number,
  availableOnNumberLine: number,
  innerWidth: number,
): NameLayout {
  const widthAt = (s: number) => font.widthOfTextAtSize(name, s);
  let size = baseSize;
  while (size > MIN_NAME_SIZE_SAME_LINE && widthAt(size) > availableOnNumberLine) size -= 0.25;
  if (widthAt(size) <= availableOnNumberLine) return { lines: [name], size, sameLine: true };

  size = baseSize;
  while (size > MIN_NAME_SIZE && widthAt(size) > innerWidth) size -= 0.25;
  if (widthAt(size) <= innerWidth) return { lines: [name], size, sameLine: false };
  return { lines: wrapTextByWidth(name, font, MIN_NAME_SIZE, innerWidth), size: MIN_NAME_SIZE, sameLine: false };
}

function drawMonthPage(
  doc: PDFDocument,
  font: PDFFont,
  month: CalendarMonth,
  cal: FiscalCalendar,
  theme: CalendarTheme,
  orientation: CalendarPdfOrientation,
  showAdjacentDays: boolean,
): void {
  const L = pdfMonthLayout(month.weeks.length, orientation);
  const page: PDFPage = doc.addPage([L.pageWidth, L.pageHeight]);
  const { drawText } = createTextDrawer(page, font);
  const landscape = orientation === "landscape";
  const rgbArr = (hex: string) => hexToRgb01(hex);
  // 白黒（noFill）のテーマでは、矩形を塗らず、罫線だけを描く。それ以外は指定色で塗る
  const fillOf = (hex: string) => (theme.noFill ? {} : { color: rgbOf(hex) });

  // タイトル帯（白黒のテーマだけは、塗らない代わりに枠線で囲む）
  page.drawRectangle({
    x: L.margin,
    y: L.titleTop - TITLE_H,
    width: L.contentWidth,
    height: TITLE_H,
    ...fillOf(theme.titleBg),
    ...(theme.noFill ? { borderColor: rgbOf(theme.border), borderWidth: 0.6 } : {}),
  });
  drawText(`${month.year}年${month.month}月`, L.margin + 8, L.titleTop - TITLE_H + 9, landscape ? 22 : 20, {
    color: rgbArr(theme.titleText),
  });
  drawText(`${month.eraLabel}　${cal.fiscalYear}年度`, L.margin + L.contentWidth - 8, L.titleTop - TITLE_H + 11, landscape ? 11 : 10, {
    color: rgbArr(theme.titleText),
    align: "right",
  });

  // 曜日見出し
  cal.weekdayOrder.forEach((weekday, c) => {
    const x = L.margin + c * L.cellWidth;
    page.drawRectangle({
      x,
      y: L.headerTop - HEADER_H,
      width: L.cellWidth,
      height: HEADER_H,
      ...fillOf(theme.headerBg),
      borderColor: rgbOf(theme.border),
      borderWidth: 0.6,
    });
    const color = weekday === 6 ? theme.headerSaturdayText : weekday === 0 ? theme.headerSundayText : theme.headerText;
    drawText(cal.weekdayLabels[c], x + L.cellWidth / 2, L.headerTop - HEADER_H + 6, 11, { color: rgbArr(color), align: "center" });
  });

  // 日付のマス
  const numberSize = landscape ? 16 : 14;
  const nameBase = landscape ? 10 : 8.5;
  month.weeks.forEach((week, w) => {
    week.forEach((day, c) => {
      const x = L.margin + c * L.cellWidth;
      const top = L.gridTop - w * L.rowHeight;
      const faded = !day.inMonth;
      page.drawRectangle({
        x,
        y: top - L.rowHeight,
        width: L.cellWidth,
        height: L.rowHeight,
        ...fillOf(faded ? theme.outOfMonthBg : theme.dayBg[day.kind]),
        borderColor: rgbOf(theme.border),
        borderWidth: 0.6,
      });
      if (faded && !showAdjacentDays) return;

      const numberText = String(day.day);
      const numberColor = faded ? theme.noteText : theme.dayText[day.kind];
      const numberBaseline = top - CELL_PAD - numberSize * 0.85;
      drawText(numberText, x + CELL_PAD, numberBaseline, numberSize, { color: rgbArr(numberColor) });
      if (faded || !day.holiday) return;

      const name = holidayDisplayName(day);
      const numberWidth = font.widthOfTextAtSize(numberText, numberSize);
      const inner = L.cellWidth - CELL_PAD * 2;
      const layout = layoutHolidayName(font, name, nameBase, inner - numberWidth - 4, inner);
      if (layout.sameLine) {
        drawText(name, x + CELL_PAD + numberWidth + 4, numberBaseline, layout.size, { color: rgbArr(theme.holidayNameText) });
      } else {
        layout.lines.forEach((line, i) => {
          drawText(line, x + CELL_PAD, numberBaseline - numberSize * 0.3 - layout.size * (1.1 + i * 1.15), layout.size, {
            color: rgbArr(theme.holidayNameText),
          });
        });
      }
    });
  });

  // 注記
  const note = monthNote(month);
  if (note) {
    drawText(note, L.margin, L.noteBaselineY, 7.5, { color: rgbArr(theme.noteText) });
  }
}

/** 年度カレンダーのPDF（月別12ページ）を作る */
export async function buildCalendarPdf(options: CalendarPdfOptions): Promise<{ blob: Blob; pageCount: number }> {
  const { calendar, theme, orientation } = options;
  let fontBytes: ArrayBuffer | Uint8Array;
  try {
    fontBytes = options.fontBytes ?? (await loadJapaneseFontBytes());
  } catch {
    throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
  }

  let doc: PDFDocument;
  let font: PDFFont;
  try {
    doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    // 部分埋め込み（subset）にすると一部の文字が欠けることがあるため、既存のPDFツールと同じく全体を埋め込む
    font = await doc.embedFont(fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes), { subset: false });
  } catch {
    throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
  }

  doc.setTitle(`${calendar.fiscalYear}年度 カレンダー`);
  doc.setLanguage("ja");
  doc.setProducer("Mr.Satto");
  doc.setCreator("Mr.Satto");

  for (const month of calendar.months) {
    drawMonthPage(doc, font, month, calendar, theme, orientation, options.showAdjacentDays ?? false);
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save();
  } catch {
    throw new Error("PDFの生成に失敗しました");
  }
  return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), pageCount: calendar.months.length };
}
