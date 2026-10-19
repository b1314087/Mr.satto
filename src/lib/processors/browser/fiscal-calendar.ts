/**
 * 年度カレンダー作成 Processor（Mr.Satto 年度カレンダー作成ツール）。
 *
 * 年度（4月〜翌年3月）・週の始まり・デザイン・用紙の向きを指定して、月別12シートのExcel、
 * または月別12ページのPDFを作る。ExcelもPDFも、同じ共通カレンダーデータ（src/lib/calendar/model.ts）から
 * 作るため、日付・曜日・祝日名が一致する。すべてブラウザの中で処理し、外部へは何も送信しない。
 */
import { BrowserProcessor } from "../types";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { CALENDAR_THEME_IDS, getCalendarTheme, type CalendarThemeId } from "@/lib/calendar/themes";
import { sanitizeFileName } from "@/lib/utils/format";

export type FiscalCalendarFormat = "excel" | "pdf";
export type FiscalCalendarOrientation = "landscape" | "portrait";

export interface FiscalCalendarInput {
  fiscalYear: number;
  weekStart: WeekStart;
  theme: CalendarThemeId;
  orientation: FiscalCalendarOrientation;
  showAdjacentDays: boolean;
  format: FiscalCalendarFormat;
}

export interface FiscalCalendarOutput {
  blob: Blob;
  /** Excelはシート数、PDFはページ数（どちらも12） */
  pageCount: number;
}

/** 画面で選べる年度の範囲（計算できる範囲より狭く、確認済みの範囲に絞っている） */
export const FISCAL_YEAR_UI_MIN = 2020;
export const FISCAL_YEAR_UI_MAX = 2050;

export function validateFiscalCalendarInput(input: FiscalCalendarInput): string | null {
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < FISCAL_YEAR_UI_MIN || input.fiscalYear > FISCAL_YEAR_UI_MAX) {
    return `年度は${FISCAL_YEAR_UI_MIN}〜${FISCAL_YEAR_UI_MAX}年度から選んでください`;
  }
  if (input.weekStart !== "mon" && input.weekStart !== "sun") return "週の始まりは月曜か日曜を選んでください";
  if (!CALENDAR_THEME_IDS.includes(input.theme)) return "デザインを選んでください";
  if (input.orientation !== "landscape" && input.orientation !== "portrait") return "用紙の向きを選んでください";
  return null;
}

/** 保存するファイル名（例: 2026年度カレンダー_月曜始まり_横.xlsx） */
export function buildFiscalCalendarFileName(input: FiscalCalendarInput): string {
  const week = input.weekStart === "mon" ? "月曜始まり" : "日曜始まり";
  const direction = input.orientation === "landscape" ? "横" : "縦";
  const ext = input.format === "excel" ? "xlsx" : "pdf";
  return sanitizeFileName(`${input.fiscalYear}年度カレンダー_${week}_${direction}.${ext}`);
}

export class FiscalCalendarProcessor extends BrowserProcessor<FiscalCalendarInput, FiscalCalendarOutput> {
  async process(input: FiscalCalendarInput): Promise<FiscalCalendarOutput> {
    const error = validateFiscalCalendarInput(input);
    if (error) throw new Error(error);
    const calendar = buildFiscalCalendar({ fiscalYear: input.fiscalYear, weekStart: input.weekStart });
    const theme = getCalendarTheme(input.theme);
    if (input.format === "excel") {
      const blob = await buildCalendarExcel({
        calendar,
        theme,
        orientation: input.orientation,
        showAdjacentDays: input.showAdjacentDays,
      });
      return { blob, pageCount: calendar.months.length };
    }
    return buildCalendarPdf({
      calendar,
      theme,
      orientation: input.orientation,
      showAdjacentDays: input.showAdjacentDays,
    });
  }
}
