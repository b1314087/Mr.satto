/**
 * 年度カレンダーの共通データモデル（Mr.Satto 年度カレンダー作成ツール）。
 *
 * ExcelもPDFも、必ずこのモデルだけを見て描く。日付・曜日・祝日名・色分けの種類を
 * ここで一度だけ決めるので、2つの出力で内容がずれることがない。
 * 年度は4月〜翌年3月（例: 2026年度 = 2026年4月〜2027年3月）。
 */
import { addDaysIso, getHolidayMap, toIso, weekdayOfIso, type Holiday, type HolidayStatus } from "./holidays";

export type WeekStart = "mon" | "sun";

/** 色分けの種類。祝日は土日より優先する（土曜が祝日のときも祝日の色） */
export type DayKind = "weekday" | "saturday" | "sunday" | "holiday";

export const FISCAL_YEAR_MIN = 2000;
export const FISCAL_YEAR_MAX = 2098;

export interface CalendarDay {
  /** YYYY-MM-DD */
  iso: string;
  year: number;
  month: number;
  day: number;
  /** 0=日曜 … 6=土曜 */
  weekday: number;
  /** その月の日か（前後の月の日は false） */
  inMonth: boolean;
  kind: DayKind;
  holiday: { name: string; status: HolidayStatus; kind: Holiday["kind"] } | null;
}

export interface CalendarMonth {
  year: number;
  month: number;
  /** 例: 令和8年4月 */
  eraLabel: string;
  /** 週ごとの日（各週は7日。前後の月の日も含む） */
  weeks: CalendarDay[][];
  /** この月の祝日（日付順） */
  holidays: CalendarDay[];
  /** 公示前の推定日（春分・秋分など）を含むか */
  hasEstimatedHoliday: boolean;
  /** 暦要項の公示済みの年より先で、祝日法の定めだけで決まる祝日（元日・海の日など）を含むか。法改正があれば変わりうる */
  hasStatutoryHoliday: boolean;
}

export interface FiscalCalendar {
  fiscalYear: number;
  /** 例: 2026年度（令和8年度） */
  fiscalYearLabel: string;
  weekStart: WeekStart;
  /** 列見出し（例: 月〜日）。weekStart に合わせた並び */
  weekdayLabels: string[];
  /** 列見出しに対応する曜日（0=日曜 … 6=土曜） */
  weekdayOrder: number[];
  months: CalendarMonth[];
  hasEstimatedHoliday: boolean;
  hasStatutoryHoliday: boolean;
}

const WEEKDAY_CHARS = ["日", "月", "火", "水", "木", "金", "土"];

export const ESTIMATED_MARK = "※";

/**
 * 祝日の確度と、画面・Excel・PDFに出す注記の決まり（3つの出力は、必ず monthNote() を使う）。
 *
 *   確定（confirmed）  : CONFIRMED_THROUGH_YEAR（暦要項の公示済み、内閣府の公式CSVにある年）まで。注記なし。
 *   法律どおり（statutory）: それより先で、祝日法の定めだけで日付が決まる祝日。「※」は付けないが、
 *                          法改正で変わりうるため、月の注記で知らせる。
 *   推定（estimated）  : それより先の春分の日・秋分の日と、それに伴う振替休日・国民の休日。「※」を付ける。
 *
 * 「※」は推定の日だけに付ける。年度の祝日すべてに一律で付けることはしない。
 */
export const ESTIMATED_NOTE =
  "※は国立天文台の暦要項が公示される前の推定日です（春分の日・秋分の日と、それに伴う休日）。";
export const STATUTORY_NOTE = "祝日は現行の祝日法にもとづく日付です。法改正などで変わることがあります。";
export const ESTIMATED_AND_STATUTORY_NOTE =
  "※は暦要項の公示前の推定日です。ほかの祝日は現行の祝日法による日付で、法改正で変わることがあります。";

/** その月の下に出す注記。確定済みの祝日だけの月は null（注記なし） */
export function monthNote(month: Pick<CalendarMonth, "hasEstimatedHoliday" | "hasStatutoryHoliday">): string | null {
  if (month.hasEstimatedHoliday && month.hasStatutoryHoliday) return ESTIMATED_AND_STATUTORY_NOTE;
  if (month.hasEstimatedHoliday) return ESTIMATED_NOTE;
  if (month.hasStatutoryHoliday) return STATUTORY_NOTE;
  return null;
}

