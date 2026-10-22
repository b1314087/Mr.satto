/**
 * Excelの予定表（日付・予定・開始時刻・終了時刻の一覧）を、カレンダーの共通予定モデル（events.ts）へ変換する。
 *
 * 入力はExcelのシートを読んだ結果（行 × セルの値）で、ファイルそのものは扱わない（ファイルの読み取りは画面側。
 * すべてブラウザ内で処理し、内容を外部へ送らない）。ここでは次のことだけを行う。
 *   1. 見出し行と列（日付・予定・開始・終了）を、列名の表記ゆれを許して推定する
 *   2. 各行を読み取り、使える行と、問題のある行（日付を読めない・予定名が空・時刻を読めない）に分ける
 * 問題のある行があっても、ファイル全体を読み込み不能にはしない。問題のある行だけを理由つきで返す。
 * 読めた予定についても、日付と曜日が合わない行・同じ日付が複数ある日を「注意（warnings）」として返す
 * （予定の削除・統合・日付や曜日の書き換えはしない。確認するのは利用者）。
 *
 * 年度の範囲かどうかの判定は events.ts の placeEvents で行う（ここでは日付を別の年度へ動かさない）。
 */
import { sanitizeEventText, type CalendarEvent } from "./events";

export type EventCellValue = string | number | boolean | Date | null | undefined;

/** 列の割り当て（0始まりの列番号。割り当てがない項目は null） */
export interface ColumnMapping {
  date: number | null;
  title: number | null;
  start: number | null;
  end: number | null;
}

export type ColumnRole = keyof ColumnMapping;
export const COLUMN_ROLES: ColumnRole[] = ["date", "title", "start", "end"];
export const COLUMN_ROLE_LABELS: Record<ColumnRole, string> = { date: "日付", title: "予定", start: "開始時刻", end: "終了時刻" };

/** 読み込める行数の上限（画面が固まらないための安全のための制限） */
export const MAX_IMPORT_ROWS = 20_000;

export type ImportIssueKind = "bad-date" | "empty-title" | "bad-time";

export interface ImportIssue {
  /** Excelに表示される行番号（1始まり） */
  row: number;
  kind: ImportIssueKind;
  /** 画面に出す理由 */
  message: string;
  /** その行の、日付・予定などの元の文字（確認用） */
  raw: string;
}

/**
 * 注意（警告）の種類。ImportIssue（読めない行）とは別で、予定そのものは読み込まれ、データは何も変えない。
 *   weekday-mismatch: 日付と、書かれている曜日が合わない（どちらが正しいかは、ここでは決めない）
 *   duplicate-date: 同じ日付の予定が複数ある（同じ日に複数の予定があるのは普通なので、間違いとは決めつけない）
 */
export type ImportWarningKind = "weekday-mismatch" | "duplicate-date";

export interface ImportWarning {
  kind: ImportWarningKind;
  /** 対象の日付（YYYY-MM-DD） */
  date: string;
  /** 対象の行（Excelの行番号。1始まり、昇順） */
  rows: number[];
  /** 画面に出す説明 */
  message: string;
  /** duplicate-date のとき、予定名まで同じ行が含まれるか（同じ予定を二重に書いた可能性が高い） */
  sameTitle?: boolean;
}

export interface DetectedLayout {
  /** 見出し行の位置（0始まり）。見出しがないと判断したときは -1 */
  headerRow: number;
  mapping: ColumnMapping;
  /** 見出しの文字を使って割り当てたか（false は、見出しなしとして位置から推定した） */
  fromHeader: boolean;
}

export interface ImportResult {
  /** 日付と予定名が読み取れた予定（年度の内外を問わない。時刻が読めない行は時刻なしで含む） */
  events: CalendarEvent[];
  /** 問題のある行（予定名が空・日付を読めないなど）と、注意が必要な行（時刻を読めない） */
  issues: ImportIssue[];
  /** 読み込んだ予定についての注意（曜日の不一致・同じ日付の重複）。予定は削除も修正もしていない */
  warnings: ImportWarning[];
  /** 空行を除いた、データ行の数 */
  dataRowCount: number;
  headerRow: number;
  mapping: ColumnMapping;
}

