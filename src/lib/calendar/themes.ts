/**
 * 年度カレンダーのデザインテーマ（色の組み合わせ）。ExcelとPDFで同じ値を使う。
 * 色はすべて #RRGGBB。文字色と背景色の組み合わせは、tests/calendar/calendar-themes.spec.ts で
 * 読みやすさ（コントラスト比）を確認している。
 */
import type { DayKind } from "./model";

export type CalendarThemeId = "business" | "natural";

export interface CalendarTheme {
  id: CalendarThemeId;
  label: string;
  description: string;
  /** 月の見出し行（タイトル）の背景色と文字色 */
  titleBg: string;
  titleText: string;
  /** 曜日見出しの背景色 */
  headerBg: string;
  /** 曜日見出しの文字色（平日・土曜・日曜） */
  headerText: string;
  headerSaturdayText: string;
  headerSundayText: string;
  /** 日付行の背景色（種類ごと）と、前後の月の日の背景色 */
  dayBg: Record<DayKind, string>;
  outOfMonthBg: string;
  /** 日付の数字の文字色（種類ごと） */
  dayText: Record<DayKind, string>;
  /** 祝日名の文字色 */
  holidayNameText: string;
  /** 予定記入欄の背景色 */
  memoBg: string;
  memoOutOfMonthBg: string;
  /** 罫線の色 */
  border: string;
  /** 注記の文字色 */
  noteText: string;
  /** Excelのシート見出し（タブ）の色 */
  tabColor: string;
}

export const CALENDAR_THEMES: Record<CalendarThemeId, CalendarTheme> = {
  business: {
    id: "business",
    label: "ビジネス（ネイビー）",
    description: "紺色の見出しで引き締まった、会社・学校の予定表向けのデザイン",
    titleBg: "#1F3864",
    titleText: "#FFFFFF",
    headerBg: "#D9E2F3",
    headerText: "#1F2937",
    headerSaturdayText: "#1F4E9E",
    headerSundayText: "#B42318",
    dayBg: { weekday: "#FFFFFF", saturday: "#EAF0FB", sunday: "#FDECEC", holiday: "#FDECEC" },
    outOfMonthBg: "#F2F2F2",
    dayText: { weekday: "#1F2937", saturday: "#1F4E9E", sunday: "#B42318", holiday: "#B42318" },
    holidayNameText: "#B42318",
    memoBg: "#FFFFFF",
    memoOutOfMonthBg: "#F2F2F2",
    border: "#8EA9DB",
    noteText: "#4B5563",
    tabColor: "#1F3864",
  },
  natural: {
    id: "natural",
    label: "ナチュラル（ベージュ・グリーン）",
    description: "やわらかなベージュと深い緑で、家庭・店舗の掲示にも使いやすいデザイン",
    titleBg: "#4F6B4A",
    titleText: "#FFFFFF",
    headerBg: "#E8E4D0",
    headerText: "#3B3A32",
    headerSaturdayText: "#2F6275",
    headerSundayText: "#A63D2A",
    dayBg: { weekday: "#FBF8EF", saturday: "#E8F1F2", sunday: "#F8E6DF", holiday: "#F8E6DF" },
    outOfMonthBg: "#ECE8DA",
    dayText: { weekday: "#3B3A32", saturday: "#2F6275", sunday: "#A63D2A", holiday: "#A63D2A" },
    holidayNameText: "#A63D2A",
    memoBg: "#FFFEFA",
    memoOutOfMonthBg: "#ECE8DA",
    border: "#B5AE92",
    noteText: "#57534A",
    tabColor: "#4F6B4A",
  },
};

export const CALENDAR_THEME_IDS = Object.keys(CALENDAR_THEMES) as CalendarThemeId[];

export function getCalendarTheme(id: CalendarThemeId): CalendarTheme {
  const theme = CALENDAR_THEMES[id];
  if (!theme) throw new Error(`デザインテーマ「${id}」は選べません`);
  return theme;
}

/** #RRGGBB を 0〜1 の RGB へ */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new Error(`色の指定が正しくありません: ${hex}`);
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
