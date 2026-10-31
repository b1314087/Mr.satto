/**
 * シフト表（勤務表）作成の規則（純粋な関数だけ。ブラウザの外でもテストできる）。
 *
 * 作るのは「入力した内容を、表にして確認・修正・出力する」ところまで。勤務の自動割り当て・最適化はしない。
 * 労働基準法などの法令に合っているかは判定しない（連続勤務日数・勤務間の休息時間は、利用者が決めた目安に対する警告だけ）。
 */

import { getHoliday } from "@/lib/calendar/holidays";

export const SHIFT_MAX_TYPES = 12;
export const SHIFT_MAX_STAFF = 60;
export const SHIFT_CODE_MAX_LENGTH = 3;
export const SHIFT_NAME_MAX_LENGTH = 20;
export const SHIFT_STAFF_NAME_MAX_LENGTH = 30;
export const SHIFT_MIN_YEAR = 2000;
export const SHIFT_MAX_YEAR = 2099;

export interface ShiftColor {
  id: string;
  label: string;
  /** 表の背景色（淡い色。文字は黒で読める） */
  hex: string;
}

export const SHIFT_COLORS: ShiftColor[] = [
  { id: "blue", label: "青", hex: "#DBEAFE" },
  { id: "green", label: "緑", hex: "#DCFCE7" },
  { id: "amber", label: "黄", hex: "#FEF3C7" },
  { id: "orange", label: "橙", hex: "#FFEDD5" },
  { id: "pink", label: "ピンク", hex: "#FCE7F3" },
  { id: "purple", label: "紫", hex: "#EDE9FE" },
  { id: "teal", label: "青緑", hex: "#CCFBF1" },
  { id: "lime", label: "黄緑", hex: "#ECFCCB" },
  { id: "red", label: "赤", hex: "#FEE2E2" },
  { id: "gray", label: "灰", hex: "#E5E7EB" },
];

export function colorHex(id: string): string {
  return SHIFT_COLORS.find((c) => c.id === id)?.hex ?? SHIFT_COLORS[SHIFT_COLORS.length - 1].hex;
}

export type ShiftKind = "work" | "off";

export interface ShiftType {
  id: string;
  /** 表のセルに出す略称（3文字まで） */
  code: string;
  /** 勤務区分の名前（早番・遅番など） */
  name: string;
  /** work: 勤務 / off: 休み（休日・有給など。実働時間にならない） */
  kind: ShiftKind;
  /** 開始時刻 "HH:MM"（勤務のみ） */
  start: string;
  /** 終了時刻 "HH:MM"。開始以前の時刻は、翌日の時刻（夜勤など） */
  end: string;
  /** 休憩（分） */
  breakMinutes: number;
  color: string;
}

export interface ShiftStaff {
  id: string;
  name: string;
}

export interface ShiftSettings {
  /** 連続勤務日数の上限の目安（0は確認しない） */
  maxConsecutive: number;
  /** 勤務の終わりから次の勤務の始まりまでの、最低限あけたい時間（時間。0は確認しない） */
  minRestHours: number;
  /** 1日に必要な出勤人数（0は確認しない） */
  minStaffPerDay: number;
}

export interface ShiftSchedule {
  title: string;
  year: number;
  month: number;
  types: ShiftType[];
  staff: ShiftStaff[];
  /** スタッフごと・日ごと（0番目が1日）の勤務区分のID。nullは未入力 */
  cells: Record<string, (string | null)[]>;
  settings: ShiftSettings;
}

export const DEFAULT_SETTINGS: ShiftSettings = { maxConsecutive: 6, minRestHours: 11, minStaffPerDay: 0 };

