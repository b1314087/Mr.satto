/**
 * 年度カレンダーのデザインテーマ（色の組み合わせ）。画面のプレビュー・Excel・PDFで、同じ「解決済みテーマ」を使う。
 * 色はすべて #RRGGBB。文字色と背景色の組み合わせは、tests/calendar/calendar-themes.spec.ts で
 * 読みやすさ（コントラスト比）を確認している。
 *
 * ■ 構成
 *   - プリセット（CALENDAR_THEMES）: ビジネス・ナチュラル（拡張前から変更なし）、シンプル（白黒）、パステル、ブルーグレー。
 *   - カスタム: 利用者が決める4色（CalendarCustomPalette）から、buildCustomTheme() が全項目の色を決める。
 *   - resolveCalendarTheme(): 選択（プリセットのID または "custom" と4色）を、1つの CalendarTheme にする。
 *     プリセットを選んだときは、カスタムの色を一切混ぜない（プリセットの定義をそのまま返す）。
 *
 * ■ カスタムの4色の役割（既存のビジネス・ナチュラルの色の使い方を整理して決めた）
 *   メイン    : 月の見出し帯の背景、Excelのシート見出し（タブ）、曜日見出しの帯の薄い色、土曜日の文字、土曜日のマスの薄い色
 *   アクセント : 日曜日・祝日の文字（日付・祝日名・曜日見出し）、日曜日・祝日のマスの薄い色
 *   背景      : 日付のマスと予定記入欄の背景、各種の薄い色の混ぜ合わせの下地
 *   文字・罫線 : 平日の日付と曜日の文字、罫線、注記、前後の月の日付（それぞれ背景と混ぜて濃さを変える）
 *   見出し帯の上の文字は、メインとの組み合わせで読みやすい白か黒を自動で選ぶ（5つ目の設定項目ではない）。
 */
import type { DayKind } from "./model";

/** 用意されているデザイン（プリセット）のID */
export type CalendarThemeId = "business" | "natural" | "simple" | "pastel" | "bluegray";
/** 選べるデザイン。プリセットのIDか、利用者が4色を決める "custom" */
export type CalendarThemeChoice = CalendarThemeId | "custom";

export interface CalendarTheme {
  id: CalendarThemeChoice;
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
  /** Excelのシート見出し（タブ）の色。null ならタブに色を付けない */
  tabColor: string | null;
  /**
   * true なら、背景色をまったく塗らない（白黒のシンプルなデザイン用）。
   * Excelではセルの塗りつぶしを入れず、PDFでは矩形を塗らず罫線だけを描く。省略（既存のテーマ）は塗る。
   */
  noFill?: boolean;
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
  simple: {
    id: "simple",
    label: "シンプル（白黒）",
    description: "色を使わない白黒のデザイン。コピーや白黒プリンターでも見やすく、インクも節約できます",
    titleBg: "#FFFFFF",
    titleText: "#000000",
    headerBg: "#FFFFFF",
    headerText: "#000000",
    headerSaturdayText: "#000000",
    headerSundayText: "#000000",
    dayBg: { weekday: "#FFFFFF", saturday: "#FFFFFF", sunday: "#FFFFFF", holiday: "#FFFFFF" },
    outOfMonthBg: "#FFFFFF",
    dayText: { weekday: "#000000", saturday: "#000000", sunday: "#000000", holiday: "#000000" },
    holidayNameText: "#000000",
    memoBg: "#FFFFFF",
    memoOutOfMonthBg: "#FFFFFF",
    border: "#000000",
    noteText: "#595959",
    tabColor: null,
    noFill: true,
  },
  pastel: {
    id: "pastel",
    label: "パステル（ピンク）",
    description: "やさしいピンクとブルーの淡い色で、明るくやわらかい印象のデザイン",
    titleBg: "#F5B7CB",
    titleText: "#4A1F33",
    headerBg: "#FCE4EC",
    headerText: "#4A3A44",
    headerSaturdayText: "#2C5A8C",
    headerSundayText: "#A8324F",
    dayBg: { weekday: "#FFFDFE", saturday: "#E6F1FA", sunday: "#FDE6EC", holiday: "#FDE6EC" },
    outOfMonthBg: "#F3EEF1",
    dayText: { weekday: "#4A3A44", saturday: "#2C5A8C", sunday: "#A8324F", holiday: "#A8324F" },
    holidayNameText: "#A8324F",
    memoBg: "#FFFFFF",
    memoOutOfMonthBg: "#F3EEF1",
    border: "#E0B4C4",
    noteText: "#6A5862",
    tabColor: "#E58FAA",
  },
  bluegray: {
    id: "bluegray",
    label: "ブルーグレー",
    description: "落ち着いた青みのグレーで、事務所や資料に合わせやすいデザイン",
    titleBg: "#455A64",
    titleText: "#FFFFFF",
    headerBg: "#CFD8DC",
    headerText: "#263238",
    headerSaturdayText: "#0B4F8A",
    headerSundayText: "#A8201A",
    dayBg: { weekday: "#FFFFFF", saturday: "#E3EBF1", sunday: "#F3E5E5", holiday: "#F3E5E5" },
    outOfMonthBg: "#ECEFF1",
    dayText: { weekday: "#263238", saturday: "#0B4F8A", sunday: "#A8201A", holiday: "#A8201A" },
    holidayNameText: "#A8201A",
    memoBg: "#FFFFFF",
    memoOutOfMonthBg: "#ECEFF1",
    border: "#90A4AE",
    noteText: "#546E7A",
    tabColor: "#455A64",
  },
};

