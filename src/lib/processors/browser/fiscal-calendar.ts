/**
 * 年度カレンダー作成 Processor（Mr.Satto 年度カレンダー作成ツール）。
 *
 * 年度（4月〜翌年3月）・週の始まり・デザイン（プリセットまたはカスタムの4色）・用紙の向き・1シートの月数（1か月/2か月。2か月は横向きなら左右、縦向きなら上下に並べる）・
 * 予定（Excelの予定表から読み込んだもの）を指定して、Excel（1か月=12シート/2か月=6シート）、またはPDF（12ページ/6ページ）を作る。ExcelもPDFも、同じ共通カレンダーデータ（src/lib/calendar/model.ts）から
 * 作るため、日付・曜日・祝日名が一致する。すべてブラウザの中で処理し、外部へは何も送信しない。
 */
import { BrowserProcessor } from "../types";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { placeEvents, type CalendarEvent } from "@/lib/calendar/events";
import { isMonthsPerSheet, type MonthsPerSheet } from "@/lib/calendar/layout";
import {
  CALENDAR_THEME_CHOICES,
  CALENDAR_CUSTOM_ROLE_LABELS,
  invalidCustomRoles,
  resolveCalendarTheme,
  type CalendarCustomPalette,
  type CalendarThemeChoice,
} from "@/lib/calendar/themes";
import { sanitizeFileName } from "@/lib/utils/format";

export type FiscalCalendarFormat = "excel" | "pdf";
export type FiscalCalendarOrientation = "landscape" | "portrait";

export interface FiscalCalendarInput {
  fiscalYear: number;
  weekStart: WeekStart;
  /** プリセットのID、または "custom"（customPalette の4色で配色を決める） */
  theme: CalendarThemeChoice;
  /** theme が "custom" のときの4色（#RRGGBB）。プリセットのときは使わない */
  customPalette?: CalendarCustomPalette;
  orientation: FiscalCalendarOrientation;
  showAdjacentDays: boolean;
  /** 1シート（1ページ）に載せる月数。省略は1か月。2か月は、横向きなら左右、縦向きなら上下に並べる */
  monthsPerSheet?: MonthsPerSheet;
  /** カレンダーに載せる予定（共通の予定モデル）。年度の外の日付の予定は載せない */
  events?: CalendarEvent[];
  format: FiscalCalendarFormat;
}

export interface FiscalCalendarOutput {
  blob: Blob;
  /** Excelはシート数、PDFはページ数（1か月は12、2か月は6） */
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
  if (!CALENDAR_THEME_CHOICES.includes(input.theme)) return "デザインを選んでください";
  if (input.theme === "custom") {
    const bad = invalidCustomRoles(input.customPalette);
    if (bad.length > 0) return `色の指定が正しくありません（${bad.map((r) => CALENDAR_CUSTOM_ROLE_LABELS[r].label).join("・")}）`;
  }
  if (input.orientation !== "landscape" && input.orientation !== "portrait") return "用紙の向きを選んでください";
  if (input.monthsPerSheet !== undefined && !isMonthsPerSheet(input.monthsPerSheet)) return "1シートの月数は、1か月か2か月を選んでください";
  return null;
}

/** 保存するファイル名（例: 2026年度カレンダー_月曜始まり_横.xlsx / 2か月表示は 2026年度カレンダー_月曜始まり_横_2か月.xlsx、縦なら _縦_2か月） */
export function buildFiscalCalendarFileName(input: FiscalCalendarInput): string {
  const week = input.weekStart === "mon" ? "月曜始まり" : "日曜始まり";
  const monthsPerSheet = input.monthsPerSheet ?? 1;
  const direction = input.orientation === "landscape" ? "横" : "縦";
  const suffix = monthsPerSheet === 2 ? "_2か月" : "";
  const ext = input.format === "excel" ? "xlsx" : "pdf";
  return sanitizeFileName(`${input.fiscalYear}年度カレンダー_${week}_${direction}${suffix}.${ext}`);
}

export class FiscalCalendarProcessor extends BrowserProcessor<FiscalCalendarInput, FiscalCalendarOutput> {
  async process(input: FiscalCalendarInput): Promise<FiscalCalendarOutput> {
    const error = validateFiscalCalendarInput(input);
    if (error) throw new Error(error);
    const calendar = buildFiscalCalendar({ fiscalYear: input.fiscalYear, weekStart: input.weekStart });
    // 画面のプレビューと同じ、解決済みのテーマ（プリセットなら4色は使わない）
    const theme = resolveCalendarTheme(input.theme, input.customPalette);
    const monthsPerSheet = input.monthsPerSheet ?? 1;
    const orientation = input.orientation;
    // 画面のプレビューと同じ、年度の範囲で絞った予定（Excel・PDFで別々に予定を解釈しない）
    const events = input.events && input.events.length > 0 ? placeEvents(calendar, input.events).byDate : undefined;
    if (input.format === "excel") {
      const blob = await buildCalendarExcel({
        calendar,
        theme,
        orientation,
        showAdjacentDays: input.showAdjacentDays,
        monthsPerSheet,
        events,
      });
      return { blob, pageCount: monthsPerSheet === 2 ? calendar.months.length / 2 : calendar.months.length };
    }
    return buildCalendarPdf({
      calendar,
      theme,
      orientation,
      showAdjacentDays: input.showAdjacentDays,
      monthsPerSheet,
      events,
    });
  }
}