export function defaultTypes(): ShiftType[] {
  return [
    { id: "t1", code: "早", name: "早番", kind: "work", start: "07:00", end: "16:00", breakMinutes: 60, color: "blue" },
    { id: "t2", code: "遅", name: "遅番", kind: "work", start: "12:00", end: "21:00", breakMinutes: 60, color: "orange" },
    { id: "t3", code: "日", name: "日勤", kind: "work", start: "09:00", end: "18:00", breakMinutes: 60, color: "green" },
    { id: "t4", code: "休", name: "休み", kind: "off", start: "", end: "", breakMinutes: 0, color: "gray" },
    { id: "t5", code: "有", name: "有給休暇", kind: "off", start: "", end: "", breakMinutes: 0, color: "pink" },
  ];
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getDay();
}

export interface DayInfo {
  day: number;
  weekday: number;
  weekdayLabel: string;
  /** 祝日の名前（祝日でなければ null） */
  holiday: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthDays(year: number, month: number): DayInfo[] {
  const count = daysInMonth(year, month);
  const out: DayInfo[] = [];
  for (let day = 1; day <= count; day++) {
    const weekday = weekdayOf(year, month, day);
    let holiday: string | null = null;
    if (year >= SHIFT_MIN_YEAR && year <= SHIFT_MAX_YEAR) holiday = getHoliday(`${year}-${pad2(month)}-${pad2(day)}`)?.name ?? null;
    out.push({ day, weekday, weekdayLabel: WEEKDAY_LABELS[weekday], holiday });
  }
  return out;
}

export function validateYearMonth(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < SHIFT_MIN_YEAR || year > SHIFT_MAX_YEAR) return `年は${SHIFT_MIN_YEAR}〜${SHIFT_MAX_YEAR}の間で指定してください。`;
  if (!Number.isInteger(month) || month < 1 || month > 12) return "月は1〜12で指定してください。";
  return null;
}

// ---------------------------------------------------------------------------
// 時刻・勤務区分
// ---------------------------------------------------------------------------

/** "HH:MM"（半角・全角どちらでも可。24:00は終了時刻に限り可）を、0時からの分に直す。読めなければ null */
export function parseTime(raw: string, allow24 = false): number | null {
  const text = raw.normalize("NFKC").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (h === 24 && min === 0 && allow24) return 1440;
  if (h > 23) return null;
  return h * 60 + min;
}

export function formatTime(minutes: number): string {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** 分を「152:30」の形（時間:分）にする */
export function formatDuration(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minutes));
  return `${sign}${Math.floor(abs / 60)}:${pad2(abs % 60)}`;
}

export interface TypeTiming {
  startMinutes: number;
  /** 開始からの経過で表した終了（翌日にまたがるときは1440を足す） */
  endMinutes: number;
  overnight: boolean;
  /** 実働（分）= 拘束 − 休憩 */
  netMinutes: number;
  grossMinutes: number;
}

/** 勤務の勤務区分の時間。時刻が読めない・不正なときは null */
export function timingOf(type: ShiftType): TypeTiming | null {
  if (type.kind !== "work") return null;
  const start = parseTime(type.start);
  const endRaw = parseTime(type.end, true);
  if (start === null || endRaw === null) return null;
  if (start === endRaw) return null;
  const overnight = endRaw <= start;
  const end = overnight ? endRaw + 1440 : endRaw;
  const gross = end - start;
  const brk = type.breakMinutes;
  if (!Number.isInteger(brk) || brk < 0) return null;
  const net = gross - brk;
  if (net <= 0) return null;
  return { startMinutes: start, endMinutes: end, overnight, netMinutes: net, grossMinutes: gross };
}

export function isWork(type: ShiftType | undefined): boolean {
  return !!type && type.kind === "work";
}