// ───────────── 列名の推定 ─────────────

/** 列名を比べやすい形にする（全角→半角・大文字→小文字・空白と括弧の中身を除く） */
export function normalizeHeader(value: EventCellValue): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s_\-:：]/g, "");
}

const EXACT: Record<ColumnRole, string[]> = {
  date: ["日付", "日", "date", "年月日", "日にち", "開催日", "予定日", "実施日", "日程"],
  title: ["予定", "内容", "件名", "イベント", "タイトル", "event", "title", "subject", "予定名", "予定内容", "名称", "用件", "概要", "summary", "イベント名", "行事", "行事名"],
  start: ["開始", "開始時刻", "開始時間", "start", "starttime", "from", "時刻", "時間"],
  end: ["終了", "終了時刻", "終了時間", "end", "endtime", "to"],
};

function roleOfHeader(value: EventCellValue): ColumnRole | null {
  const h = normalizeHeader(value);
  if (!h) return null;
  for (const role of COLUMN_ROLES) if (EXACT[role].includes(h)) return role;
  // 完全一致しないときは、含まれる語で推定する（例:「開始時刻(24h)」「予定の内容」「Start Time」）
  if (/終了|end/.test(h)) return "end";
  if (/開始|start/.test(h)) return "start";
  if (/日付|date|年月日/.test(h)) return "date";
  if (/予定|内容|件名|イベント|タイトル|title|event|subject|名称/.test(h)) return "title";
  return null;
}

/** 行の中から、見出しとして使える行を探す（日付と予定の両方の列名が見つかる行） */
function findHeaderRow(rows: EventCellValue[][]): DetectedLayout | null {
  const limit = Math.min(rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const mapping: ColumnMapping = { date: null, title: null, start: null, end: null };
    rows[r].forEach((cell, c) => {
      const role = roleOfHeader(cell);
      if (role && mapping[role] === null) mapping[role] = c;
    });
    if (mapping.date !== null && mapping.title !== null) return { headerRow: r, mapping, fromHeader: true };
  }
  return null;
}

// ───────────── 日付・時刻の読み取り ─────────────

const ERA_BASE: Record<string, number> = { 令和: 2018, r: 2018, 平成: 1988, h: 1988, 昭和: 1925, s: 1925 };

function validIso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function validTime(h: number, m: number): string | null {
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

/** 時刻の文字（"10:00" "9:30" "10:00:00" "10時" "10時30分"）→ HH:MM。読めなければ null */
function parseTimeText(raw: string): string | null {
  const s = raw.normalize("NFKC").trim();
  let m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
  if (m) return validTime(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})時(?:(\d{1,2})分?)?$/.exec(s);
  if (m) return validTime(Number(m[1]), m[2] ? Number(m[2]) : 0);
  m = /^(\d{1,2})時半$/.exec(s);
  if (m) return validTime(Number(m[1]), 30);
  return null;
}

type TimeParse = { time: string | null } | { error: true };

/** 時刻のセル → HH:MM。空なら time=null、読めなければ error */
export function parseTimeCell(value: EventCellValue): TimeParse {
  if (value === null || value === undefined) return { time: null };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { error: true };
    const t = validTime(value.getUTCHours(), value.getUTCMinutes());
    return t ? { time: t } : { error: true };
  }
  if (typeof value === "number") {
    // Excelの時刻は 0〜1 未満の小数（例: 0.4166… = 10:00）
    if (!(value >= 0 && value < 1)) return { error: true };
    const minutes = Math.round(value * 24 * 60);
    const t = validTime(Math.floor(minutes / 60) % 24, minutes % 60);
    return t ? { time: t } : { error: true };
  }
  if (typeof value === "boolean") return { error: true };
  const s = value.trim();
  if (s === "") return { time: null };
  const t = parseTimeText(s);
  return t ? { time: t } : { error: true };
}

