import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import {
  ESTIMATED_MARK,
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
  buildFiscalCalendar,
  eraLabelOf,
  fiscalYearEraLabel,
  holidayDisplayName,
  type WeekStart,
} from "@/lib/calendar/model";
import { pinHolidayData } from "../helpers/holiday-pin";

pinHolidayData(); // 祝日の表示の仕様は、固定データ（2027年まで確定）で確かめる

/**
 * 年度カレンダーの共通モデルのテスト（工程A）。
 * 月の表の開始日と週数は、Python標準のcalendarモジュールで別に求めた参照データ
 * （tests/fixtures/static/calendar-grid-reference.json）と突き合わせる。
 */

const grid = JSON.parse(
  fs.readFileSync(path.join(fixtures.dir.static, "calendar-grid-reference.json"), "utf-8"),
) as Record<string, [string, number]>;

const WEEK_STARTS: WeekStart[] = ["mon", "sun"];

test.describe("年度カレンダーのモデル: 年度と月", () => {
  test("4月から翌年3月までの12か月が、この順に並ぶ（2026年度）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    expect(cal.months.map((m) => `${m.year}-${m.month}`)).toEqual([
      "2026-4", "2026-5", "2026-6", "2026-7", "2026-8", "2026-9",
      "2026-10", "2026-11", "2026-12", "2027-1", "2027-2", "2027-3",
    ]);
    expect(cal.fiscalYear).toBe(2026);
    expect(cal.fiscalYearLabel).toBe("2026年度（令和8年度）");
  });

  test("年度と西暦を区別する: 2026年度の1〜3月は2027年", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "sun" });
    expect(cal.months[8]).toMatchObject({ year: 2026, month: 12 });
    expect(cal.months[9]).toMatchObject({ year: 2027, month: 1 });
    expect(cal.months[11]).toMatchObject({ year: 2027, month: 3 });
  });

  test("うるう年: 2月29日は、2月がうるう年にあたる年度（2027年度→2028年2月）にだけある", () => {
    const countFeb = (fy: number) => {
      const feb = buildFiscalCalendar({ fiscalYear: fy, weekStart: "mon" }).months[10];
      expect(feb.month).toBe(2);
      return feb.weeks.flat().filter((d) => d.inMonth).length;
    };
    expect(countFeb(2027)).toBe(29); // 2028年2月
    expect(countFeb(2023)).toBe(29); // 2024年2月
    expect(countFeb(2026)).toBe(28); // 2027年2月
    expect(countFeb(2025)).toBe(28); // 2026年2月
    // 2099年2月は平年（西暦が4で割り切れ、100で割り切れる2100年は対象外だが、2096年はうるう年）
    expect(countFeb(2095)).toBe(29); // 2096年2月
    // 2月29日の曜日: 2028-02-29 は火曜日
    const feb2028 = buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }).months[10];
    const leapDay = feb2028.weeks.flat().find((d) => d.iso === "2028-02-29");
    expect(leapDay).toMatchObject({ inMonth: true, weekday: 2 });
  });

  test("各月の日数が正しい（2026年度）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    expect(cal.months.map((m) => m.weeks.flat().filter((d) => d.inMonth).length)).toEqual([
      30, 31, 30, 31, 31, 30, 31, 30, 31, 31, 28, 31,
    ]);
  });

  test("対応範囲の外の年度（1999・2099・小数・NaN）はエラーにする", () => {
    for (const fy of [FISCAL_YEAR_MIN - 1, FISCAL_YEAR_MAX + 1, 2026.5, Number.NaN]) {
      expect(() => buildFiscalCalendar({ fiscalYear: fy, weekStart: "mon" }), String(fy)).toThrow(RangeError);
    }
  });
});