/** 勤務区分の入力の不備（利用者が直す項目）。空なら問題なし */
export function validateType(type: ShiftType, all: ShiftType[]): string[] {
  const problems: string[] = [];
  const code = type.code.normalize("NFKC").trim();
  const label = type.name.trim() !== "" ? `「${type.name.trim()}」` : "勤務区分";
  if (code === "") problems.push(`${label}の略称が空です。表のセルに出す、1〜${SHIFT_CODE_MAX_LENGTH}文字の略称を入れてください。`);
  else if (Array.from(code).length > SHIFT_CODE_MAX_LENGTH) problems.push(`${label}の略称が長すぎます（${SHIFT_CODE_MAX_LENGTH}文字までです）。`);
  else if (all.some((t) => t.id !== type.id && t.code.normalize("NFKC").trim() === code)) problems.push(`略称「${code}」が、ほかの勤務区分と重なっています。別の略称にしてください。`);
  if (type.name.trim() === "") problems.push(`略称「${code}」の勤務区分の名前が空です。`);
  else if (Array.from(type.name.trim()).length > SHIFT_NAME_MAX_LENGTH) problems.push(`${label}の名前が長すぎます（${SHIFT_NAME_MAX_LENGTH}文字までです）。`);
  if (type.kind === "work") {
    const start = parseTime(type.start);
    const end = parseTime(type.end, true);
    if (start === null) problems.push(`${label}の開始時刻を、「09:00」のように入れてください（0:00〜23:59）。`);
    if (end === null) problems.push(`${label}の終了時刻を、「18:00」のように入れてください（24:00まで）。`);
    if (start !== null && end !== null) {
      if (start === end) problems.push(`${label}の開始時刻と終了時刻が同じです。`);
      else if (!Number.isInteger(type.breakMinutes) || type.breakMinutes < 0) problems.push(`${label}の休憩は、0以上の整数（分）で入れてください。`);
      else if (timingOf(type) === null) problems.push(`${label}の休憩（${type.breakMinutes}分）が、勤務時間以上になっています。`);
    }
  }
  return problems;
}

export function validateTypes(types: ShiftType[]): string[] {
  const problems: string[] = [];
  if (types.length === 0) problems.push("勤務区分がありません。1つ以上、入れてください。");
  if (types.length > SHIFT_MAX_TYPES) problems.push(`勤務区分は${SHIFT_MAX_TYPES}個までです。`);
  for (const t of types) problems.push(...validateType(t, types));
  return problems;
}

// ---------------------------------------------------------------------------
// スタッフ
// ---------------------------------------------------------------------------

export function normalizeStaffName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function validateStaff(staff: ShiftStaff[]): string[] {
  const problems: string[] = [];
  if (staff.length === 0) problems.push("スタッフがいません。1人以上、入れてください。");
  if (staff.length > SHIFT_MAX_STAFF) problems.push(`スタッフは${SHIFT_MAX_STAFF}人までです。`);
  const seen = new Map<string, number>();
  staff.forEach((s, i) => {
    const key = normalizeStaffName(s.name);
    if (key === "") problems.push(`${i + 1}人目の名前が空です。`);
    else if (Array.from(s.name.trim()).length > SHIFT_STAFF_NAME_MAX_LENGTH) problems.push(`「${s.name.trim().slice(0, 10)}…」の名前が長すぎます（${SHIFT_STAFF_NAME_MAX_LENGTH}文字までです）。`);
    else if (seen.has(key)) problems.push(`「${s.name.trim()}」が重なっています（${seen.get(key)! + 1}人目と${i + 1}人目）。同じ名前の別の人は、「山田(営)」のように区別してください。`);
    else seen.set(key, i);
  });
  return problems;
}

