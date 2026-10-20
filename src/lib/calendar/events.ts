/**
 * 年度カレンダーに載せる「予定」の共通モデル（Mr.Satto 年度カレンダー作成ツール）。
 *
 * Excelの予定表の読み込み → このモデル → プレビュー・Excel・PDF、という一本の流れにする。
 * ExcelもPDFも画面のプレビューも、予定の解釈（日付・時刻・並び順・表示用の文字）はここだけで行い、
 * 出力ごとに別々の解釈をしない。祝日・年度の計算（model.ts / holidays.ts）には触れない。
 */
import type { CalendarMonth, FiscalCalendar } from "./model";

export interface CalendarEvent {
  /** YYYY-MM-DD（Excelの日付の列を、タイムゾーンに左右されない形で読み取った日付） */
  date: string;
  /** 予定名（空にはならない） */
  title: string;
  /** 開始時刻 HH:MM（24時間表記）。なければ null（終日・時刻なし） */
  startTime: string | null;
  /** 終了時刻 HH:MM。なければ null */
  endTime: string | null;
  /** もとのExcelの行番号（1始まり。見出し行を含む、Excelに表示される行番号） */
  sourceRow: number;
}

/** 日付（YYYY-MM-DD）→ その日の予定（表示する順に並んでいる） */
export type CalendarEventMap = Map<string, CalendarEvent[]>;

/** 予定の文字に使えない文字（XMLに書けない制御文字など）を取り除き、改行をそろえる */
export function sanitizeEventText(input: string): string {
  return (
    input
      .replace(/\r\n?/g, "\n")
      // XML 1.0 に書けない文字（タブ・改行以外の制御文字）と、対になっていないサロゲート
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      .trim()
  );
}

/** 1日の中の表示順: 時刻のない予定（終日）が先、そのあとは開始時刻順。同じなら、もとの行の順 */
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const ka = a.startTime ?? "";
  const kb = b.startTime ?? "";
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.sourceRow - b.sourceRow;
}

/** 日付ごとにまとめる（同じ日の予定は、1件も落とさず全部残す） */
export function groupEventsByDate(events: readonly CalendarEvent[]): CalendarEventMap {
  const map: CalendarEventMap = new Map();
  for (const e of events) {
    const list = map.get(e.date);
    if (list) list.push(e);
    else map.set(e.date, [e]);
  }
  for (const list of map.values()) list.sort(compareEvents);
  return map;
}

/** 予定1件の表示用の文字（例: 10:00-11:00 営業会議 / 10:00 営業会議 / 営業会議） */
export function formatEventLine(e: Pick<CalendarEvent, "title" | "startTime" | "endTime">): string {
  const time = e.startTime ? (e.endTime ? `${e.startTime}-${e.endTime}` : e.startTime) : e.endTime ? `〜${e.endTime}` : "";
  return time ? `${time} ${e.title}` : e.title;
}

/** Excelの1つのセルに入れる文字（その日の予定を改行でつなぐ。全件を残す） */
export function eventsCellText(events: readonly CalendarEvent[]): string {
  return events.map(formatEventLine).join("\n");
}

/** カレンダーが扱う日付の範囲（年度の初日〜末日）。例: 2027年度 = 2027-04-01 〜 2028-03-31 */
export function calendarDateRange(calendar: FiscalCalendar): { start: string; end: string } {
  const first = calendar.months[0];
  const last = calendar.months[calendar.months.length - 1];
  const lastDay = new Date(Date.UTC(last.year, last.month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${first.year}-${pad(first.month)}-01`, end: `${last.year}-${pad(last.month)}-${pad(lastDay)}` };
}

export interface PlacedEvents {
  /** 年度の中に収まる予定（カレンダーに載る） */
  inRange: CalendarEvent[];
  /** 年度の外の予定（カレンダーには載らない。別の年度へ動かさない） */
  outOfRange: CalendarEvent[];
  /** 日付 → 予定（inRange だけ） */
  byDate: CalendarEventMap;
}

/** 予定を年度の範囲で分ける。年度の外の日付は、別の年度へ動かさずそのまま「範囲外」にする */
export function placeEvents(calendar: FiscalCalendar, events: readonly CalendarEvent[]): PlacedEvents {
  const { start, end } = calendarDateRange(calendar);
  const inRange: CalendarEvent[] = [];
  const outOfRange: CalendarEvent[] = [];
  for (const e of events) (e.date >= start && e.date <= end ? inRange : outOfRange).push(e);
  return { inRange, outOfRange, byDate: groupEventsByDate(inRange) };
}

/** 月の中（前後の月の日を除く）の予定の件数 */
export function countEventsInMonth(month: CalendarMonth, byDate: CalendarEventMap): number {
  let n = 0;
  for (const week of month.weeks) for (const d of week) if (d.inMonth) n += byDate.get(d.iso)?.length ?? 0;
  return n;
}

/**
 * 表示できる行数に収まらない予定を「他N件」にまとめる。
 * lines: そのマスに出せる行数（予定1件=1行として数える）。予定が収まるなら、そのまま全件を返す。
 * 収まらないときは、最後の1行を「他N件」に使う（lines が 1 のときは「N件の予定」）。
 */
export function fitEventLines(events: readonly CalendarEvent[], lines: number): { shown: CalendarEvent[]; hiddenCount: number } {
  if (lines <= 0) return { shown: [], hiddenCount: events.length };
  if (events.length <= lines) return { shown: [...events], hiddenCount: 0 };
  const keep = Math.max(0, lines - 1);
  return { shown: events.slice(0, keep), hiddenCount: events.length - keep };
}

export function hiddenCountLabel(hiddenCount: number, shownCount: number): string {
  return shownCount === 0 ? `予定${hiddenCount}件` : `他${hiddenCount}件`;
}
