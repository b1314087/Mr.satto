"use client";

import { holidayDisplayName, type CalendarMonth, type FiscalCalendar } from "@/lib/calendar/model";
import type { CalendarTheme } from "@/lib/calendar/themes";

/**
 * 年度カレンダーのプレビュー（1か月ぶんの表）。出力するExcel・PDFと同じ共通データ
 * （FiscalCalendar）から、同じ色・同じ並びで描く。
 */
export function FiscalCalendarPreview({
  calendar,
  month,
  theme,
  landscape,
  showAdjacentDays,
}: {
  calendar: FiscalCalendar;
  month: CalendarMonth;
  theme: CalendarTheme;
  landscape: boolean;
  showAdjacentDays: boolean;
}) {
  return (
    <div
      data-testid="calendar-preview"
      data-month={`${month.year}-${String(month.month).padStart(2, "0")}`}
      className="overflow-hidden rounded-lg border text-[11px] leading-tight"
      style={{ borderColor: theme.border, aspectRatio: landscape ? "297 / 210" : "210 / 297" }}
    >
      <div className="flex items-center justify-between px-3 py-1.5" style={{ background: theme.titleBg, color: theme.titleText }}>
        <span className="text-base font-semibold">
          {month.year}年{month.month}月
        </span>
        <span className="text-[10px]">
          {month.eraLabel}　{calendar.fiscalYear}年度
        </span>
      </div>
      <div className="grid grid-cols-7" style={{ background: theme.headerBg }}>
        {calendar.weekdayOrder.map((weekday, c) => (
          <div
            key={c}
            className="border-l py-0.5 text-center first:border-l-0"
            style={{
              borderColor: theme.border,
              color: weekday === 6 ? theme.headerSaturdayText : weekday === 0 ? theme.headerSundayText : theme.headerText,
            }}
          >
            {calendar.weekdayLabels[c]}
          </div>
        ))}
      </div>
      <div
        className="grid grid-cols-7"
        style={{ gridTemplateRows: `repeat(${month.weeks.length}, minmax(0, 1fr))`, height: "calc(100% - 3.4rem)" }}
      >
        {month.weeks.flat().map((day) => {
          const faded = !day.inMonth;
          return (
            <div
              key={day.iso}
              data-testid="calendar-preview-cell"
              data-date={day.iso}
              data-kind={day.kind}
              className="overflow-hidden border-l border-t px-1 pt-0.5"
              style={{
                borderColor: theme.border,
                background: faded ? theme.outOfMonthBg : theme.dayBg[day.kind],
              }}
            >
              {(!faded || showAdjacentDays) && (
                <>
                  <span className="mr-1 text-xs" style={{ color: faded ? theme.noteText : theme.dayText[day.kind] }}>
                    {day.day}
                  </span>
                  {!faded && day.holiday && (
                    <span className="text-[9px]" style={{ color: theme.holidayNameText }}>
                      {holidayDisplayName(day)}
                    </span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