export const CALENDAR_THEME_IDS = Object.keys(CALENDAR_THEMES) as CalendarThemeId[];
/** 画面に並べる順番（プリセット→カスタム） */
export const CALENDAR_THEME_CHOICES: CalendarThemeChoice[] = [...CALENDAR_THEME_IDS, "custom"];

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

// ───────────── カスタム配色 ─────────────

/** カスタム配色の4色（すべて #RRGGBB） */
export interface CalendarCustomPalette {
  /** メインカラー: 月の見出し帯・Excelのタブ・土曜日 */
  main: string;
  /** アクセントカラー: 日曜日・祝日 */
  accent: string;
  /** 背景カラー: 日付のマス・予定記入欄 */
  background: string;
  /** 文字・罫線カラー: 平日の文字・罫線・注記 */
  ink: string;
}

export type CalendarCustomRole = keyof CalendarCustomPalette;
export const CALENDAR_CUSTOM_ROLES: CalendarCustomRole[] = ["main", "accent", "background", "ink"];
export const CALENDAR_CUSTOM_ROLE_LABELS: Record<CalendarCustomRole, { label: string; hint: string }> = {
  main: { label: "メインカラー", hint: "月の見出し帯・Excelのタブ・土曜日の文字" },
  accent: { label: "アクセントカラー", hint: "日曜日・祝日の文字" },
  background: { label: "背景カラー", hint: "日付のマス・予定記入欄" },
  ink: { label: "文字・罫線カラー", hint: "平日の文字・罫線・注記" },
};

/** カスタム配色の初期値（リセットで戻る色）。ビジネスに近い、紺・赤・白・濃い灰色 */
export const CALENDAR_CUSTOM_DEFAULT: Readonly<CalendarCustomPalette> = Object.freeze({
  main: "#1F3864",
  accent: "#B42318",
  background: "#FFFFFF",
  ink: "#1F2937",
});

/**
 * 色の入力を #RRGGBB（大文字）にそろえる。"#abc"・"abc"・"aabbcc"・"#AABBCC" を受け付け、
 * それ以外（空・長さ違い・16進数でない文字・文字列でない値）は null を返す。
 */