type DateParse = { iso: string; time: string | null } | { error: string } | { empty: true };

/** 日付のセル → YYYY-MM-DD（日時のセルなら時刻も）。空なら empty、読めなければ理由つきの error */
export function parseDateCell(value: EventCellValue): DateParse {
  if (value === null || value === undefined) return { empty: true };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { error: "日付として読めません" };
    // 時刻だけのセルは 1900年より前の日付（1899-12-30）として読み取られる
    if (value.getUTCFullYear() < 1900) return { error: "日付ではなく時刻の値です" };
    const iso = validIso(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    if (!iso) return { error: "日付として読めません" };
    const hasTime = value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0;
    return { iso, time: hasTime ? validTime(value.getUTCHours(), value.getUTCMinutes()) : null };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { error: "日付として読めません" };
    // 20270405 のような8けたの数字
    if (Number.isInteger(value) && value >= 19000101 && value <= 22001231) {
      const iso = validIso(Math.floor(value / 10000), Math.floor(value / 100) % 100, value % 100);
      return iso ? { iso, time: null } : { error: "存在しない日付です" };
    }
    // Excelのシリアル値（1900年1月1日=1）。1900年2月29日の誤りがあるため、61以上を日付として扱う
    if (value >= 61 && value < 109_000) {
      const ms = Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000;
      const d = new Date(ms);
      const iso = validIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      return iso ? { iso, time: null } : { error: "日付として読めません" };
    }
    return { error: "日付として読めません" };
  }
  if (typeof value === "boolean") return { error: "日付として読めません" };

  let s = value.normalize("NFKC").trim();
  if (s === "") return { empty: true };
  // 曜日の付記「(月)」「（月曜日）」を除く
  s = s.replace(/[(（][月火水木金土日]曜?日?[)）]/g, "").replace(/\s+/g, " ").trim();

  let m = /^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:[ T]+(.+))?$/.exec(s) ?? /^(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\s*(.+))?$/.exec(s);
  if (m) {
    const iso = validIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!iso) return { error: "存在しない日付です" };
    let time: string | null = null;
    if (m[4]) {
      time = parseTimeText(m[4]);
      if (time === null) return { error: "日付のあとの文字を読み取れません" };
    }
    return { iso, time };
  }
  m = /^(\d{8})$/.exec(s);
  if (m) {
    const iso = validIso(Number(m[1].slice(0, 4)), Number(m[1].slice(4, 6)), Number(m[1].slice(6, 8)));
    return iso ? { iso, time: null } : { error: "存在しない日付です" };
  }
  m = /^(令和|平成|昭和|r|h|s)\s*(\d{1,2}|元)\s*[年./\-]\s*(\d{1,2})\s*[月./\-]\s*(\d{1,2})\s*日?$/i.exec(s);
  if (m) {
    const base = ERA_BASE[m[1].toLowerCase()];
    const n = m[2] === "元" ? 1 : Number(m[2]);
    const iso = validIso(base + n, Number(m[3]), Number(m[4]));
    return iso ? { iso, time: null } : { error: "存在しない日付です" };
  }
  if (/^\d{1,2}[/.\-]\d{1,2}$/.test(s) || /^\d{1,2}月\d{1,2}日?$/.test(s)) return { error: "年が書かれていないため、年度を決められません" };
  if (/^\d+(\.\d+)?$/.test(s)) {
    // 文字として入っている数字（シリアル値・8けたの数字）
    return parseDateCell(Number(s));
  }
  return { error: "日付として読めません" };
}

export function cellText(value: EventCellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 16).replace("T", " ");
  return String(value);
}

const isEmpty = (v: EventCellValue) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

// ───────────── 曜日の読み取り（日付との照合用） ─────────────

