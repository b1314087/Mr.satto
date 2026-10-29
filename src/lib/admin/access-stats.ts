/**
 * 管理画面「アクセス数」の集計（純粋な処理だけ。Supabaseには依存しない）。
 *
 * 元になるのは、日ごとの訪問者数・閲覧数（site_visits_daily。日本時間の日付）と、会員の登録日時。
 * 日・週（月曜始まり）・月・年に集計する。
 * 週・月・年の「訪問者数」は、日ごとの訪問者数の合計（延べ人数）。同じ人が別の日に来たら、その日ごとに数える
 * （日をまたいで同じ人を見分けない設計のため。src/lib/analytics/visit.ts）。
 */

export type AccessPeriod = "day" | "week" | "month" | "year";

export const ACCESS_PERIODS: { id: AccessPeriod; label: string; unit: string; count: number }[] = [
  { id: "day", label: "日ごと", unit: "日", count: 30 },
  { id: "week", label: "週ごと", unit: "週", count: 12 },
  { id: "month", label: "月ごと", unit: "か月", count: 12 },
  { id: "year", label: "年ごと", unit: "年", count: 5 },
];

export function parseAccessPeriod(value: string | undefined): AccessPeriod {
  return value === "week" || value === "month" || value === "year" ? value : "day";
}

export interface DailyVisitRow {
  /** YYYY-MM-DD（日本時間） */
  date: string;
  visitors: number;
  pageviews: number;
}

export interface AccessBucket {
  /** 期間の最初の日（YYYY-MM-DD） */
  start: string;
  /** 画面に出す名前（例: 10/29、10/26〜、2026年10月、2026年） */
  label: string;
  /** 記録の開始前の期間は null（0ではなく「記録なし」） */
  visitors: number | null;
  pageviews: number | null;
  /** 新規会員登録数（会員データを取得できなかったときは null） */
  registrations: number | null;
}

// ---- 日付の計算（YYYY-MM-DD の文字列どうしを、UTCで扱う。タイムゾーンの影響を受けない） ----

function toUtc(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}
function addMonths(date: string, months: number): string {
  const d = toUtc(date);
  d.setUTCMonth(d.getUTCMonth() + months, 1);
  return fromUtc(d);
}
function addYears(date: string, years: number): string {
  const [y] = date.split("-").map(Number);
  return `${y + years}-01-01`;
}

/** その日を含む期間の、最初の日。週は月曜始まり */
export function bucketStart(date: string, period: AccessPeriod): string {
  if (period === "day") return date;
  if (period === "week") {
    const dow = toUtc(date).getUTCDay(); // 0=日
    return addDays(date, -((dow + 6) % 7));
  }
  if (period === "month") return `${date.slice(0, 7)}-01`;
  return `${date.slice(0, 4)}-01-01`;
}

function nextStart(start: string, period: AccessPeriod): string {
  if (period === "day") return addDays(start, 1);
  if (period === "week") return addDays(start, 7);
  if (period === "month") return addMonths(start, 1);
  return addYears(start, 1);
}

function labelOf(start: string, period: AccessPeriod): string {
  const [y, m, d] = start.split("-").map(Number);
  if (period === "day") return `${m}/${d}`;
  if (period === "week") return `${m}/${d}〜`;
  if (period === "month") return `${y}年${m}月`;
  return `${y}年`;
}

/** 日本時間の日付（YYYY-MM-DD）。時刻の文字列（ISO）から */
export function jstDateOf(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/**
 * 新しい順ではなく、古い順（左から右・上から下へ新しくなる）の期間のリストを作る。最後が、今日を含む期間。
 * visits: 取得できた日ごとの記録。会員の登録日時（registeredAt）は、取得できなかったとき null を渡す。
 */
export function buildAccessBuckets(input: {
  period: AccessPeriod;
  today: string;
  visits: DailyVisitRow[];
  registeredAt: string[] | null;
}): AccessBucket[] {
  const { period, today, visits, registeredAt } = input;
  const count = ACCESS_PERIODS.find((p) => p.id === period)?.count ?? 30;
  const firstRecorded = visits.length > 0 ? visits.reduce((min, v) => (v.date < min ? v.date : min), visits[0].date) : null;

  // 期間の最初の日を、今日から遡って並べる
  const starts: string[] = [];
  let cursor = bucketStart(today, period);
  for (let i = 0; i < count; i++) {
    starts.unshift(cursor);
    cursor = period === "day" ? addDays(cursor, -1) : period === "week" ? addDays(cursor, -7) : period === "month" ? addMonths(cursor, -1) : addYears(cursor, -1);
  }

  const regDates = registeredAt ? registeredAt.map(jstDateOf) : null;
  return starts.map((start) => {
    const end = nextStart(start, period); // この日より前（end は含まない）
    // 記録の開始日より前に終わる期間は、「記録なし」
    const recorded = firstRecorded !== null && end > firstRecorded;
    let visitors = 0;
    let pageviews = 0;
    for (const v of visits) {
      if (v.date >= start && v.date < end) {
        visitors += v.visitors;
        pageviews += v.pageviews;
      }
    }
    const registrations = regDates ? regDates.filter((d) => d >= start && d < end).length : null;
    return { start, label: labelOf(start, period), visitors: recorded ? visitors : null, pageviews: recorded ? pageviews : null, registrations };
  });
}

/** 期間の合計（記録のない期間は含めない）。1つも記録がなければ null */
export function sumBuckets(buckets: AccessBucket[], key: "visitors" | "pageviews" | "registrations"): number | null {
  let total = 0;
  let any = false;
  for (const b of buckets) {
    const v = b[key];
    if (v !== null) {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}
