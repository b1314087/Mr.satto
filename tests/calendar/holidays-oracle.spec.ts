import crypto from "node:crypto";
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
 *  3. 内閣府の公式CSV本体。Shift_JISで配布されているものをブラウザ上で正しく読み替えて保存した
 *     2000〜2027年の486行（cao-syukujitsu-2000-2027-decoded.csv。取得の経緯は cao-syukujitsu-provenance.txt）と、
 *     tests/fixtures/static/syukujitsu.csv（置かれていれば）の2000年以降の全行（日付と名前）。
 * 期待値を実装の関数から作らない。
 */

const STATIC = fixtures.dir.static;

function isoOf(slash: string): string {
  const [y, m, d] = slash.trim().split("/").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

interface OfficialRow {
  iso: string;
  name: string;
}

/** 公式CSVの本文（日付,名称の行）を読み取る。ヘッダー行・空行は無視する */
function parseOfficialRows(text: string): OfficialRow[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\d{4}\//.test(l))
    .map((l) => {
      const [date, name] = l.split(",");
      return { iso: isoOf(date), name: name.trim() };
    });
}

/**
 * 公式データの表記と、実装の表記の対応。
 * 内閣府のCSVは、振替休日と国民の休日をどちらも「休日」と書き、2019年の即位に伴う2日を
 * 「休日（祝日扱い）」と書く。実装は利用者に分かりやすいよう区別して表示する。
 * そのため、名前の一致は「公式の表記が、実装の種別（kind）と矛盾しないか」で判定する。
 */
function nameMatches(official: string, mine: { name: string; kind: string }): boolean {
  if (official === "休日") return mine.kind === "substitute" || mine.kind === "citizens";
  if (official.startsWith("休日（祝日扱い）")) return mine.kind === "special";
  if (official === "体育の日（スポーツの日）") return mine.name === "体育の日"; // 2019年: 名称変更の前年
  return official === mine.name;
}

/** 公式の行と実装の祝日を突き合わせ、件数と不一致を返す */
function compareWithOfficial(rows: OfficialRow[]) {
  const first = Number(rows[0].iso.slice(0, 4));
  const last = Number(rows[rows.length - 1].iso.slice(0, 4));
  const mine: { iso: string; name: string; kind: string }[] = [];
  for (let y = first; y <= last; y++) for (const h of getHolidays(y)) mine.push({ iso: h.iso, name: h.name, kind: h.kind });
  const officialDates = new Set(rows.map((r) => r.iso));
  const mineByIso = new Map(mine.map((m) => [m.iso, m]));
  const missingInMine = rows.filter((r) => !mineByIso.has(r.iso)).map((r) => r.iso);
  const extraInMine = mine.filter((m) => !officialDates.has(m.iso)).map((m) => m.iso);
  const nameDiffs = rows
    .filter((r) => mineByIso.has(r.iso) && !nameMatches(r.name, mineByIso.get(r.iso)!))
    .map((r) => `${r.iso}: 公式=${r.name} 実装=${mineByIso.get(r.iso)!.name}(${mineByIso.get(r.iso)!.kind})`);
  return { years: last - first + 1, officialCount: rows.length, mineCount: mine.length, missingInMine, extraInMine, nameDiffs };
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

  test("公式CSV（Shift_JISを解読して保存した2000〜2027年・486行）と、日付も名前も過不足なく一致する", () => {
    const text = fs.readFileSync(path.join(STATIC, "cao-syukujitsu-2000-2027-decoded.csv"), "utf-8");
    // 保存したデータが、公式CSVから取り出した内容のまま壊れていないこと（取得時に別途計算したSHA-256）
    expect(crypto.createHash("sha256").update(text).digest("hex")).toBe(
      "2301283e7a4d2a8170124b737772e918df3a3d56853048f70f72f1e015e80698",
    );
    const rows = parseOfficialRows(text);
    expect(rows).toHaveLength(486);
    const result = compareWithOfficial(rows);
    expect(result).toEqual({
      years: 28,
      officialCount: 486,
      mineCount: 486,
      missingInMine: [],
      extraInMine: [],
      nameDiffs: [],
    });
  });

  test("公式の表記ゆれの対応が、取り違えを見逃さない（振替休日と国民の休日、祝日扱い）", () => {
    expect(nameMatches("休日", { name: "振替休日", kind: "substitute" })).toBe(true);
    expect(nameMatches("休日", { name: "国民の休日", kind: "citizens" })).toBe(true);
    expect(nameMatches("休日", { name: "憲法記念日", kind: "national" })).toBe(false);
    expect(nameMatches("休日（祝日扱い）", { name: "即位の日", kind: "special" })).toBe(true);
    expect(nameMatches("休日（祝日扱い）", { name: "振替休日", kind: "substitute" })).toBe(false);
    expect(nameMatches("昭和の日", { name: "みどりの日", kind: "national" })).toBe(false);
  });

  const csvPath = path.join(STATIC, "syukujitsu.csv");
  const hasCsv = fs.existsSync(csvPath);

  test("公式CSV本体（syukujitsu.csv）が置かれていれば、2000年以降の全行と一致する", () => {
    test.skip(!hasCsv, "tests/fixtures/static/syukujitsu.csv は未配置（上のテストが同じ内容を保存データで確認している）");
    const buf = fs.readFileSync(csvPath);
    // 内閣府のCSVはShift_JIS。UTF-8として正しく読めるファイルが置かれた場合にも対応する
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = new TextDecoder("shift_jis").decode(buf);
    }
    const rows = parseOfficialRows(text).filter((r) => r.iso >= "2000-01-01");
    expect(rows.length).toBeGreaterThan(486 - 1);
    const result = compareWithOfficial(rows);
    expect(result.missingInMine).toEqual([]);
    expect(result.extraInMine).toEqual([]);
    expect(result.nameDiffs).toEqual([]);
  });
});