/** 曜日の番号（日=0 … 土=6）と、画面に出す名前 */
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const WEEKDAY_ENGLISH: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** 曜日の文字（"月" "月曜" "月曜日" "(月)" "Mon" "Monday"）→ 0〜6。読めなければ null（照合しない） */
export function parseWeekdayText(value: EventCellValue): number | null {
  if (typeof value !== "string") return null;
  const s = value.normalize("NFKC").trim().replace(/^\(\s*|\s*\)$/g, "").trim();
  const ja = /^([月火水木金土日])(?:曜日?)?$/.exec(s);
  if (ja) return WEEKDAY_LABELS.indexOf(ja[1] as (typeof WEEKDAY_LABELS)[number]);
  const en = WEEKDAY_ENGLISH[s.toLowerCase()];
  return en === undefined ? null : en;
}

/** 日付のセルに「2027/4/5(月)」のように付記された曜日を取り出す（日付の読み取りは parseDateCell が行う）。なければ null */
function weekdayAnnotation(value: EventCellValue): number | null {
  if (typeof value !== "string") return null;
  const m = /[(（]([月火水木金土日])曜?日?[)）]/.exec(value.normalize("NFKC"));
  return m ? WEEKDAY_LABELS.indexOf(m[1] as (typeof WEEKDAY_LABELS)[number]) : null;
}

/** YYYY-MM-DD の曜日（日=0 … 土=6）。タイムゾーンに左右されない */
function weekdayOfIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAY_HEADERS = ["曜日", "曜", "weekday", "dayofweek", "dow"];

/** 見出し行に「曜日」の列があれば、その列番号（日付・予定・時刻に割り当てた列は除く）。なければ null */
function findWeekdayColumn(rows: EventCellValue[][], headerRow: number, mapping: ColumnMapping): number | null {
  if (headerRow < 0) return null;
  const used = new Set([mapping.date, mapping.title, mapping.start, mapping.end]);
  const header = rows[headerRow] ?? [];
  for (let c = 0; c < header.length; c++) {
    if (!used.has(c) && WEEKDAY_HEADERS.includes(normalizeHeader(header[c]))) return c;
  }
  return null;
}

const isoToSlash = (iso: string) => iso.replace(/-/g, "/");

/** 予定名を比べやすい形にする（全角→半角・前後と連続の空白を除く・大文字→小文字） */
const normalizeTitle = (title: string) => title.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** 読み込んだ予定から、同じ日付が複数ある日を見つける。予定は変更しない */
function findDuplicateDates(events: CalendarEvent[]): ImportWarning[] {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.date);
    if (list) list.push(e);
    else byDate.set(e.date, [e]);
  }
  const warnings: ImportWarning[] = [];
  for (const [date, list] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length < 2) continue;
    const rows = list.map((e) => e.sourceRow).sort((a, b) => a - b);
    const titles = list.map((e) => normalizeTitle(e.title));
    const sameTitle = new Set(titles).size < titles.length;
    warnings.push({
      kind: "duplicate-date",
      date,
      rows,
      sameTitle,
      message: sameTitle
        ? `${isoToSlash(date)} に同じ予定名の行が重なっています（${list.length}件）。同じ予定を二重に書いていないか確認してください`
        : `${isoToSlash(date)} に${list.length}件の予定があります。同じ日に複数の予定があるのは問題ありません。意図したものか確認してください`,
    });
  }
  return warnings;
}

// ───────────── 列の推定（見出しなしの表も） ─────────────

/** 見出しがないときの推定: 1列目の大半が日付として読めるなら、1列目=日付・2列目=予定・3列目=開始・4列目=終了 */
function guessWithoutHeader(rows: EventCellValue[][]): DetectedLayout | null {
  const sample = rows.filter((r) => r.some((c) => !isEmpty(c))).slice(0, 50);
  if (sample.length === 0) return null;
  let dateLike = 0;
  for (const r of sample) if ("iso" in parseDateCell(r[0])) dateLike++;
  if (dateLike / sample.length < 0.6) return null;
  const width = Math.max(...sample.map((r) => r.length));
  return {
    headerRow: -1,
    mapping: { date: 0, title: width > 1 ? 1 : null, start: width > 2 ? 2 : null, end: width > 3 ? 3 : null },
    fromHeader: false,
  };
}

