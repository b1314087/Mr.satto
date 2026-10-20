/**
 * 年度カレンダーのPDF出力（月別12ページ、または2か月ずつ6ページ・A4）。
 *
 * Excelを経由せず、同じ共通モデル（FiscalCalendar）から pdf-lib で直接描く。日本語はNoto Sans JPを埋め込む。
 * 1ページ=1か月（2か月のときは、A4横なら左右、A4縦なら上下に並べる。前の月が左／上）。日付の数字と祝日名は各マスの左上に置き、祝日名がマスに収まらないときは
 * 文字を小さくし、それでも収まらなければ2行に折り返す（マスからはみ出す・隣と重なることがないようにする）。
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { createTextDrawer, wrapTextByWidth } from "@/lib/pdf/text-draw";
import { mmToPt, resolvePaperSizePt } from "@/lib/print/paper-sizes";
import { formatEventLine, type CalendarEvent, type CalendarEventMap } from "./events";
import { groupMonths, sheetArrangement, type MonthsPerSheet } from "./layout";
import { holidayDisplayName, monthNote, type CalendarMonth, type FiscalCalendar } from "./model";
import { hexToRgb01, type CalendarTheme } from "./themes";

export type CalendarPdfOrientation = "landscape" | "portrait";

export interface CalendarPdfOptions {
  calendar: FiscalCalendar;
  theme: CalendarTheme;
  orientation: CalendarPdfOrientation;
  showAdjacentDays?: boolean;
  /** 1ページに載せる月数（既定は1か月=12ページ。2か月=6ページ。横向きは左右、縦向きは上下に並べる） */
  monthsPerSheet?: MonthsPerSheet;
  /** 日付ごとの予定。各日のマスの、日付・祝日名の下に表示する（入りきらない分は「他N件」） */
  events?: CalendarEventMap;
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

/** 2か月を1ページに並べるときの寸法（A4横は左右、A4縦は上下。月の間に余白を入れる） */
const PAIR_GAP = 14;
/** 上下に並べる（A4縦）ときの、月の間の余白と、注記の高さ（幅が広いので注記は1行に収まる） */
const STACK_GAP = 16;
const STACK_NOTE_H = 16;
const PAIR_TITLE_H = 28;
const PAIR_HEADER_H = 16;
const PAIR_NOTE_H = 22;

/** 1か月を描く領域（ページの中での横の位置と、縦の位置・行の高さ） */
interface MonthFrame {
  left: number;
  width: number;
  titleTop: number;
  titleH: number;
  headerTop: number;
  headerH: number;
  gridTop: number;
  rowHeight: number;
  noteBaselineY: number;
}

/** 文字の大きさ（1か月と、2か月を並べるときの小さめの設定） */
interface PdfMetrics {
  titleSize: number;
  subSize: number;
  headerSize: number;
  numberSize: number;
  nameBase: number;
  eventSize: number;
  noteSize: number;
  titleX: number;
  compact: boolean;
}

/** 2か月を上下に並べる（A4縦）ときの文字の大きさ。各月の幅は1か月の縦向きと同じなので、左右に並べるときより少し大きくできる */
const STACKED_METRICS: PdfMetrics = {
  titleSize: 16,
  subSize: 9,
  headerSize: 10,
  numberSize: 12,
  nameBase: 8,
  eventSize: 7,
  noteSize: 7,
  titleX: 8,
  compact: true,
};

const metricsFor = (landscape: boolean, compact: boolean): PdfMetrics =>
  compact
    ? { titleSize: 15, subSize: 8.5, headerSize: 9, numberSize: 11, nameBase: 6.5, eventSize: 6.5, noteSize: 6.5, titleX: 6, compact }
    : {
        titleSize: landscape ? 22 : 20,
        subSize: landscape ? 11 : 10,
        headerSize: 11,
        numberSize: landscape ? 16 : 14,
        nameBase: landscape ? 10 : 8.5,
        eventSize: landscape ? 8 : 7,
        noteSize: 7.5,
        titleX: 8,
        compact,
      };

