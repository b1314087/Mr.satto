import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { getHolidays } from "@/lib/calendar/holidays";

/**
 * 祝日の計算結果を、実装とは別に用意した3種類の検証データと突き合わせる（年度カレンダー 工程A）。
 *
 *  1. python-holidays（別実装・MIT）の2000〜2099年の出力（日付と名前）
 *  2. 内閣府の公式CSV「国民の祝日」の日付（2019/1/1〜2027/11/23の165日）
 *  3. 内閣府の公式CSV本体（tests/fixtures/static/syukujitsu.csv）。置かれていれば、
 *     2000年以降の全行（日付と名前）を突き合わせる。内閣府のCSVはShift_JISで配布されているため、
 *     ここで UTF-8 に読み替える。
 * 期待値を実装の関数から作らない。
 */

const STATIC = fixtures.dir.static;

function isoOf(slash: string): string {
  const [y, m, d] = slash.trim().split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

test.describe("祝日: python-holidays との突き合わせ", () => {
  const ref = JSON.parse(
    fs.readFileSync(path.join(STATIC, "holidays-reference-python-holidays-2000-2099.json"), "utf-8"),
  ) as { holidays: Record<string, [string, string][]> };

  test("2000〜2099年の全日付が一致する（過不足なし）", () => {
    const problems: string[] = [];
    for (let y = 2000; y <= 2099; y++) {
      const mine = getHolidays(y).map((h) => h.iso);
      const theirs = ref.holidays[String(y)].map(([d]) => d);
      const extra = mine.filter((d) => !theirs.includes(d));
      const missing = theirs.filter((d) => !mine.includes(d));
      if (extra.length || missing.length) problems.push(`${y}: 余分=${extra} 不足=${missing}`);
    }
    expect(problems).toEqual([]);
  });

  test("祝日名が一致する（2019年の即位に伴う2日だけは表記を短くしているため除く）", () => {
    const shortened = new Set(["2019-05-01", "2019-10-22"]);
    const problems: string[] = [];
    for (let y = 2000; y <= 2099; y++) {
      const mine = new Map(getHolidays(y).map((h) => [h.iso, h.name]));
      for (const [d, name] of ref.holidays[String(y)]) {
        if (shortened.has(d)) continue;
        if (mine.get(d) !== name) problems.push(`${d}: 実装=${mine.get(d)} 参照=${name}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

test.describe("祝日: 内閣府の公式データとの突き合わせ", () => {
  test("公式CSVの日付列（2019〜2027年・165日）と過不足なく一致する", () => {
    const lines = fs
      .readFileSync(path.join(STATIC, "cao-syukujitsu-dates-2019-2027.txt"), "utf-8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines).toHaveLength(165);
    const official = lines.map(isoOf);
    expect(new Set(official).size).toBe(official.length);

    const mine: string[] = [];
    for (let y = 2019; y <= 2027; y++) for (const h of getHolidays(y)) mine.push(h.iso);
    expect(mine).toEqual(official);
  });

  const csvPath = path.join(STATIC, "syukujitsu.csv");
  const hasCsv = fs.existsSync(csvPath);

  test("公式CSV本体（syukujitsu.csv）の2000年以降の全行と、日付も名前も一致する", () => {
    test.skip(!hasCsv, "tests/fixtures/static/syukujitsu.csv が未配置のため、公式CSV本体との突き合わせは未実施");
    const buf = fs.readFileSync(csvPath);
    // 内閣府のCSVはShift_JIS。UTF-8として正しく読めるファイルが置かれた場合にも対応する
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder("shift_jis").decode(buf);
    }
    const rows = text
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim())
      .map((l) => {
        const [date, name] = l.split(",");
        return { iso: isoOf(date), name: name.trim() };
      })
      .filter((r) => r.iso >= "2000-01-01");
    expect(rows.length).toBeGreaterThan(500);

    const last = rows[rows.length - 1].iso;
    const lastYear = Number(last.slice(0, 4));
    const mine: { iso: string; name: string }[] = [];
    for (let y = 2000; y <= lastYear; y++) for (const h of getHolidays(y)) mine.push({ iso: h.iso, name: h.name });

    // 公式の祝日名のうち、実装が別の表記にしているもの
    const officialNameFix: Record<string, string> = {
      "休日": "国民の休日",
    };
    const normalize = (n: string) => officialNameFix[n] ?? n;
    const official = rows.map((r) => ({ iso: r.iso, name: normalize(r.name) }));
    expect(mine.map((m) => m.iso)).toEqual(official.map((o) => o.iso));
    const nameDiffs = official
      .map((o, i) => (o.name !== mine[i].name ? `${o.iso}: 公式=${o.name} 実装=${mine[i].name}` : ""))
      .filter(Boolean);
    expect(nameDiffs).toEqual([]);
  });
});