/** シートの行から、見出し行と列の割り当てを推定する。推定できなければ null（画面で列を選んでもらう） */
export function detectLayout(rows: EventCellValue[][]): DetectedLayout | null {
  return findHeaderRow(rows) ?? guessWithoutHeader(rows);
}

/** 先頭の数行から推定した見出しを返す（列を選ぶ画面の候補の表示用。列ごとの見出し文字） */
export function columnLabels(rows: EventCellValue[][], headerRow: number): string[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const header = headerRow >= 0 ? rows[headerRow] ?? [] : [];
  return Array.from({ length: width }, (_, c) => {
    const letter = (() => {
      let n = c + 1;
      let s = "";
      while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    })();
    const h = cellText(header[c]).trim();
    return h ? `${letter}列: ${h.length > 20 ? `${h.slice(0, 20)}…` : h}` : `${letter}列`;
  });
}

// ───────────── 行の読み取り ─────────────

/**
 * 割り当てた列に従って、データ行を予定に変換する。
 * rows: シートの全行 / headerRow: 見出し行（0始まり。見出しなしは -1。データはその次の行から）
 */
export function parseEventRows(rows: EventCellValue[][], mapping: ColumnMapping, headerRow: number): ImportResult {
  const events: CalendarEvent[] = [];
  const issues: ImportIssue[] = [];
  const weekdayWarnings: ImportWarning[] = [];
  let dataRowCount = 0;
  const get = (row: EventCellValue[], col: number | null): EventCellValue => (col === null ? null : row[col]);
  // 見出しに「曜日」の列があれば、日付との照合に使う（なければ、日付に付記された「(月)」だけを使う）
  const weekdayColumn = findWeekdayColumn(rows, headerRow, mapping);

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const cells = [get(row, mapping.date), get(row, mapping.title), get(row, mapping.start), get(row, mapping.end)];
    if (cells.every(isEmpty)) continue; // 空行
    dataRowCount++;
    if (dataRowCount > MAX_IMPORT_ROWS) {
      throw new Error(`予定の行が多すぎます（上限は${MAX_IMPORT_ROWS.toLocaleString("ja-JP")}行です）。年度ごとなどに分けて読み込んでください`);
    }
    const excelRow = r + 1;
    const raw = [mapping.date, mapping.title, mapping.start, mapping.end]
      .filter((c): c is number => c !== null)
      .map((c) => cellText(row[c]).trim())
      .filter((t) => t !== "")
      .join(" / ")
      .slice(0, 80);

    const dateParse = parseDateCell(cells[0]);
    if ("empty" in dateParse) {
      issues.push({ row: excelRow, kind: "bad-date", message: "日付が空です", raw });
      continue;
    }
    if ("error" in dateParse) {
      issues.push({ row: excelRow, kind: "bad-date", message: dateParse.error, raw });
      continue;
    }
    const title = sanitizeEventText(cellText(cells[1]));
    if (title === "") {
      issues.push({ row: excelRow, kind: "empty-title", message: "予定名が空です", raw });
      continue;
    }

    let startTime: string | null = dateParse.time;
    let endTime: string | null = null;
    const timeProblems: string[] = [];

    // 開始時刻の列。「10:00-11:00」のように1つのセルに範囲が書かれていたら、開始と終了に分ける
    const startCell = cells[2];
    const startText = typeof startCell === "string" ? startCell.normalize("NFKC").replace(/[〜～]/g, "~") : "";
    if (/^[^~\-–−ー]+[~\-–−ー][^~\-–−ー]+$/.test(startText.trim())) {
      const [a, b] = startText.split(/[~\-–−ー]/).map((t) => parseTimeText(t));
      if (a && b) {
        startTime = a;
        endTime = b;
      } else timeProblems.push("開始時刻");
    } else {
      const sp = parseTimeCell(startCell);
      if ("error" in sp) timeProblems.push("開始時刻");
      else if (sp.time) startTime = sp.time;
    }
    const ep = parseTimeCell(cells[3]);
    if ("error" in ep) timeProblems.push("終了時刻");
    else if (ep.time) endTime = ep.time;

    // 時刻だけが読めない行は、予定は残し、その時刻を使わずに配置して、理由を知らせる
    if (timeProblems.length > 0) {
      issues.push({ row: excelRow, kind: "bad-time", message: `${timeProblems.join("・")}を読み取れないため、その時刻は使わずに配置します`, raw });
    }
    events.push({ date: dateParse.iso, title, startTime, endTime, sourceRow: excelRow });

    // 日付と曜日の照合。日付と予定名が読めた行だけが対象（読めない行は上の issues で扱い済みで、二重には出さない）。
    // 曜日が書かれていない行・曜日として読めない文字（「祝」など）は照合しない。日付も曜日も書き換えない。
    const entered = weekdayAnnotation(cells[0]) ?? (weekdayColumn === null ? null : parseWeekdayText(row[weekdayColumn]));
    if (entered !== null) {
      const actual = weekdayOfIso(dateParse.iso);
      if (entered !== actual) {
        weekdayWarnings.push({
          kind: "weekday-mismatch",
          date: dateParse.iso,
          rows: [excelRow],
          message: `${isoToSlash(dateParse.iso)} は${WEEKDAY_LABELS[actual]}曜日ですが、「${WEEKDAY_LABELS[entered]}」と書かれています。日付と曜日のどちらが正しいか確認してください（自動では直しません）`,
        });
      }
    }
  }
  const warnings = [...weekdayWarnings, ...findDuplicateDates(events)];
  return { events, issues, warnings, dataRowCount, headerRow, mapping };
}