/** 1か月ぶんのフレーム（ページ全体に1か月） */
function singleFrame(weekCount: number, orientation: CalendarPdfOrientation): MonthFrame {
  const L = pdfMonthLayout(weekCount, orientation);
  return {
    left: L.margin,
    width: L.contentWidth,
    titleTop: L.titleTop,
    titleH: TITLE_H,
    headerTop: L.headerTop,
    headerH: HEADER_H,
    gridTop: L.gridTop,
    rowHeight: L.rowHeight,
    noteBaselineY: L.noteBaselineY,
  };
}

/** 2か月ぶんのフレーム（A4横。左に前の月、右に次の月。行の高さは週数の多い方に合わせる） */
function pairFrames(maxWeekCount: number): { left: MonthFrame; right: MonthFrame } {
  const page = resolvePaperSizePt("A4", "landscape");
  const margin = mmToPt(PDF_MARGIN_MM);
  const contentWidth = page.width - margin * 2;
  const contentHeight = page.height - margin * 2;
  const width = (contentWidth - PAIR_GAP) / 2;
  const titleTop = page.height - margin;
  const headerTop = titleTop - PAIR_TITLE_H;
  const gridTop = headerTop - PAIR_HEADER_H;
  const gridHeight = contentHeight - PAIR_TITLE_H - PAIR_HEADER_H - PAIR_NOTE_H;
  const common = {
    width,
    titleTop,
    titleH: PAIR_TITLE_H,
    headerTop,
    headerH: PAIR_HEADER_H,
    gridTop,
    rowHeight: gridHeight / maxWeekCount,
    noteBaselineY: margin + 4,
  };
  return { left: { ...common, left: margin }, right: { ...common, left: margin + width + PAIR_GAP } };
}

/**
 * 予定をマスの中に描く。マスの幅で折り返し、入りきらない予定は「他N件」にまとめる（マスからはみ出さない）。
 * 行数の足りないときは、最後の1行を「他N件」に使う。1行も出せないときは何も描かない。
 */
export function layoutEventLines(
  font: PDFFont,
  events: readonly CalendarEvent[],
  size: number,
  width: number,
  maxLines: number,
): { lines: string[]; hiddenCount: number } {
  if (events.length === 0 || maxLines <= 0) return { lines: [], hiddenCount: events.length };
  const wrapped = events.map((e) => wrapTextByWidth(formatEventLine(e).replace(/\s*\n+\s*/g, " "), font, size, width));
  const total = wrapped.reduce((n, w) => n + w.length, 0);
  if (total <= maxLines) return { lines: wrapped.flat(), hiddenCount: 0 };
  const room = maxLines - 1; // 最後の1行は「他N件」のために空けておく
  const lines: string[] = [];
  let shown = 0;
  for (const w of wrapped) {
    if (lines.length + w.length > room) break;
    lines.push(...w);
    shown++;
  }
  const hidden = events.length - shown;
  lines.push(shown === 0 ? `予定${hidden}件` : `他${hidden}件`);
  return { lines: lines.slice(0, maxLines), hiddenCount: hidden };
}

/** 2か月を上下に並べるフレーム（A4縦。上に前の月、下に次の月。行の高さは週数の多い方に合わせ、上下で同じにする） */
function stackedFrames(maxWeekCount: number): { top: MonthFrame; bottom: MonthFrame } {
  const page = resolvePaperSizePt("A4", "portrait");
  const margin = mmToPt(PDF_MARGIN_MM);
  const contentWidth = page.width - margin * 2;
  const contentHeight = page.height - margin * 2;
  const halfHeight = (contentHeight - STACK_GAP) / 2;
  const gridHeight = halfHeight - PAIR_TITLE_H - PAIR_HEADER_H - STACK_NOTE_H;
  const frameAt = (titleTop: number): MonthFrame => ({
    left: margin,
    width: contentWidth,
    titleTop,
    titleH: PAIR_TITLE_H,
    headerTop: titleTop - PAIR_TITLE_H,
    headerH: PAIR_HEADER_H,
    gridTop: titleTop - PAIR_TITLE_H - PAIR_HEADER_H,
    rowHeight: gridHeight / maxWeekCount,
    // 注記は、それぞれの月の枠の下端（上の月は半分の位置、下の月はページの下端）
    noteBaselineY: titleTop - halfHeight + 4,
  });
  const top = page.height - margin;
  return { top: frameAt(top), bottom: frameAt(top - halfHeight - STACK_GAP) };
}

