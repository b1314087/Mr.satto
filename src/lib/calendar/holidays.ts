/**
 * 日本の国民の祝日を、祝日法に基づくルールで求める（Mr.Satto 年度カレンダー作成ツール）。
 *
 * 外部のAPIや祝日CSVには頼らず、ブラウザ内の関数だけで求める。結果が正しいことは、
 * 実装とは別に用意した検証データ（内閣府の公式CSV、python-holidays）との突き合わせで
 * tests/calendar で確認している。
 *
 * 対応する年: 2000〜2099年（春分・秋分の計算式が有効な範囲）。
 * 各祝日には「確度（status）」を付ける。
 *   - confirmed : 暦要項の公示が済んだ年（CONFIRMED_THROUGH_YEAR 以前）の祝日。
 *   - statutory : 公示済みの年より先で、法律の定めだけで日付が決まる祝日（元日・海の日など）。
 *   - estimated : 公示済みの年より先の春分の日・秋分の日、およびそれに伴って決まる振替休日・国民の休日。
 *                 国立天文台の公示前なので推定であり、確定した祝日としては扱わない。
 *
 * 祝日の「データ」（公示済みの最終年・春分/秋分の確定表・公式CSVと計算ルールが食い違う年の公式の祝日一覧）は
 * holiday-data.generated.ts にあり、内閣府の公式CSVから scripts/holidays が自動で更新する（holiday-data.ts 参照）。
 * 公式CSVと計算ルールが食い違う年（祝日法の改正など）は、その年の祝日を公式の一覧そのものにする
 * （OFFICIAL_HOLIDAY_OVERRIDES）。プログラムの修正なしで、公式CSVに載っている年は常に公式の内容になる。
 */
import { CONFIRMED_EQUINOX_DAYS, CONFIRMED_THROUGH_YEAR, OFFICIAL_HOLIDAY_OVERRIDES, type OfficialHoliday } from "./holiday-data";

export const HOLIDAY_MIN_YEAR = 2000;
export const HOLIDAY_MAX_YEAR = 2099;

export type HolidayKind = "national" | "substitute" | "citizens" | "special";
export type HolidayStatus = "confirmed" | "statutory" | "estimated";

/** 祝日の計算に使うデータ。通常は、自動更新される実データ（LIVE_HOLIDAY_DATA）を使う */
export interface HolidayData {
  /** 暦要項が公示済みで、祝日が確定している最後の年 */
  confirmedThroughYear: number;
  /** 公示済みの春分の日・秋分の日（日付のうちの「日」） */
  equinoxDays: Readonly<Record<number, { spring: number; autumn: number }>>;
  /** 公式CSVと計算ルールが食い違う年の、公式の祝日一覧（その年は、この一覧をそのまま使う） */
  overrides: Readonly<Record<number, readonly OfficialHoliday[]>>;
}

/** 自動更新される実データ（holiday-data.generated.ts） */
export const LIVE_HOLIDAY_DATA: HolidayData = {
  confirmedThroughYear: CONFIRMED_THROUGH_YEAR,
  equinoxDays: CONFIRMED_EQUINOX_DAYS,
  overrides: OFFICIAL_HOLIDAY_OVERRIDES,
};

export interface Holiday {
  /** YYYY-MM-DD */
  iso: string;
  name: string;
  kind: HolidayKind;
  status: HolidayStatus;
}

interface RawHoliday {
  name: string;
  kind: HolidayKind;
  estimated: boolean;
}

const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