/** 平成・令和の年表記（2000年以降のみ対応）。月の初日で元号を判定する */
export function eraLabelOf(year: number, month: number): string {
  const isReiwa = year > 2019 || (year === 2019 && month >= 5);
  if (isReiwa) {
    const n = year - 2018;
    return `令和${n === 1 ? "元" : n}年`;
  }
  return `平成${year - 1988}年`;
}

/** 年度の和暦表記。2019年度以降は令和（2019年度は令和元年度）、2018年度以前は平成 */
export function fiscalYearEraLabel(fiscalYear: number): string {
  if (fiscalYear >= 2019) {
    const n = fiscalYear - 2018;
    return `令和${n === 1 ? "元" : n}年度`;
  }
  return `平成${fiscalYear - 1988}年度`;
}

function assertFiscalYear(fy: number): void {
  if (!Number.isInteger(fy) || fy < FISCAL_YEAR_MIN || fy > FISCAL_YEAR_MAX) {
    throw new RangeError(`対応している年度は${FISCAL_YEAR_MIN}〜${FISCAL_YEAR_MAX}年度です（指定: ${fy}）`);
  }
}

function dayKind(weekday: number, hasHoliday: boolean): DayKind {
  if (hasHoliday) return "holiday";
  if (weekday === 0) return "sunday";
  if (weekday === 6) return "saturday";
  return "weekday";
}

export function buildMonth(year: number, month: number, weekStart: WeekStart): CalendarMonth {
  const first = toIso(year, month, 1);
  const startWeekday = weekStart === "mon" ? 1 : 0;
  const offset = (weekdayOfIso(first) - startWeekday + 7) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekCount = Math.ceil((offset + daysInMonth) / 7);
  const gridStart = addDaysIso(first, -offset);

  const holidayCache = new Map<number, Map<string, Holiday>>();
  const holidayOf = (iso: string): Holiday | undefined => {
    const y = Number(iso.slice(0, 4));
    let map = holidayCache.get(y);
    if (!map) {
      // 祝日を求められる範囲（2000〜2099年）の外の日は祝日なしとして扱う
      try {
        map = getHolidayMap(y);
      } catch {
        map = new Map();
      }
      holidayCache.set(y, map);
    }
    return map.get(iso);
  };

  const weeks: CalendarDay[][] = [];
  const holidays: CalendarDay[] = [];
  for (let w = 0; w < weekCount; w++) {
    const row: CalendarDay[] = [];
    for (let c = 0; c < 7; c++) {
      const iso = addDaysIso(gridStart, w * 7 + c);
      const [y, m, d] = iso.split("-").map(Number);
      const weekday = weekdayOfIso(iso);
      const h = holidayOf(iso);
      const day: CalendarDay = {
        iso,
        year: y,
        month: m,
        day: d,
        weekday,
        inMonth: y === year && m === month,
        kind: dayKind(weekday, !!h),
        holiday: h ? { name: h.name, status: h.status, kind: h.kind } : null,
      };
      row.push(day);
      if (day.inMonth && h) holidays.push(day);
    }
    weeks.push(row);
  }
  return {
    year,
    month,
    eraLabel: `${eraLabelOf(year, month)}${month}月`,
    weeks,
    holidays,
    hasEstimatedHoliday: holidays.some((d) => d.holiday?.status === "estimated"),
    hasStatutoryHoliday: holidays.some((d) => d.holiday?.status === "statutory"),
  };
}

export function buildFiscalCalendar(options: { fiscalYear: number; weekStart: WeekStart }): FiscalCalendar {
  const { fiscalYear, weekStart } = options;
  assertFiscalYear(fiscalYear);
  const months: CalendarMonth[] = [];
  for (let i = 0; i < 12; i++) {
    const month = ((3 + i) % 12) + 1;
    const year = i < 9 ? fiscalYear : fiscalYear + 1;
    months.push(buildMonth(year, month, weekStart));
  }
  const weekdayOrder = weekStart === "mon" ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  return {
    fiscalYear,
    fiscalYearLabel: `${fiscalYear}年度（${fiscalYearEraLabel(fiscalYear)}）`,
    weekStart,
    weekdayLabels: weekdayOrder.map((w) => WEEKDAY_CHARS[w]),
    weekdayOrder,
    months,
    hasEstimatedHoliday: months.some((m) => m.hasEstimatedHoliday),
    hasStatutoryHoliday: months.some((m) => m.hasStatutoryHoliday),
  };
}

/** 祝日名の表示用文字列。推定日には「※」を付ける */
export function holidayDisplayName(day: CalendarDay): string {
  if (!day.holiday) return "";
  return day.holiday.status === "estimated" ? `${day.holiday.name}${ESTIMATED_MARK}` : day.holiday.name;
}