function drawMonth(
  page: PDFPage,
  font: PDFFont,
  month: CalendarMonth,
  cal: FiscalCalendar,
  theme: CalendarTheme,
  frame: MonthFrame,
  metrics: PdfMetrics,
  showAdjacentDays: boolean,
  events: CalendarEventMap | undefined,
): void {
  const { drawText } = createTextDrawer(page, font);
  const L = frame;
  const cellWidth = L.width / 7;
  const rgbArr = (hex: string) => hexToRgb01(hex);
  // 白黒（noFill）のテーマでは、矩形を塗らず、罫線だけを描く。それ以外は指定色で塗る
  const fillOf = (hex: string) => (theme.noFill ? {} : { color: rgbOf(hex) });

  // タイトル帯（白黒のテーマだけは、塗らない代わりに枠線で囲む）
  page.drawRectangle({
    x: L.left,
    y: L.titleTop - L.titleH,
    width: L.width,
    height: L.titleH,
    ...fillOf(theme.titleBg),
    ...(theme.noFill ? { borderColor: rgbOf(theme.border), borderWidth: 0.6 } : {}),
  });
  drawText(`${month.year}年${month.month}月`, L.left + metrics.titleX, L.titleTop - L.titleH + (metrics.compact ? 8 : 9), metrics.titleSize, {
    color: rgbArr(theme.titleText),
  });
  drawText(`${month.eraLabel}　${cal.fiscalYear}年度`, L.left + L.width - metrics.titleX, L.titleTop - L.titleH + (metrics.compact ? 9 : 11), metrics.subSize, {
    color: rgbArr(theme.titleText),
    align: "right",
  });

  // 曜日見出し
  cal.weekdayOrder.forEach((weekday, c) => {
    const x = L.left + c * cellWidth;
    page.drawRectangle({
      x,
      y: L.headerTop - L.headerH,
      width: cellWidth,
      height: L.headerH,
      ...fillOf(theme.headerBg),
      borderColor: rgbOf(theme.border),
      borderWidth: 0.6,
    });
    const color = weekday === 6 ? theme.headerSaturdayText : weekday === 0 ? theme.headerSundayText : theme.headerText;
    drawText(cal.weekdayLabels[c], x + cellWidth / 2, L.headerTop - L.headerH + (metrics.compact ? 5 : 6), metrics.headerSize, {
      color: rgbArr(color),
      align: "center",
    });
  });

  // 日付のマス
  const { numberSize, nameBase } = metrics;
  month.weeks.forEach((week, w) => {
    week.forEach((day, c) => {
      const x = L.left + c * cellWidth;
      const top = L.gridTop - w * L.rowHeight;
      const faded = !day.inMonth;
      page.drawRectangle({
        x,
        y: top - L.rowHeight,
        width: cellWidth,
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
      if (faded) return;

      // 予定を描き始める位置（日付の数字・祝日名の下）
      let belowY = numberBaseline - numberSize * 0.35;
      if (day.holiday) {
        const name = holidayDisplayName(day);
        const numberWidth = font.widthOfTextAtSize(numberText, numberSize);
        const inner = cellWidth - CELL_PAD * 2;
        const layout = layoutHolidayName(font, name, nameBase, inner - numberWidth - 4, inner);
        if (layout.sameLine) {
          drawText(name, x + CELL_PAD + numberWidth + 4, numberBaseline, layout.size, { color: rgbArr(theme.holidayNameText) });
        } else {
          layout.lines.forEach((line, i) => {
            drawText(line, x + CELL_PAD, numberBaseline - numberSize * 0.3 - layout.size * (1.1 + i * 1.15), layout.size, {
              color: rgbArr(theme.holidayNameText),
            });
          });
          belowY = numberBaseline - numberSize * 0.3 - layout.size * (1.1 + (layout.lines.length - 1) * 1.15) - layout.size * 0.3;
        }
      }

      const dayEvents = events?.get(day.iso);
      if (dayEvents && dayEvents.length > 0) {
        const size = metrics.eventSize;
        const lineH = size * 1.2;
        const bottom = top - L.rowHeight + CELL_PAD;
        const maxLines = Math.floor((belowY - bottom) / lineH);
        const { lines } = layoutEventLines(font, dayEvents, size, cellWidth - CELL_PAD * 2, maxLines);
        lines.forEach((line, i) => {
          // 予定の文字は、平日の文字と同じ濃さの文字色（見出しの文字色）で描く。テーマの色以外は使わない
          drawText(line, x + CELL_PAD, belowY - size - i * lineH, size, { color: rgbArr(theme.headerText) });
        });
      }
    });
  });

  // 注記
  const note = monthNote(month);
  if (note) {
    if (metrics.compact) {
      // 2か月では幅が狭いため、2行までに折り返す
      const lines = wrapTextByWidth(note, font, metrics.noteSize, L.width).slice(0, 2);
      lines.forEach((line, i) => {
        drawText(line, L.left, L.noteBaselineY + (lines.length - 1 - i) * (metrics.noteSize * 1.15), metrics.noteSize, { color: rgbArr(theme.noteText) });
      });
    } else {
      drawText(note, L.left, L.noteBaselineY, metrics.noteSize, { color: rgbArr(theme.noteText) });
    }
  }
}

function drawSheetPage(
  doc: PDFDocument,
  font: PDFFont,
  months: readonly CalendarMonth[],
  cal: FiscalCalendar,
  theme: CalendarTheme,
  orientation: CalendarPdfOrientation,
  showAdjacentDays: boolean,
  events: CalendarEventMap | undefined,
): void {
  if (months.length === 1) {
    const L = pdfMonthLayout(months[0].weeks.length, orientation);
    const page = doc.addPage([L.pageWidth, L.pageHeight]);
    drawMonth(page, font, months[0], cal, theme, singleFrame(months[0].weeks.length, orientation), metricsFor(orientation === "landscape", false), showAdjacentDays, events);
    return;
  }
  const maxWeeks = Math.max(...months.map((m) => m.weeks.length));
  if (sheetArrangement(orientation, 2) === "stacked") {
    // A4縦: 上に前の月、下に次の月
    const portrait = resolvePaperSizePt("A4", "portrait");
    const stacked = doc.addPage([portrait.width, portrait.height]);
    const frames = stackedFrames(maxWeeks);
    drawMonth(stacked, font, months[0], cal, theme, frames.top, STACKED_METRICS, showAdjacentDays, events);
    drawMonth(stacked, font, months[1], cal, theme, frames.bottom, STACKED_METRICS, showAdjacentDays, events);
    return;
  }
  const page = resolvePaperSizePt("A4", "landscape");
  const sheet = doc.addPage([page.width, page.height]);
  const frames = pairFrames(maxWeeks);
  const metrics = metricsFor(true, true);
  drawMonth(sheet, font, months[0], cal, theme, frames.left, metrics, showAdjacentDays, events);
  drawMonth(sheet, font, months[1], cal, theme, frames.right, metrics, showAdjacentDays, events);
}

/** 年度カレンダーのPDF（月別12ページ、または2か月ずつ6ページ）を作る */
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

  const monthsPerSheet: MonthsPerSheet = options.monthsPerSheet ?? 1;
  const groups = groupMonths(calendar, monthsPerSheet);
  for (const months of groups) {
    drawSheetPage(doc, font, months, calendar, theme, orientation, options.showAdjacentDays ?? false, options.events);
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save();
  } catch {
    throw new Error("PDFの生成に失敗しました");
  }
  return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), pageCount: groups.length };
}
