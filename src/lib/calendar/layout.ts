/**
 * 年度カレンダーの「1シート（1ページ）に何か月を載せるか」の決まり（Mr.Satto 年度カレンダー作成ツール）。
 *
 *   1か月: 1シート=1か月（12シート / 12ページ）。従来の形式。
 *   2か月: 1シート=2か月（6シート / 6ページ）。年度の並びのまま、4月+5月・6月+7月・8月+9月・10月+11月・12月+1月・2月+3月。
 *          左に前の月、右に次の月を横に並べる。A4横に無理なく収めるため、2か月は横向きだけにする。
 *
 * 画面のプレビュー・Excel・PDFは、必ずここで同じ組み合わせを決める（出力ごとに別の組み合わせ方をしない）。
 */
import type { CalendarMonth, FiscalCalendar } from "./model";

export type MonthsPerSheet = 1 | 2;
export const MONTHS_PER_SHEET_CHOICES: MonthsPerSheet[] = [1, 2];

export function isMonthsPerSheet(value: unknown): value is MonthsPerSheet {
  return value === 1 || value === 2;
}

/** 年度の12か月を、1シートぶん（1か月または2か月）ずつのまとまりに分ける */
export function groupMonths(calendar: FiscalCalendar, monthsPerSheet: MonthsPerSheet): CalendarMonth[][] {
  const groups: CalendarMonth[][] = [];
  for (let i = 0; i < calendar.months.length; i += monthsPerSheet) groups.push(calendar.months.slice(i, i + monthsPerSheet));
  return groups;
}

/** シート名（例: 4月 / 4月・5月 / 12月・1月）。Excelのシート名に使えない文字を含まない */
export function sheetNameOf(months: readonly CalendarMonth[]): string {
  return months.map((m) => `${m.month}月`).join("・");
}

/** 画面の月の切り替えボタンの表示（例: 4月 / 4・5月 / 12・1月） */
export function groupButtonLabel(months: readonly CalendarMonth[]): string {
  return months.length === 1 ? `${months[0].month}月` : `${months.map((m) => m.month).join("・")}月`;
}

/** 用紙の向き。2か月は横向きに限る */
export function effectiveOrientation<T extends "landscape" | "portrait">(orientation: T, monthsPerSheet: MonthsPerSheet): T | "landscape" {
  return monthsPerSheet === 2 ? "landscape" : orientation;
}