/** 0=日曜 … 6=土曜。時刻やタイムゾーンの影響を受けないよう、UTCで求める */
export function weekdayOfIso(iso: string): number {
  const { y, m, d } = parseIso(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysIso(iso: string, days: number): string {
  const { y, m, d } = parseIso(iso);
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return toIso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** y年m月の第n月曜日の日付（日） */
function nthMonday(y: number, m: number, n: number): number {
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const firstMonday = 1 + ((8 - firstWeekday) % 7);
  return firstMonday + 7 * (n - 1);
}

/** 春分の日の計算式（1980〜2099年に有効）。公示済みの年は表を優先する */
function springEquinoxFormula(y: number): number {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/** 秋分の日の計算式（1980〜2099年に有効）。公示済みの年は表を優先する */
function autumnEquinoxFormula(y: number): number {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

function springOf(y: number, data: HolidayData): { day: number; estimated: boolean } {
  const confirmed = data.equinoxDays[y];
  if (confirmed) return { day: confirmed.spring, estimated: false };
  return { day: springEquinoxFormula(y), estimated: y > data.confirmedThroughYear };
}

function autumnOf(y: number, data: HolidayData): { day: number; estimated: boolean } {
  const confirmed = data.equinoxDays[y];
  if (confirmed) return { day: confirmed.autumn, estimated: false };
  return { day: autumnEquinoxFormula(y), estimated: y > data.confirmedThroughYear };
}

export function springEquinoxDay(y: number): { day: number; estimated: boolean } {
  return springOf(y, activeData);
}

export function autumnEquinoxDay(y: number): { day: number; estimated: boolean } {
  return autumnOf(y, activeData);
}

/** 法律で定められた祝日（国民の休日・振替休日を除く）。キーはYYYY-MM-DD */
function baseHolidays(y: number, data: HolidayData): Map<string, RawHoliday> {
  const map = new Map<string, RawHoliday>();
  const add = (m: number, d: number, name: string, kind: HolidayKind = "national", estimated = false) => {
    map.set(toIso(y, m, d), { name, kind, estimated });
  };

  add(1, 1, "元日");
  add(1, nthMonday(y, 1, 2), "成人の日");
  add(2, 11, "建国記念の日");
  if (y >= 2020) add(2, 23, "天皇誕生日");
  {
    const s = springOf(y, data);
    add(3, s.day, "春分の日", "national", s.estimated);
  }
  add(4, 29, y >= 2007 ? "昭和の日" : "みどりの日");
  add(5, 3, "憲法記念日");
  if (y >= 2007) add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");

  // 海の日: 2000〜2002年は7月20日、2003年から7月の第3月曜日（2020・2021年は五輪に伴う特例）
  if (y === 2020) add(7, 23, "海の日");
  else if (y === 2021) add(7, 22, "海の日");
  else if (y >= 2003) add(7, nthMonday(y, 7, 3), "海の日");
  else add(7, 20, "海の日");

  // 山の日: 2016年から8月11日（2020・2021年は特例）
  if (y === 2020) add(8, 10, "山の日");
  else if (y === 2021) add(8, 8, "山の日");
  else if (y >= 2016) add(8, 11, "山の日");

  // 敬老の日: 2000〜2002年は9月15日、2003年から9月の第3月曜日
  add(9, y >= 2003 ? nthMonday(y, 9, 3) : 15, "敬老の日");
  {
    const a = autumnOf(y, data);
    add(9, a.day, "秋分の日", "national", a.estimated);
  }

  // 体育の日→スポーツの日: 10月の第2月曜日（2020・2021年は特例）
  if (y === 2020) add(7, 24, "スポーツの日");
  else if (y === 2021) add(7, 23, "スポーツの日");
  else add(10, nthMonday(y, 10, 2), y >= 2020 ? "スポーツの日" : "体育の日");

  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");
  if (y <= 2018) add(12, 23, "天皇誕生日");

  // 2019年の天皇の代替わりに伴う特例（4/30・5/2は「国民の休日」の規則で求まる）
  if (y === 2019) {
    add(5, 1, "即位の日", "special");
    add(10, 22, "即位礼正殿の儀", "special");
  }
  return map;
}

let activeData: HolidayData = LIVE_HOLIDAY_DATA;
const cache = new Map<number, Holiday[]>();

/**
 * テスト専用。祝日の計算に使うデータを差し替える（null で実データに戻す）。
 * 「確定／法律どおり／推定」の表示の仕様テストを、自動更新される実データから切り離して固定するために使う。
 * アプリ本体は呼び出さない。
 */
export function setHolidayDataForTesting(data: HolidayData | null): void {
  activeData = data ?? LIVE_HOLIDAY_DATA;
  cache.clear();
}

function assertSupportedYear(y: number): void {
  if (!Number.isInteger(y) || y < HOLIDAY_MIN_YEAR || y > HOLIDAY_MAX_YEAR) {
    throw new RangeError(`祝日を求められるのは${HOLIDAY_MIN_YEAR}〜${HOLIDAY_MAX_YEAR}年です（指定: ${y}）`);
  }
}

/**
 * y年の祝日（国民の休日・振替休日を含む）を日付順で返す。キャッシュを使わず、渡されたデータで求める
 * （公式CSVとの突き合わせ・自動更新の計画で使う。通常のアプリは getHolidays を使う）。
 */
export function computeHolidays(y: number, data: HolidayData): Holiday[] {
  assertSupportedYear(y);

  // 公式CSVと計算ルールが食い違う年は、公式の祝日一覧をそのまま使う
  const official = data.overrides[y];
  if (official) {
    return [...official]
      .sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0))
      .map((h) => ({ iso: h.iso, name: h.name, kind: h.kind, status: y <= data.confirmedThroughYear ? "confirmed" : "statutory" }));
  }

  // 前後の年の祝日も使い、年またぎの「国民の休日」「振替休日」を取りこぼさないようにする
  const all = new Map<string, RawHoliday>();
  for (const yy of [y - 1, y, y + 1]) {
    if (yy < HOLIDAY_MIN_YEAR || yy > HOLIDAY_MAX_YEAR) continue;
    const neighbor = data.overrides[yy];
    if (neighbor) {
      // 隣の年が公式の一覧のときは、その年の祝日（国民の休日・振替休日を除く）を土台にする
      for (const h of neighbor) if (h.kind === "national" || h.kind === "special") all.set(h.iso, { name: h.name, kind: h.kind, estimated: false });
      continue;
    }
    for (const [k, v] of baseHolidays(yy, data)) all.set(k, v);
  }

  // 国民の休日: 前日と翌日が「国民の祝日」で、日曜でも祝日でもない日
  const citizens = new Map<string, RawHoliday>();
  for (const iso of [...all.keys()]) {
    const day = addDaysIso(iso, 2);
    const mid = addDaysIso(iso, 1);
    if (all.has(mid) || !all.has(day)) continue;
    if (weekdayOfIso(mid) === 0) continue;
    citizens.set(mid, {
      name: "国民の休日",
      kind: "citizens",
      estimated: all.get(iso)!.estimated || all.get(day)!.estimated,
    });
  }
  for (const [k, v] of citizens) all.set(k, v);

  // 振替休日: 祝日が日曜に当たるとき、その後で最も近い祝日でない日（2007年より前は翌日の月曜のみ）
  const substitutes = new Map<string, RawHoliday>();
  for (const iso of [...all.keys()].sort()) {
    if (weekdayOfIso(iso) !== 0) continue;
    const srcYear = parseIso(iso).y;
    if (srcYear >= 2007) {
      let candidate = addDaysIso(iso, 1);
      let estimated = all.get(iso)!.estimated;
      while (all.has(candidate) || substitutes.has(candidate)) {
        estimated = estimated || (all.get(candidate)?.estimated ?? false);
        candidate = addDaysIso(candidate, 1);
      }
      substitutes.set(candidate, { name: "振替休日", kind: "substitute", estimated });
    } else {
      const candidate = addDaysIso(iso, 1);
      if (!all.has(candidate)) {
        substitutes.set(candidate, { name: "振替休日", kind: "substitute", estimated: all.get(iso)!.estimated });
      }
    }
  }
  for (const [k, v] of substitutes) all.set(k, v);

  const result: Holiday[] = [...all.entries()]
    .filter(([iso]) => parseIso(iso).y === y)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([iso, h]) => ({
      iso,
      name: h.name,
      kind: h.kind,
      status: y <= data.confirmedThroughYear ? "confirmed" : h.estimated ? "estimated" : "statutory",
    }));
  return result;
}

/** y年の祝日（国民の休日・振替休日を含む）を日付順で返す */
export function getHolidays(y: number): Holiday[] {
  assertSupportedYear(y);
  const hit = cache.get(y);
  if (hit) return hit;
  const result = computeHolidays(y, activeData);
  cache.set(y, result);
  return result;
}

/** 日付（YYYY-MM-DD）から祝日を引くための表 */
export function getHolidayMap(y: number): Map<string, Holiday> {
  return new Map(getHolidays(y).map((h) => [h.iso, h]));
}

export function getHoliday(iso: string): Holiday | undefined {
  return getHolidayMap(parseIso(iso).y).get(iso);
}
