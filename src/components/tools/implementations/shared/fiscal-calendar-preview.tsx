"use client";

import { fitEventLines, formatEventLine, hiddenCountLabel, type CalendarEventMap } from "@/lib/calendar/events";
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
  events,
  pair = false,
  stacked = false,
}: {
  calendar: FiscalCalendar;
  month: CalendarMonth;
  theme: CalendarTheme;
  landscape: boolean;
  showAdjacentDays: boolean;
  /** 日付ごとの予定（共通の予定モデル。Excel・PDFと同じもの） */
  events?: CalendarEventMap;
  /** 2か月表示のうちの1か月ぶん（幅が狭いので、文字を小さくし、予定の表示行数を減らす） */
  pair?: boolean;
  /** 2か月を上下に並べる（A4縦）うちの1か月ぶん。幅が広いので、左右に並べるより文字を大きくし、予定も多く出す */
  stacked?: boolean;
}) {
  const maxEventLines = pair && !stacked ? 2 : 3;
  return (
    <div
      data-testid="calendar-preview"
      data-theme={theme.id}
      data-month={`${month.year}-${String(month.month).padStart(2, "0")}`}
      className={`overflow-hidden rounded-lg border leading-tight ${
        stacked ? "aspect-[190/138] text-[10px]" : pair ? "aspect-[297/210] text-[9px] sm:aspect-[136/190]" : "text-[11px]"
      }`}
      style={pair || stacked ? { borderColor: theme.border } : { borderColor: theme.border, aspectRatio: landscape ? "297 / 210" : "210 / 297" }}
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
                    <span className={pair && !stacked ? "text-[7px]" : "text-[9px]"} style={{ color: theme.holidayNameText }}>
                      {holidayDisplayName(day)}
                    </span>
                  )}
                  {!faded && <PreviewEvents events={events?.get(day.iso)} maxLines={maxEventLines} color={theme.headerText} pair={pair && !stacked} />}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** そのマスの予定。入りきらない分は「他N件」にまとめる（Excelには全件が入る） */
function PreviewEvents({ events, maxLines, color, pair }: { events: ReturnType<NonNullable<CalendarEventMap["get"]>> | undefined; maxLines: number; color: string; pair: boolean }) {
  if (!events || events.length === 0) return null;
  const { shown, hiddenCount } = fitEventLines(events, maxLines);
  const size = pair ? "text-[7px]" : "text-[9px]";
  return (
    <div data-testid="calendar-preview-events" className={`mt-px flex flex-col ${size}`} style={{ color }}>
      {shown.map((e) => (
        <span key={`${e.sourceRow}`} data-testid="calendar-preview-event" title={formatEventLine(e)} className="truncate">
          {pair ? e.title : formatEventLine(e)}
        </span>
      ))}
      {hiddenCount > 0 && (
        <span data-testid="calendar-preview-more" className="opacity-80">
          {hiddenCountLabel(hiddenCount, shown.length)}
        </span>
      )}
    </div>
  );
}