// ───────────── 取り込みの要約（画面に出す件数） ─────────────

export interface ImportSummary {
  /** 読み込んだ行数（空行を除く） */
  totalRows: number;
  /** 日付と予定名を読み取れた予定の数 */
  recognized: number;
  inYear: number;
  outOfYear: number;
  badDateRows: number;
  emptyTitleRows: number;
  badTimeRows: number;
  /** 日付と曜日が合わない行の数 */
  weekdayMismatchRows: number;
  /** 同じ日付の予定が複数ある日の数（その日にある予定の行数ではない） */
  duplicateDates: number;
}

export function summarizeImport(result: ImportResult, inYearCount: number): ImportSummary {
  const count = (k: ImportIssueKind) => result.issues.filter((i) => i.kind === k).length;
  const warned = (k: ImportWarningKind) => result.warnings.filter((w) => w.kind === k).length;
  return {
    totalRows: result.dataRowCount,
    recognized: result.events.length,
    inYear: inYearCount,
    outOfYear: result.events.length - inYearCount,
    badDateRows: count("bad-date"),
    emptyTitleRows: count("empty-title"),
    badTimeRows: count("bad-time"),
    weekdayMismatchRows: warned("weekday-mismatch"),
    duplicateDates: warned("duplicate-date"),
  };
}

/** シートの一覧から、予定表として読めそうなシートを選ぶ（見出しが推定できる最初のシート。なければ最初の空でないシート） */
export function pickEventSheet(sheets: { name: string; rows: EventCellValue[][] }[]): number {
  const withHeader = sheets.findIndex((s) => findHeaderRow(s.rows));
  if (withHeader >= 0) return withHeader;
  const guessed = sheets.findIndex((s) => guessWithoutHeader(s.rows));
  if (guessed >= 0) return guessed;
  const nonEmpty = sheets.findIndex((s) => s.rows.some((r) => r.some((c) => !isEmpty(c))));
  return nonEmpty >= 0 ? nonEmpty : 0;
}