test.describe("年度カレンダーのモデル: 週の並びと週数", () => {
  test("全年度（2000〜2098年度）・全12か月・月曜/日曜始まりの表が、Python calendarの結果と一致する", () => {
    const problems: string[] = [];
    for (let fy = FISCAL_YEAR_MIN; fy <= FISCAL_YEAR_MAX; fy++) {
      for (const ws of WEEK_STARTS) {
        const cal = buildFiscalCalendar({ fiscalYear: fy, weekStart: ws });
        for (const m of cal.months) {
          const [start, weeks] = grid[`${m.year}-${m.month}-${ws}`];
          if (m.weeks.length !== weeks) problems.push(`${fy} ${m.year}-${m.month} ${ws}: 週数 ${m.weeks.length} != ${weeks}`);
          if (m.weeks[0][0].iso !== start) problems.push(`${fy} ${m.year}-${m.month} ${ws}: 開始日 ${m.weeks[0][0].iso} != ${start}`);
        }
      }
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  test("4週・5週・6週の月がある（2026年度月曜始まり: 2027年2月は4週、2026年8月は6週）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    expect(cal.months.map((m) => m.weeks.length)).toEqual([5, 5, 5, 5, 6, 5, 5, 6, 5, 5, 4, 5]);
    const sun = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "sun" });
    expect(sun.months.map((m) => m.weeks.length)).toEqual([5, 6, 5, 5, 6, 5, 5, 5, 5, 6, 5, 5]);
  });

  test("月曜始まりは列が月〜日、日曜始まりは日〜土", () => {
    const mon = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    expect(mon.weekdayLabels).toEqual(["月", "火", "水", "木", "金", "土", "日"]);
    expect(mon.weekdayOrder).toEqual([1, 2, 3, 4, 5, 6, 0]);
    const sun = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "sun" });
    expect(sun.weekdayLabels).toEqual(["日", "月", "火", "水", "木", "金", "土"]);
    expect(sun.weekdayOrder).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("どの週も7日で、各列の曜日が見出しと一致し、日付が1日ずつ連続する", () => {
    for (const ws of WEEK_STARTS) {
      const cal = buildFiscalCalendar({ fiscalYear: 2027, weekStart: ws });
      let prev: string | null = null;
      for (const m of cal.months) {
        for (const week of m.weeks) {
          expect(week).toHaveLength(7);
          week.forEach((d, c) => {
            expect(d.weekday, d.iso).toBe(cal.weekdayOrder[c]);
            if (prev) {
              const diff = (Date.parse(`${d.iso}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86_400_000;
              // 次の月の最初の週は前の月の最終週と重なるので、連続は同じ月の中だけで確認する
              if (m.weeks[0] !== week || week.indexOf(d) > 0) expect(diff, d.iso).toBe(1);
            }
            prev = d.iso;
          });
        }
        prev = null;
      }
    }
  });

  test("前後の月の日は inMonth=false で、その月の日はちょうど1回ずつ現れる", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    for (const m of cal.months) {
      const inMonth = m.weeks.flat().filter((d) => d.inMonth);
      expect(new Set(inMonth.map((d) => d.day)).size).toBe(inMonth.length);
      for (const d of m.weeks.flat()) {
        expect(d.inMonth).toBe(d.year === m.year && d.month === m.month);
      }
    }
  });
});

test.describe("年度カレンダーのモデル: 色分けと祝日", () => {
  test("土曜・日曜・祝日・平日の種類が付く（2026年10月）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    const oct = cal.months[6];
    const byIso = new Map(oct.weeks.flat().map((d) => [d.iso, d]));
    expect(byIso.get("2026-10-03")?.kind).toBe("saturday");
    expect(byIso.get("2026-10-04")?.kind).toBe("sunday");
    expect(byIso.get("2026-10-05")?.kind).toBe("weekday");
    expect(byIso.get("2026-10-12")).toMatchObject({ kind: "holiday", holiday: { name: "スポーツの日", status: "confirmed" } });
  });

  test("土曜と重なる祝日は『祝日』の色分けになる（2023年度: 4/29昭和の日と9/23秋分の日が土曜）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2023, weekStart: "mon" });
    const all = cal.months.flatMap((m) => m.weeks.flat());
    for (const iso of ["2023-04-29", "2023-09-23"]) {
      const d = all.find((x) => x.iso === iso && x.inMonth);
      expect(d, iso).toMatchObject({ weekday: 6, kind: "holiday" });
    }
    // 祝日でない土曜・日曜はそれぞれの色分け
    expect(all.find((x) => x.iso === "2023-04-22")?.kind).toBe("saturday");
    expect(all.find((x) => x.iso === "2023-04-23")?.kind).toBe("sunday");
    // 祝日のある日はすべて holiday
    for (const d of all.filter((x) => x.holiday)) expect(d.kind, d.iso).toBe("holiday");
  });

  test("祝日名が日付に付き、その月の祝日一覧と一致する（2026年度 5月）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    const may = cal.months[1];
    expect(may.holidays.map((d) => `${d.day}:${d.holiday?.name}`)).toEqual([
      "3:憲法記念日", "4:みどりの日", "5:こどもの日", "6:振替休日",
    ]);
  });

  test("前後の月の日にも祝日情報が付く（5月の表の先頭週に含まれる4月29日）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    const first = cal.months[1].weeks[0].find((d) => d.iso === "2026-04-29");
    expect(first).toMatchObject({ inMonth: false, kind: "holiday", holiday: { name: "昭和の日" } });
    // その月の祝日一覧には、前後の月の祝日は含めない
    expect(cal.months[1].holidays.some((d) => d.iso === "2026-04-29")).toBe(false);
  });

  test("年またぎ: 2026年度の1月は2027年の祝日（元日・成人の日）を表示する", () => {
    const jan = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" }).months[9];
    expect(jan.holidays.map((d) => `${d.iso}:${d.holiday?.name}`)).toEqual([
      "2027-01-01:元日", "2027-01-11:成人の日",
    ]);
  });

  test("未確定の日付: 2027年度（2028年3月）の春分の日は『推定』で、表示名に※が付く", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" });
    expect(cal.hasEstimatedHoliday).toBe(true);
    const mar = cal.months[11];
    expect(mar.hasEstimatedHoliday).toBe(true);
    const day = mar.holidays[0];
    expect(day.iso).toBe("2028-03-20");
    expect(day.holiday?.status).toBe("estimated");
    expect(holidayDisplayName(day)).toBe(`春分の日${ESTIMATED_MARK}`);
    // 同じ年度の確定済みの祝日には※を付けない
    const nov = cal.months[7].holidays.map(holidayDisplayName);
    expect(nov).toEqual(["文化の日", "勤労感謝の日"]);
    expect(cal.months[0].hasEstimatedHoliday).toBe(false);
    expect(cal.months[0].hasStatutoryHoliday).toBe(false);
  });

  test("2026年度は全祝日が確定している（推定の祝日を含まない）", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "sun" });
    expect(cal.hasEstimatedHoliday).toBe(false);
  });

  test("2027年度までは年度の最後の月（2028年3月）だけ推定が出る", () => {
    const flags = buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }).months.map((m) => m.hasEstimatedHoliday);
    expect(flags).toEqual([false, false, false, false, false, false, false, false, false, false, false, true]);
  });
});

test.describe("年度カレンダーのモデル: 和暦", () => {
  test("月ごとの和暦（2019年4月は平成31年、5月は令和元年）", () => {
    expect(eraLabelOf(2019, 4)).toBe("平成31年");
    expect(eraLabelOf(2019, 5)).toBe("令和元年");
    expect(eraLabelOf(2020, 1)).toBe("令和2年");
    expect(eraLabelOf(2026, 4)).toBe("令和8年");
    expect(eraLabelOf(2000, 1)).toBe("平成12年");
  });

  test("年度の和暦（2018年度は平成30年度、2019年度は令和元年度）", () => {
    expect(fiscalYearEraLabel(2018)).toBe("平成30年度");
    expect(fiscalYearEraLabel(2019)).toBe("令和元年度");
    expect(fiscalYearEraLabel(2027)).toBe("令和9年度");
  });

  test("月の見出しに和暦が付く", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    expect(cal.months[0].eraLabel).toBe("令和8年4月");
    expect(cal.months[11].eraLabel).toBe("令和9年3月");
  });
});
