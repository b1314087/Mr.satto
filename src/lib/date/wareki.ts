/**
 * 和暦・西暦の変換（和暦・西暦一括変換ツール。2026-11-17）。
 *
 * - 元号：明治・大正・昭和・平成・令和。元号の始まりの日（改元の日）からを、その元号とする。
 *   大正 1912-07-30、昭和 1926-12-25、平成 1989-01-08、令和 2019-05-01。
 * - 明治5年（1872年）までは旧暦（太陰太陽暦）で、今の暦（グレゴリオ暦）と日付がずれるため、変換せず「要確認」にする
 *   （明治6年＝1873年1月1日から今の暦）。
 * - 元号の範囲の外の日付（例：昭和64年1月8日・平成31年5月1日）や、存在しない日付（2月30日など）は、変換せず「要確認」にする。
 * - 年だけ・年と月だけの値にも対応する。改元の年（月）で、どちらの元号か決められないとき（例：2019年）は「要確認」にする。
 * - 日付として読めない値は、そのまま残す（勝手に変えない）。
 */

export interface Era {
  name: string;
  /** 漢字1文字の略（明・大・昭・平・令） */
  kanji: string;
  /** アルファベットの略（M・T・S・H・R） */
  letter: string;
  /** 始まりの日（西暦の年・月・日） */
  start: [number, number, number];
  /** 元年の西暦の年 - 1（元号の年 n の西暦は base + n） */
  base: number;
}

export const ERAS: Era[] = [
  { name: "明治", kanji: "明", letter: "M", start: [1868, 10, 23], base: 1867 },
  { name: "大正", kanji: "大", letter: "T", start: [1912, 7, 30], base: 1911 },
  { name: "昭和", kanji: "昭", letter: "S", start: [1926, 12, 25], base: 1925 },
  { name: "平成", kanji: "平", letter: "H", start: [1989, 1, 8], base: 1988 },
  { name: "令和", kanji: "令", letter: "R", start: [2019, 5, 1], base: 2018 },
];

/** 今の暦（グレゴリオ暦）が使われ始めた日。これより前は、旧暦とずれるため変換しない */
const GREGORIAN_START: [number, number, number] = [1873, 1, 1];

export type Precision = "ymd" | "ym" | "y";

export interface ParsedDate {
  kind: "seireki" | "wareki";
  precision: Precision;
  year: number;
  month: number | null;
  day: number | null;
  /** 和暦で書かれていたときの元号 */
  era?: Era;
}

export type WarekiFormat = "kanji" | "letter";
export type SeirekiFormat = "slash" | "hyphen" | "kanji";
export type ConvertDirection = "auto" | "to-wareki" | "to-seireki";

export interface ConvertOptions {
  direction: ConvertDirection;
  warekiFormat: WarekiFormat;
  /** 1年を「元年」と書くか */
  gannen: boolean;
  seirekiFormat: SeirekiFormat;
}

export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = { direction: "auto", warekiFormat: "kanji", gannen: true, seirekiFormat: "slash" };

export type ConvertStatus = "converted" | "empty" | "skipped" | "check";

export interface ConvertResult {
  status: ConvertStatus;
  /** 変換した値（変換しなかったときは null） */
  output: string | null;
  /** 要確認・そのままの理由 */
  reason?: string;
  /** 変換の向き（表示用） */
  to?: "wareki" | "seireki";
  /** 西暦→和暦のとき、Excelに「日付」として書き出すための値（和暦→西暦で、年月日がそろうとき） */
  date?: { year: number; month: number; day: number };
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 文字の揺れをそろえる（全角の数字・記号、㍻などの合字、空白） */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[（(][日月火水木金土祝・]+[)）]/g, "") // 曜日（火）など
    .replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, "") // 末尾の時刻
    .replace(/\s+/g, "")
    .trim();
}

function eraByToken(token: string): Era | undefined {
  const t = token.toUpperCase();
  return ERAS.find((e) => e.name === token || e.kanji === token || e.letter === t);
}

/**
 * 文字を、和暦または西暦の日付として読む。読めなければ null。
 * 西暦：2026/11/17・2026-11-17・2026.11.17・2026年11月17日・2026年11月・2026年・2026/11
 * 和暦：令和8年11月17日・令和元年5月1日・R8.11.17・R8/11/17・令8.11.17・H31.4.30・令和8年・R8
 */
export function parseDateText(raw: string): ParsedDate | null {
  const text = normalize(raw);
  if (!text) return null;
  // 和暦
  let m = /^(明治|大正|昭和|平成|令和|[明大昭平令]|[MTSHRmtshr])(元|\d{1,2})(?:年|[./\-])?(?:(\d{1,2})(?:月|[./\-])?(?:(\d{1,2})日?)?)?$/.exec(text);
  if (m) {
    const era = eraByToken(m[1]);
    if (!era) return null;
    // 「R8」のように区切りなしで月が続く書き方（R81117）は読まない（区切りか「年」が必要）
    const sepAfterYear = text.slice(m[1].length + m[2].length, m[1].length + m[2].length + 1);
    if (m[3] && !/[年./\-]/.test(sepAfterYear)) return null;
    const year = m[2] === "元" ? 1 : Number(m[2]);
    if (year < 1) return null;
    const month = m[3] ? Number(m[3]) : null;
    const day = m[4] ? Number(m[4]) : null;
    return { kind: "wareki", era, year, month, day, precision: day !== null ? "ymd" : month !== null ? "ym" : "y" };
  }
  // 西暦（年月日）
  m = /^(\d{4})(?:年|[./\-])(\d{1,2})(?:月|[./\-])(\d{1,2})日?$/.exec(text);
  if (m) return { kind: "seireki", year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), precision: "ymd" };
  // 西暦（年月）
  m = /^(\d{4})(?:年|[./\-])(\d{1,2})月?$/.exec(text);
  if (m) return { kind: "seireki", year: Number(m[1]), month: Number(m[2]), day: null, precision: "ym" };
  // 西暦（年だけ。「年」が付いているときだけ。4けたの数字だけでは、番号などと区別できないため読まない）
  m = /^(\d{4})年$/.exec(text);
  if (m) return { kind: "seireki", year: Number(m[1]), month: null, day: null, precision: "y" };
  return null;
}