/** 貼り付けた名前（1行に1人。「、」「,」区切りも可）を、名前の一覧にする（空の行は除く。重複は残して、検証で知らせる） */
export function parseStaffNames(text: string): string[] {
  return text
    .split(/\r\n|\r|\n|[、,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// 勤務表の集計・確認
// ---------------------------------------------------------------------------

export function emptyCells(days: number): (string | null)[] {
  return Array.from({ length: days }, () => null);
}

/** 日数が変わった（月を変えた）ときに、セルの長さをそろえる。はみ出す日は捨て、足りない日は未入力にする */
export function resizeCells(cells: (string | null)[] | undefined, days: number): (string | null)[] {
  const base = cells ?? [];
  return Array.from({ length: days }, (_, i) => base[i] ?? null);
}

export interface StaffSummary {
  workDays: number;
  offDays: number;
  blankDays: number;
  workMinutes: number;
}

export interface DaySummary {
  /** 出勤している（勤務の区分が入っている）人数 */
  working: number;
  byType: Record<string, number>;
}

export interface ScheduleSummary {
  perStaff: StaffSummary[];
  perDay: DaySummary[];
}

export function summarize(schedule: ShiftSchedule): ScheduleSummary {
  const days = daysInMonth(schedule.year, schedule.month);
  const typeById = new Map(schedule.types.map((t) => [t.id, t]));
  const timings = new Map(schedule.types.map((t) => [t.id, timingOf(t)]));
  const perDay: DaySummary[] = Array.from({ length: days }, () => ({ working: 0, byType: {} }));
  const perStaff = schedule.staff.map((s) => {
    const row = resizeCells(schedule.cells[s.id], days);
    const sum: StaffSummary = { workDays: 0, offDays: 0, blankDays: 0, workMinutes: 0 };
    row.forEach((id, d) => {
      const type = id === null ? undefined : typeById.get(id);
      if (!type) {
        sum.blankDays++;
        return;
      }
      perDay[d].byType[type.id] = (perDay[d].byType[type.id] ?? 0) + 1;
      if (isWork(type)) {
        sum.workDays++;
        sum.workMinutes += timings.get(type.id)?.netMinutes ?? 0;
        perDay[d].working++;
      } else {
        sum.offDays++;
      }
    });
    return sum;
  });
  return { perStaff, perDay };
}

export type IssueKind = "consecutive" | "rest" | "min-staff" | "blank";

export interface ScheduleIssue {
  kind: IssueKind;
  message: string;
  /** 該当するスタッフのID（あれば） */
  staffId?: string;
  /** 該当する日（1始まり。複数あれば全部） */
  days: number[];
}

function dayLabel(year: number, month: number, day: number): string {
  return `${month}月${day}日(${WEEKDAY_LABELS[weekdayOf(year, month, day)]})`;
}

/** 勤務表の確認（警告）。入力の不備ではなく、決めた目安に合わない箇所を知らせる。勤務区分に不備があるときは、時間の確認はしない */
export function checkSchedule(schedule: ShiftSchedule): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  const { year, month, settings } = schedule;
  const days = daysInMonth(year, month);
  const typeById = new Map(schedule.types.map((t) => [t.id, t]));
  const timings = new Map(schedule.types.map((t) => [t.id, timingOf(t)]));

  for (const s of schedule.staff) {
    const row = resizeCells(schedule.cells[s.id], days);
    const name = s.name.trim() === "" ? "（名前なし）" : s.name.trim();

    // 連続勤務
    if (settings.maxConsecutive > 0) {
      let run: number[] = [];
      const flush = () => {
        if (run.length > settings.maxConsecutive) {
          issues.push({
            kind: "consecutive",
            staffId: s.id,
            days: [...run],
            message: `${name}：${run.length}日連続の勤務です（${dayLabel(year, month, run[0])}〜${dayLabel(year, month, run[run.length - 1])}。目安は${settings.maxConsecutive}日まで）。`,
          });
        }
        run = [];
      };
      row.forEach((id, d) => {
        if (isWork(id === null ? undefined : typeById.get(id))) run.push(d + 1);
        else flush();
      });
      flush();
    }

    // 勤務間の休息時間
    if (settings.minRestHours > 0) {
      for (let d = 0; d + 1 < days; d++) {
        const a = row[d] === null ? undefined : typeById.get(row[d]!);
        const b = row[d + 1] === null ? undefined : typeById.get(row[d + 1]!);
        if (!isWork(a) || !isWork(b)) continue;
        const ta = timings.get(a!.id);
        const tb = timings.get(b!.id);
        if (!ta || !tb) continue;
        const endAbs = d * 1440 + ta.endMinutes;
        const startNext = (d + 1) * 1440 + tb.startMinutes;
        const gap = startNext - endAbs;
        if (gap < settings.minRestHours * 60) {
          issues.push({
            kind: "rest",
            staffId: s.id,
            days: [d + 1, d + 2],
            message: `${name}：${dayLabel(year, month, d + 1)}の「${a!.name}」の終了から、翌日の「${b!.name}」の開始まで、${formatDuration(Math.max(0, gap))}しかあいていません（目安は${settings.minRestHours}時間以上）。`,
          });
        }
      }
    }
  }

  // 1日の人数
  if (settings.minStaffPerDay > 0) {
    const sum = summarize(schedule);
    sum.perDay.forEach((d, i) => {
      if (d.working < settings.minStaffPerDay) {
        issues.push({
          kind: "min-staff",
          days: [i + 1],
          message: `${dayLabel(year, month, i + 1)}：出勤が${d.working}人です（必要人数は${settings.minStaffPerDay}人）。`,
        });
      }
    });
  }

  // 未入力
  const blank = summarize(schedule).perStaff.reduce((sum, s) => sum + s.blankDays, 0);
  if (blank > 0) issues.push({ kind: "blank", days: [], message: `未入力のセルが${blank}個あります（出力では空欄になります）。` });
  return issues;
}

// ---------------------------------------------------------------------------
// 一括入力
// ---------------------------------------------------------------------------

export interface BulkFillOptions {
  /** 対象のスタッフID。空なら全員 */
  staffIds: string[];
  /** 対象の曜日（0=日〜6=土）。祝日を含めるかは holiday で指定 */
  weekdays: number[];
  /** 祝日の日も対象にする（曜日とは別に、祝日だけを指定したいとき用） */
  includeHolidays: boolean;
  /** 入れる勤務区分のID。nullは消去 */
  typeId: string | null;
  /** すでに入っているセルは変えない */
  onlyBlank: boolean;
}

export function bulkFill(schedule: ShiftSchedule, options: BulkFillOptions): { cells: Record<string, (string | null)[]>; changed: number } {
  const days = monthDays(schedule.year, schedule.month);
  const targets = options.staffIds.length > 0 ? new Set(options.staffIds) : new Set(schedule.staff.map((s) => s.id));
  const cells: Record<string, (string | null)[]> = {};
  let changed = 0;
  for (const s of schedule.staff) {
    const row = resizeCells(schedule.cells[s.id], days.length);
    if (targets.has(s.id)) {
      days.forEach((d, i) => {
        const matches = options.weekdays.includes(d.weekday) || (options.includeHolidays && d.holiday !== null);
        if (!matches) return;
        if (options.onlyBlank && row[i] !== null) return;
        if (row[i] !== options.typeId) {
          row[i] = options.typeId;
          changed++;
        }
      });
    }
    cells[s.id] = row;
  }
  return { cells, changed };
}

/** 勤務区分を削除したとき、その区分が入っているセルを未入力に戻す */
export function clearType(cells: Record<string, (string | null)[]>, typeId: string): { cells: Record<string, (string | null)[]>; cleared: number } {
  let cleared = 0;
  const out: Record<string, (string | null)[]> = {};
  for (const [staffId, row] of Object.entries(cells)) {
    out[staffId] = row.map((id) => {
      if (id === typeId) {
        cleared++;
        return null;
      }
      return id;
    });
  }
  return { cells: out, cleared };
}

// ---------------------------------------------------------------------------
// 保存ファイル（JSON）
// ---------------------------------------------------------------------------

const SAVE_APP = "mr-satto-shift";
const SAVE_VERSION = 1;

export function serializeSchedule(schedule: ShiftSchedule): string {
  return JSON.stringify({ app: SAVE_APP, version: SAVE_VERSION, schedule }, null, 1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

/** 保存ファイルを読む。形式が違う・壊れているときは、理由つきで null を返す。読めた内容も、安全な範囲に整える */
export function parseSavedSchedule(text: string): { schedule: ShiftSchedule | null; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { schedule: null, error: "ファイルを読み込めませんでした（JSONの形式ではありません）。このツールで保存したファイルを選んでください。" };
  }
  if (!isRecord(raw) || raw.app !== SAVE_APP || !isRecord(raw.schedule)) {
    return { schedule: null, error: "このツールで保存したファイルではありません。" };
  }
  if (raw.version !== SAVE_VERSION) return { schedule: null, error: "このファイルは、対応していない形式（バージョン）です。" };
  const s = raw.schedule;
  const year = int(s.year, 0, SHIFT_MIN_YEAR, SHIFT_MAX_YEAR);
  const month = int(s.month, 0, 1, 12);
  if (year === 0 || month === 0) return { schedule: null, error: "ファイルの年月が正しくありません。" };
  if (!Array.isArray(s.types) || !Array.isArray(s.staff) || !isRecord(s.cells)) return { schedule: null, error: "ファイルの内容が正しくありません。" };
  if (s.types.length > SHIFT_MAX_TYPES || s.staff.length > SHIFT_MAX_STAFF) return { schedule: null, error: "ファイルの勤務区分またはスタッフの数が、上限を超えています。" };

  const colorIds = new Set(SHIFT_COLORS.map((c) => c.id));
  const types: ShiftType[] = [];
  const typeIds = new Set<string>();
  for (const t of s.types) {
    if (!isRecord(t)) return { schedule: null, error: "ファイルの勤務区分が正しくありません。" };
    const id = str(t.id, 20);
    if (id === "" || typeIds.has(id)) return { schedule: null, error: "ファイルの勤務区分のIDが正しくありません。" };
    typeIds.add(id);
    types.push({
      id,
      code: str(t.code, 10),
      name: str(t.name, 40),
      kind: t.kind === "off" ? "off" : "work",
      start: str(t.start, 8),
      end: str(t.end, 8),
      breakMinutes: int(t.breakMinutes, 0, 0, 1440),
      color: typeof t.color === "string" && colorIds.has(t.color) ? t.color : "gray",
    });
  }
  const staff: ShiftStaff[] = [];
  const staffIds = new Set<string>();
  for (const m of s.staff) {
    if (!isRecord(m)) return { schedule: null, error: "ファイルのスタッフが正しくありません。" };
    const id = str(m.id, 20);
    if (id === "" || staffIds.has(id)) return { schedule: null, error: "ファイルのスタッフのIDが正しくありません。" };
    staffIds.add(id);
    staff.push({ id, name: str(m.name, 60) });
  }
  const days = daysInMonth(year, month);
  const cells: Record<string, (string | null)[]> = {};
  for (const m of staff) {
    const rawRow = (s.cells as Record<string, unknown>)[m.id];
    const row = Array.isArray(rawRow) ? rawRow : [];
    cells[m.id] = Array.from({ length: days }, (_, i) => {
      const v = row[i];
      return typeof v === "string" && typeIds.has(v) ? v : null;
    });
  }
  const st = isRecord(s.settings) ? s.settings : {};
  const settings: ShiftSettings = {
    maxConsecutive: int(st.maxConsecutive, DEFAULT_SETTINGS.maxConsecutive, 0, 31),
    minRestHours: int(st.minRestHours, DEFAULT_SETTINGS.minRestHours, 0, 24),
    minStaffPerDay: int(st.minStaffPerDay, DEFAULT_SETTINGS.minStaffPerDay, 0, SHIFT_MAX_STAFF),
  };
  return { schedule: { title: str(s.title, 60), year, month, types, staff, cells, settings }, error: null };
}
