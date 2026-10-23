import { test, expect } from "@playwright/test";
import { MIN_DAY_ROWS, parseMonthColumns, resolveMonthColumnEntries, type MonthColumnItem } from "@/lib/calendar/pdf-month-columns";

/**
 * 「月ごとの列に、日・曜日・予定が縦に並ぶ」形式の行事予定表（PDF）の読み取り。座標つきの文字から作った入力で確認する。
 */

const WEEK = "日月火水木金土";
const FY2026 = { start: "2026-04-01", end: "2027-03-31" };

const t = (str: string, x: number, y: number, width = str.length * 7): MonthColumnItem => ({ str, x, y, width, fontHeight: 7 });

/** 1つの月の列（見出し・日・曜日・予定）を作る。events は 日 → 予定の文字（複数あれば、離して並べる） */
function monthColumn(baseX: number, header: string, year: number, month: number, events: Record<number, string[]> = {}): MonthColumnItem[] {
  const items: MonthColumnItem[] = [t(header, baseX + 66, 499, 13)];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const y = 486 - (d - 1) * 12.5;
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    items.push(t(String(d), baseX + (d < 10 ? 0 : -3), y, d < 10 ? 3 : 6), t(WEEK[wd], baseX + 7, y, 7));
    (events[d] ?? []).forEach((text, i) => items.push(t(text, baseX + 17 + i * 120, y + (i === 0 ? 0 : 1), text.length * 7)));
  }
  return items;
}

test.describe("月ごとの列の行事予定表: 読み取り", () => {
  const page = [
    ...monthColumn(58, "1月", 2027, 1, { 1: ["「元日」"], 5: ["教育相談再開", "入試願書受付開始"], 8: ["始業式 追認考査"], 11: ["「成人の日」"] }),
    ...monthColumn(210, "2月", 2027, 2, { 3: ["教科会 成績等入力"], 11: ["「建国記念の日」", "合否判定会"], 14: ["◎"] }),
    ...monthColumn(361, "3月", 2027, 3, { 3: ["学年末考査①"], 21: ["「春分の日」"] }),
    ...monthColumn(514, "４月（詳細は後日）", 2027, 4, { 1: ["辞令交付式"], 29: ["「昭和の日」"] }),
  ];

  test("日・曜日の行を、列ごとに見つける（予定のない日も数える）", () => {
    const parsed = parseMonthColumns(page);
    expect(parsed.dayRowCount).toBe(31 + 28 + 31 + 30);
    expect(parsed.dayRowCount).toBeGreaterThanOrEqual(MIN_DAY_ROWS);
  });

  test("予定を月・日・曜日つきで取り出す。離れた文字は別の予定、近い文字は1つの予定。記号だけの予定は捨てる", () => {
    const { entries } = parseMonthColumns(page);
    const of = (month: number, day: number) => entries.filter((e) => e.month === month && e.day === day).map((e) => e.text);
    expect(of(1, 5)).toEqual(["教育相談再開", "入試願書受付開始"]);
    expect(of(1, 8)).toEqual(["始業式 追認考査"]);
    expect(of(2, 3)).toEqual(["教科会 成績等入力"]);
    expect(of(2, 11)).toEqual(["「建国記念の日」", "合否判定会"]);
    expect(of(2, 14)).toEqual([]); // 「◎」だけ
    expect(of(3, 3)).toEqual(["学年末考査①"]); // 「①」などは、書かれたまま
    expect(of(4, 1)).toEqual(["辞令交付式"]); // 「４月（詳細は後日）」の見出しも月として読む
    expect(entries.find((e) => e.month === 1 && e.day === 1)).toMatchObject({ weekday: 5, text: "「元日」" }); // 金曜日
  });

  test("年は、書かれている曜日に合う年から決める。対象年度外の年も、曜日で決める", () => {
    const { entries } = parseMonthColumns(page);
    const r = resolveMonthColumnEntries(entries, FY2026);
    const dates = r.rows.map((x) => x[0]);
    expect(dates).toContain("2027-01-05");
    expect(dates).toContain("2027-02-03");
    expect(dates).toContain("2027-03-03");
    expect(dates).toContain("2027-04-01"); // 2026年度の外（翌年度）。対象年度外として扱われる
    expect(r.unresolved).toBe(0);
    // 日付の順に並ぶ
    expect([...dates].sort()).toEqual(dates);
  });

  test("祝日の名前だけの予定は、読み取らない（カレンダーに祝日が出るため）。祝日でない「」つきの予定は残す", () => {
    const { entries } = parseMonthColumns(page);
    const r = resolveMonthColumnEntries(entries, FY2026);
    const titles = r.rows.map((x) => x[1]);
    expect(titles).not.toContain("「成人の日」");
    expect(titles).not.toContain("「春分の日」");
    expect(titles).not.toContain("「昭和の日」");
    expect(r.skippedHolidayLabels).toBeGreaterThanOrEqual(3);
    // 「元日」は2027年の祝日で、読み取らない。「年始休業」のような祝日でないものは、残る
    expect(titles).not.toContain("「元日」");
    const withLabel = resolveMonthColumnEntries([{ page: 1, month: 1, day: 2, weekday: 6, text: "「年始休業」" }], FY2026);
    expect(withLabel.rows).toEqual([["2027-01-02", "「年始休業」"]]);
    // 祝日の名前が他の予定と同じ文字の先頭にあるときは、名前だけを除いて、予定は残す
    expect(resolveMonthColumnEntries([{ page: 1, month: 2, day: 11, weekday: 4, text: "「建国記念の日」 合否判定会" }], FY2026).rows).toEqual([["2027-02-11", "合否判定会"]]);
    // その日の祝日ではない名前（別の日の祝日名など）は、そのまま残す
    expect(resolveMonthColumnEntries([{ page: 1, month: 2, day: 12, weekday: 5, text: "「建国記念の日」" }], FY2026).rows).toHaveLength(1);
  });

  test("曜日が合う年がない（書き間違い）の予定は、推測で年を決めず、「月/日」のまま残す", () => {
    // 2月30日は、どの年にも存在しない（曜日が合う年がない）
    const r = resolveMonthColumnEntries([{ page: 1, month: 2, day: 30, weekday: 2, text: "存在しない日" }], FY2026);
    expect(r.rows).toEqual([["2/30", "存在しない日"]]);
    expect(r.unresolved).toBe(1);
    expect(r.resolved).toBe(0);
  });

  test("年度が変わると、同じ月日でも、曜日に合う年を選び直す（2027年度なら2028年の月日が対象年度内）", () => {
    const r = resolveMonthColumnEntries([{ page: 1, month: 1, day: 5, weekday: 3, text: "予定" }], { start: "2027-04-01", end: "2028-03-31" });
    expect(r.rows[0][0]).toBe("2028-01-05"); // 2028年1月5日は水曜日（weekday=3）。2027年度の範囲内
  });

  test("普通の表（日付・予定の列）のPDFは、この形式とみなさない", () => {
    const table: MonthColumnItem[] = [t("日付", 50, 760), t("予定", 200, 760), t("2026/04/06", 50, 730), t("入学式", 200, 730), t("2026/04/07", 50, 700), t("始業式", 200, 700)];
    expect(parseMonthColumns(table).dayRowCount).toBeLessThan(MIN_DAY_ROWS);
    expect(parseMonthColumns([]).entries).toEqual([]);
  });
});