export function normalizeHexColor(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(input.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h.toUpperCase()}`;
}

/** 4色のうち正しくない値（未指定・不正な文字列）は、初期値に置き換えて安全な4色にする。例外は投げない */
export function sanitizeCustomPalette(input?: Partial<Record<CalendarCustomRole, unknown>> | null): CalendarCustomPalette {
  const out = { ...CALENDAR_CUSTOM_DEFAULT } as CalendarCustomPalette;
  for (const role of CALENDAR_CUSTOM_ROLES) {
    const v = normalizeHexColor(input?.[role]);
    if (v) out[role] = v;
  }
  return out;
}

/** 4色のうち、正しくない（#RRGGBB にできない）ものの役割を返す。未指定は正しくないものとして数える */
export function invalidCustomRoles(input?: Partial<Record<CalendarCustomRole, unknown>> | null): CalendarCustomRole[] {
  return CALENDAR_CUSTOM_ROLES.filter((role) => normalizeHexColor(input?.[role]) === null);
}

function toRgb255(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
/** fg を alpha（0〜1）の濃さで bg に重ねた色 */
export function blendColors(fg: string, bg: string, alpha: number): string {
  const a = toRgb255(fg);
  const b = toRgb255(bg);
  return toHex([a[0] * alpha + b[0] * (1 - alpha), a[1] * alpha + b[1] * (1 - alpha), a[2] * alpha + b[2] * (1 - alpha)]);
}

function channelLuminance(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb255(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}
/** 2色のコントラスト比（WCAG 2.x の定義。1〜21） */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** 背景の上に置く文字として、白と黒のうち読みやすい方 */
export function readableTextOn(bg: string): "#FFFFFF" | "#000000" {
  return contrastRatio("#FFFFFF", bg) >= contrastRatio("#000000", bg) ? "#FFFFFF" : "#000000";
}

/**
 * カスタムの4色から、全項目の色を決める（上の「4色の役割」参照）。
 * 4色は互いに独立で、1色を変えると、その役割に関わる項目だけが変わる。
 */
export function buildCustomTheme(paletteInput?: Partial<Record<CalendarCustomRole, unknown>> | null): CalendarTheme {
  const { main, accent, background, ink } = sanitizeCustomPalette(paletteInput);
  const faintInk = blendColors(ink, background, 0.06);
  return {
    id: "custom",
    label: "カスタム（4色を自分で選ぶ）",
    description: "メイン・アクセント・背景・文字と罫線の4色を自分で選んで、好みの配色にできます",
    titleBg: main,
    titleText: readableTextOn(main),
    headerBg: blendColors(main, background, 0.18),
    headerText: ink,
    headerSaturdayText: main,
    headerSundayText: accent,
    dayBg: {
      weekday: background,
      saturday: blendColors(main, background, 0.08),
      sunday: blendColors(accent, background, 0.1),
      holiday: blendColors(accent, background, 0.1),
    },
    outOfMonthBg: faintInk,
    dayText: { weekday: ink, saturday: main, sunday: accent, holiday: accent },
    holidayNameText: accent,
    memoBg: background,
    memoOutOfMonthBg: faintInk,
    border: blendColors(ink, background, 0.5),
    noteText: blendColors(ink, background, 0.75),
    tabColor: main,
  };
}

/**
 * 選択（プリセットのID、または "custom" と4色）を、画面・Excel・PDFで共通に使う1つのテーマにする。
 * プリセットを選んだときは、4色が渡されていても一切使わず、プリセットの定義をそのまま返す。
 */
export function resolveCalendarTheme(
  choice: CalendarThemeChoice,
  customPalette?: Partial<Record<CalendarCustomRole, unknown>> | null,
): CalendarTheme {
  if (choice === "custom") return buildCustomTheme(customPalette);
  return getCalendarTheme(choice);
}

/** 色見本に使う4色（テーマ選択ボタンに小さく表示する）: 見出し・曜日見出し・日曜日／祝日・日付のマス */
export function themeSwatchColors(theme: CalendarTheme): [string, string, string, string] {
  return [theme.titleBg, theme.headerBg, theme.dayText.sunday, theme.dayBg.weekday];
}