function fmtWareki(era: Era, year: number, month: number | null, day: number | null, o: ConvertOptions): string {
  if (o.warekiFormat === "letter") {
    return [`${era.letter}${year}`, month, day].filter((v) => v !== null).join(".");
  }
  const y = year === 1 && o.gannen ? "元" : String(year);
  return `${era.name}${y}年${month !== null ? `${month}月` : ""}${day !== null ? `${day}日` : ""}`;
}

function fmtSeireki(year: number, month: number | null, day: number | null, o: ConvertOptions): string {
  if (o.seirekiFormat === "kanji") return `${year}年${month !== null ? `${month}月` : ""}${day !== null ? `${day}日` : ""}`;
  const sep = o.seirekiFormat === "hyphen" ? "-" : "/";
  if (month === null) return `${year}年`;
  const mm = String(month).padStart(2, "0");
  if (day === null) return `${year}${sep}${mm}`;
  return `${year}${sep}${mm}${sep}${String(day).padStart(2, "0")}`;
}

/** 西暦の年月日（足りない部分は null）の元号を決める。決められなければ理由 */
function eraForSeireki(y: number, mo: number | null, d: number | null): { era: Era } | { reason: string } {
  const first: [number, number, number] = [y, mo ?? 1, d ?? 1];
  const last: [number, number, number] = [y, mo ?? 12, d ?? (mo ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 31)];
  if (cmp(first, GREGORIAN_START) < 0) {
    return { reason: "明治5年（1872年）までは旧暦のため、変換しません" };
  }
  const pick = (p: [number, number, number]) => [...ERAS].reverse().find((e) => cmp(p, e.start) >= 0);
  const a = pick(first);
  const b = pick(last);
  if (!a || !b) return { reason: "対応している元号（明治〜令和）の範囲外です" };
  if (a !== b) return { reason: `改元の${mo === null ? "年" : "月"}のため、どちらの元号か決められません（${a.name}／${b.name}）` };
  return { era: a };
}

/** 1つの値を変換する。日付として読めない値・空欄は、そのまま */
export function convertValue(value: unknown, o: ConvertOptions = DEFAULT_CONVERT_OPTIONS): ConvertResult {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return { status: "empty", output: null };
  let parsed: ParsedDate | null = null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { status: "check", output: null, reason: "日付として読めません" };
    // Excel の日付のセルは、日付の部分だけを使う（読み込みは UTC の0時として渡される）
    parsed = { kind: "seireki", year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), precision: "ymd" };
  } else if (typeof value === "number") {
    return { status: "skipped", output: null, reason: "数値のため変換しません（日付の書式のセルは、日付として読みます）" };
  } else {
    parsed = parseDateText(String(value));
  }
  if (!parsed) return { status: "skipped", output: null, reason: "日付として読めないため、そのままにします" };

  if (parsed.kind === "seireki") {
    if (o.direction === "to-seireki") return { status: "skipped", output: null, reason: "すでに西暦です" };
    const { year, month, day } = parsed;
    if (month !== null && day !== null && !isValidDate(year, month, day)) return { status: "check", output: null, reason: "存在しない日付です" };
    if (month !== null && (month < 1 || month > 12)) return { status: "check", output: null, reason: "存在しない月です" };
    const r = eraForSeireki(year, month, day);
    if ("reason" in r) return { status: "check", output: null, reason: r.reason };
    return { status: "converted", output: fmtWareki(r.era, year - r.era.base, month, day, o), to: "wareki" };
  }

  // 和暦 → 西暦
  if (o.direction === "to-wareki") return { status: "skipped", output: null, reason: "すでに和暦です" };
  const era = parsed.era!;
  const y = era.base + parsed.year;
  const { month, day } = parsed;
  if (month !== null && (month < 1 || month > 12)) return { status: "check", output: null, reason: "存在しない月です" };
  if (month !== null && day !== null && !isValidDate(y, month, day)) return { status: "check", output: null, reason: "存在しない日付です" };
  // 書かれた元号の範囲の中か（年・月だけのときは、その期間の一部でも元号の範囲に入っていればよい）
  const idx = ERAS.indexOf(era);
  const next = ERAS[idx + 1];
  const first: [number, number, number] = [y, month ?? 1, day ?? 1];
  const last: [number, number, number] = [y, month ?? 12, day ?? (month ? new Date(Date.UTC(y, month, 0)).getUTCDate() : 31)];
  if (cmp(last, era.start) < 0 || (next && cmp(first, next.start) >= 0)) {
    return { status: "check", output: null, reason: `${era.name}${parsed.year === 1 ? "元" : parsed.year}年${month ? `${month}月` : ""}${day ? `${day}日` : ""}は、${era.name}の期間にありません` };
  }
  if (cmp(first, GREGORIAN_START) < 0) return { status: "check", output: null, reason: "明治5年（1872年）までは旧暦のため、変換しません" };
  return {
    status: "converted",
    output: fmtSeireki(y, month, day, o),
    to: "seireki",
    date: month !== null && day !== null ? { year: y, month, day } : undefined,
  };
}

export const STATUS_LABELS: Record<ConvertStatus, string> = {
  converted: "変換",
  empty: "空欄",
  skipped: "そのまま",
  check: "要確認",
};
