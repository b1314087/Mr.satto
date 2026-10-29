import { test, expect } from "@playwright/test";
import { addDays, bucketStart, buildAccessBuckets, jstDateOf, parseAccessPeriod, sumBuckets } from "@/lib/admin/access-stats";

/** 管理画面「アクセス数」の集計（日・週・月・年）。Supabaseには接続しない */

const visits = [
  { date: "2026-10-20", visitors: 5, pageviews: 9 },
  { date: "2026-10-26", visitors: 10, pageviews: 20 }, // 月曜
  { date: "2026-10-28", visitors: 7, pageviews: 12 },
  { date: "2026-10-29", visitors: 3, pageviews: 4 },
];

test.describe("アクセス数の集計", () => {
  test("期間の指定は、日・週・月・年のみ。不明な値は「日ごと」", () => {
    expect(parseAccessPeriod("week")).toBe("week");
    expect(parseAccessPeriod("month")).toBe("month");
    expect(parseAccessPeriod("year")).toBe("year");
    for (const v of [undefined, "", "day", "hour", "<script>"]) expect(parseAccessPeriod(v)).toBe("day");
  });

  test("日付の計算：月またぎ・年またぎ・うるう年", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  test("週は月曜始まり、月は1日、年は1月1日", () => {
    expect(bucketStart("2026-10-29", "week")).toBe("2026-10-26"); // 木曜 → 月曜
    expect(bucketStart("2026-10-26", "week")).toBe("2026-10-26");
    expect(bucketStart("2026-11-01", "week")).toBe("2026-10-26"); // 日曜 → 前の月曜
    expect(bucketStart("2026-10-29", "month")).toBe("2026-10-01");
    expect(bucketStart("2026-10-29", "year")).toBe("2026-01-01");
  });

  test("日本時間の日付に直す（UTCの夕方は、日本では翌日）", () => {
    expect(jstDateOf("2026-10-28T15:30:00Z")).toBe("2026-10-29");
    expect(jstDateOf("2026-10-28T14:59:59Z")).toBe("2026-10-28");
  });

  test("日ごと：30日分、最後が今日。記録のない日は0、記録開始前は「記録なし」", () => {
    const b = buildAccessBuckets({ period: "day", today: "2026-10-29", visits, registeredAt: [] });
    expect(b).toHaveLength(30);
    expect(b[29]).toMatchObject({ start: "2026-10-29", label: "10/29", visitors: 3, pageviews: 4 });
    expect(b[28]).toMatchObject({ start: "2026-10-28", visitors: 7 });
    expect(b[27]).toMatchObject({ start: "2026-10-27", visitors: 0, pageviews: 0 }); // 記録開始後の0
    expect(b[0].start).toBe("2026-09-30");
    expect(b[0].visitors).toBeNull(); // 記録開始（10/20）より前
    expect(b[10]).toMatchObject({ start: "2026-10-10", visitors: null });
    expect(b[20]).toMatchObject({ start: "2026-10-20", visitors: 5 });
  });

  test("週ごと：12週分、月曜始まりで合計する", () => {
    const b = buildAccessBuckets({ period: "week", today: "2026-10-29", visits, registeredAt: [] });
    expect(b).toHaveLength(12);
    expect(b[11]).toMatchObject({ start: "2026-10-26", label: "10/26〜", visitors: 20, pageviews: 36 });
    expect(b[10]).toMatchObject({ start: "2026-10-19", visitors: 5, pageviews: 9 });
    expect(b[9].visitors).toBeNull();
  });

  test("月ごと・年ごと：12か月／5年。年またぎも正しい", () => {
    const m = buildAccessBuckets({ period: "month", today: "2026-10-29", visits, registeredAt: [] });
    expect(m).toHaveLength(12);
    expect(m[11]).toMatchObject({ start: "2026-10-01", label: "2026年10月", visitors: 25, pageviews: 45 });
    expect(m[0].start).toBe("2025-11-01");
    expect(m[9]).toMatchObject({ start: "2026-08-01", visitors: null });
    const y = buildAccessBuckets({ period: "year", today: "2026-10-29", visits, registeredAt: [] });
    expect(y).toHaveLength(5);
    expect(y[4]).toMatchObject({ start: "2026-01-01", label: "2026年", visitors: 25 });
    expect(y[0].start).toBe("2022-01-01");
    const jan = buildAccessBuckets({ period: "month", today: "2026-01-15", visits: [], registeredAt: [] });
    expect(jan[11].start).toBe("2026-01-01");
    expect(jan[10].start).toBe("2025-12-01");
  });

  test("記録がまったくないときは、すべて「記録なし」", () => {
    const b = buildAccessBuckets({ period: "day", today: "2026-10-29", visits: [], registeredAt: [] });
    expect(b.every((x) => x.visitors === null && x.pageviews === null)).toBe(true);
    expect(sumBuckets(b, "visitors")).toBeNull();
  });

  test("新規会員登録数：日本時間の日付ごとに数える。取得できなければ null", () => {
    const reg = ["2026-10-28T15:10:00Z", "2026-10-29T01:00:00Z", "2026-10-20T00:00:00Z"];
    const day = buildAccessBuckets({ period: "day", today: "2026-10-29", visits, registeredAt: reg });
    expect(day[29].registrations).toBe(2);
    expect(day[21].registrations).toBe(0);
    expect(day[20].registrations).toBe(1);
    const month = buildAccessBuckets({ period: "month", today: "2026-10-29", visits, registeredAt: reg });
    expect(month[11].registrations).toBe(3);
    const none = buildAccessBuckets({ period: "day", today: "2026-10-29", visits, registeredAt: null });
    expect(none.every((x) => x.registrations === null)).toBe(true);
  });

  test("合計：記録のない期間は含めない", () => {
    const b = buildAccessBuckets({ period: "day", today: "2026-10-29", visits, registeredAt: [] });
    expect(sumBuckets(b, "visitors")).toBe(25);
    expect(sumBuckets(b, "pageviews")).toBe(45);
  });
});
