import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { computeHolidays, setHolidayDataForTesting, type HolidayData } from "@/lib/calendar/holidays";
import { buildFiscalCalendar } from "@/lib/calendar/model";
import { CALENDAR_THEMES } from "@/lib/calendar/themes";
import { readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { HOLIDAY_DATA_PINNED } from "../helpers/holiday-pin";
import {
  OfficialDataError,
  decodeOfficialBytes,
  formatSnapshotCsv,
  parseOfficialCsv,
  parseSnapshotCsv,
  planSync,
  renderGeneratedModule,
  type GeneratedData,
  type OfficialRow,
} from "../../scripts/holidays/lib";
import { runSync } from "../../scripts/holidays/sync";

/**
 * 祝日データの自動更新（scripts/holidays）のテスト。
 * 公式CSVの代わりに、手で書いた2028年の祝日などを足したCSVを使い、取得・検証・更新・反映・失敗時の安全性を確かめる。
 * 期待値（2028年の祝日の日付など）は、祝日法・暦から手で求めた値で、実装の関数から作っていない。
 */

const STATIC = fixtures.dir.static;
const REPO = path.join(__dirname, "..", "..");
const HEADER = "国民の祝日・休日月日,国民の祝日・休日名称";

/** 現在の公式CSVの控え（2000〜2027年）を、公式の行にしたもの */
// 自動更新で本体側の控えが進んでも結果が変わらないよう、更新前の基準データ（固定）を使う
const BASE_DIR = path.join(STATIC, "holiday-sync-base");
const snapshotText = fs.readFileSync(path.join(BASE_DIR, "cao-syukujitsu-decoded.csv"), "utf-8");
const BASE: OfficialRow[] = parseSnapshotCsv(snapshotText);

/** 2028年の祝日（手で求めた値。春分3/20・秋分9/22、海の日7/17、敬老の日9/18、スポーツの日10/9 など。振替休日・国民の休日はない） */
const ROWS_2028: OfficialRow[] = [
  ["2028-01-01", "元日"], ["2028-01-10", "成人の日"], ["2028-02-11", "建国記念の日"], ["2028-02-23", "天皇誕生日"],
  ["2028-03-20", "春分の日"], ["2028-04-29", "昭和の日"], ["2028-05-03", "憲法記念日"], ["2028-05-04", "みどりの日"],
  ["2028-05-05", "こどもの日"], ["2028-07-17", "海の日"], ["2028-08-11", "山の日"], ["2028-09-18", "敬老の日"],
  ["2028-09-22", "秋分の日"], ["2028-10-09", "スポーツの日"], ["2028-11-03", "文化の日"], ["2028-11-23", "勤労感謝の日"],
].map(([iso, name]) => ({ iso, name }));

const LIVE: HolidayData = {
  confirmedThroughYear: 2027,
  equinoxDays: HOLIDAY_DATA_PINNED.equinoxDays,
  overrides: {},
};
const TODAY = "2027-02-10"; // 2028年分が公表された直後（日本時間）

const csvOf = (rows: readonly OfficialRow[], header = HEADER): string =>
  [header, "1955/1/1,元日", ...rows.map((r) => `${Number(r.iso.slice(0, 4))}/${Number(r.iso.slice(5, 7))}/${Number(r.iso.slice(8, 10))},${r.name}`)].join("\r\n") + "\r\n";
const sorted = (rows: OfficialRow[]) => [...rows].sort((a, b) => (a.iso < b.iso ? -1 : 1));
const plan = (rows: OfficialRow[], over: { current?: HolidayData; today?: string } = {}) =>
  planSync({ rows: parseOfficialCsv(csvOf(sorted(rows))), current: over.current ?? LIVE, currentSnapshot: BASE, today: over.today ?? TODAY });
function update(rows: OfficialRow[], over: { current?: HolidayData; today?: string } = {}) {
  const p = plan(rows, over);
  if (p.status !== "update") throw new Error(`更新になるはず: ${JSON.stringify(p)}`);
  return p;
}
const holidayDataOf = (d: GeneratedData): HolidayData => ({ confirmedThroughYear: d.confirmedThroughYear, equinoxDays: d.equinoxDays, overrides: d.overrides });
const without = (rows: OfficialRow[], iso: string) => rows.filter((r) => r.iso !== iso);

test.describe("公式CSVの読み取りと検証", () => {
  test("Shift_JISの公式CSV（先頭のヘッダー・過去の行つき）を読み、基準データ（更新前の控え）と同じ内容になる", () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(STATIC, "syukujitsu-format-sample-sjis.csv")));
    // 先頭バイトは Shift_JIS の「国」（0x8D 0x91）で、UTF-8としては読めない
    expect([bytes[0], bytes[1]]).toEqual([0x8d, 0x91]);
    const rows = parseOfficialCsv(decodeOfficialBytes(bytes));
    expect(rows.slice(0, 2)).toEqual([{ iso: "1955-01-01", name: "元日" }, { iso: "1955-01-15", name: "成人の日" }]);
    expect(rows.filter((r) => r.iso >= "2000-01-01")).toEqual(BASE);
  });

  test("UTF-8のCSV・BOMつき・LF改行でも読める", () => {
    const text = csvOf(BASE);
    expect(parseOfficialCsv(text.replace(/\r\n/g, "\n"))).toHaveLength(BASE.length + 1);
    expect(decodeOfficialBytes(new Uint8Array(Buffer.from("﻿" + text)))).toBe(text);
  });

  test("控えへの書き出しと読み込みが往復で変わらず、リポジトリの控えファイル（自動更新で進む本体側）とバイト単位で同じ形式になる", () => {
    expect(formatSnapshotCsv(BASE)).toBe(snapshotText);
    const live = fs.readFileSync(path.join(STATIC, "cao-syukujitsu-decoded.csv"), "utf-8");
    expect(formatSnapshotCsv(parseSnapshotCsv(live))).toBe(live);
    expect(parseSnapshotCsv(formatSnapshotCsv(BASE))).toEqual(BASE);
  });

  const invalidCases: [string, string | Uint8Array, RegExp][] = [
    ["HTML（エラーページなど）が返された", new Uint8Array(Buffer.from("<!DOCTYPE html><html>" + "x".repeat(3000))), /HTML/],
    ["小さすぎる（空に近い）", "国民の祝日・休日月日,国民の祝日・休日名称\n", /大きさ/],
    ["ヘッダーがない／別の内容", csvOf(BASE).replace(HEADER, "date,name"), /1行目/],
    ["実在しない日付（2月30日）", csvOf([...BASE, { iso: "2028-02-30", name: "架空の日" }]), /実在しません/],
    ["日付が昇順でない", csvOf([...BASE.slice(0, 200), BASE[10], ...BASE.slice(200)]), /昇順/],
    ["日付が重複している", csvOf([...BASE, BASE[BASE.length - 1]]), /昇順|重複/],
    ["祝日名に使えない文字（<>や絵文字）", csvOf([...BASE, { iso: "2028-03-20", name: "<script>" }]), /祝日名が不正/],
    ["祝日名が長すぎる", csvOf([...BASE, { iso: "2028-03-20", name: "あ".repeat(31) }]), /祝日名が不正/],
    ["行の形式が不正", csvOf(BASE) + "2028/3/20\r\n", /形式が不正/],
    ["対応範囲を超える年（2100年）", csvOf([...BASE, { iso: "2100-01-01", name: "元日" }]), /範囲外/],
  ];
  for (const [label, input, re] of invalidCases) {
    test(`不正なCSV（${label}）は、解析の段階で拒否する`, () => {
      const run = () => parseOfficialCsv(decodeOfficialBytes(typeof input === "string" ? new Uint8Array(Buffer.from(input)) : input));
      let error: unknown;
      try {
        run();
      } catch (e) {
        error = e;
      }
      expect(error, label).toBeInstanceOf(OfficialDataError);
      expect((error as OfficialDataError).problems.join("\n")).toMatch(re);
    });
  }
});

test.describe("更新の計画: 公式データだけで対応できる変更", () => {
  test("現在の公式CSVと同じ内容なら、変更なし（何も書き換えない）", () => {
    expect(plan(BASE)).toEqual({ status: "no-change", confirmedThroughYear: 2027 });
  });

  test("2028年分が公表されたら、確定済みの最終年を2028年に更新する（春分3/20・秋分9/22は確定表に入る）。計算ルールの見直しは不要", () => {
    const p = update([...BASE, ...ROWS_2028]);
    expect(p.data.confirmedThroughYear).toBe(2028);
    expect(p.data.equinoxDays[2028]).toEqual({ spring: 20, autumn: 22 });
    expect(p.data.equinoxDays[2020]).toEqual({ spring: 20, autumn: 22 }); // 既存の年は残る
    expect(p.data.overrides).toEqual({});
    expect(p.newYears).toEqual([2028]);
    expect(p.ruleReview).toEqual([]);
    expect(p.snapshotRows).toHaveLength(BASE.length + ROWS_2028.length);
    // 2028年の祝日が、確定として出る（それまでは法律どおり／推定だった）
    expect(computeHolidays(2028, LIVE).some((h) => h.status === "confirmed")).toBe(false); // 更新前の基準データでは、2028年に確定はない
    const after = holidayDataOf(p.data);
    expect(computeHolidays(2028, after).map((h) => [h.iso, h.name, h.status])).toEqual(ROWS_2028.map((r) => [r.iso, r.name, "confirmed"]));
    expect(computeHolidays(2028, LIVE).find((h) => h.name === "春分の日")?.status).toBe("estimated");
  });

  test("春分・秋分が計算式と違う日で公表されたら（秋分が9/23）、確定表がそれを使い、ルール変更は不要", () => {
    const rows = ROWS_2028.map((r) => (r.name === "秋分の日" ? { iso: "2028-09-23", name: r.name } : r));
    const p = update([...BASE, ...rows]);
    expect(p.data.equinoxDays[2028]).toEqual({ spring: 20, autumn: 23 });
    expect(p.data.overrides).toEqual({});
    const aut = computeHolidays(2028, holidayDataOf(p.data)).find((h) => h.name === "秋分の日");
    expect(aut).toMatchObject({ iso: "2028-09-23", status: "confirmed" });
    // 公示前の推定（計算式）は9/22だった
    expect(computeHolidays(2028, LIVE).find((h) => h.name === "秋分の日")?.iso).toBe("2028-09-22");
  });

  test("公式の2028年分が計算ルールどおりなら、再び同じCSVで計画しても変更なし（不要な更新が起きない）", () => {
    const p = update([...BASE, ...ROWS_2028]);
    const again = planSync({ rows: parseOfficialCsv(csvOf([...BASE, ...ROWS_2028])), current: holidayDataOf(p.data), currentSnapshot: p.snapshotRows, today: TODAY });
    expect(again).toEqual({ status: "no-change", confirmedThroughYear: 2028 });
  });

  test("書き出す祝日データ（TypeScript）は、同じデータからいつも同じ文字列で、確認日だけが違う", () => {
    const p = update([...BASE, ...ROWS_2028]);
    const a = renderGeneratedModule(p.data, "2027-02-10");
    expect(renderGeneratedModule(p.data, "2027-02-10")).toBe(a);
    expect(a).toContain("export const CONFIRMED_THROUGH_YEAR = 2028;");
    expect(a).toContain('export const HOLIDAY_DATA_CHECKED_AT = "2027-02-10";');
    expect(a).toContain("  2028: { spring: 20, autumn: 22 },");
    expect(a).toContain("OFFICIAL_HOLIDAY_OVERRIDES: Readonly<Record<number, readonly OfficialHoliday[]>> = {};");
  });
});

test.describe("更新の計画: 祝日法の改正（祝日の追加・変更・削除）", () => {
  const withChange = (edit: (rows: OfficialRow[]) => OfficialRow[]) => update([...BASE, ...edit(ROWS_2028)]);

  test("新しい祝日の追加: その年の公式の一覧をそのまま使い、計算ルールの見直しが必要と知らせる", () => {
    const p = withChange((r) => [...r, { iso: "2028-06-15", name: "海洋の日" }]);
    expect(p.overrideYears).toEqual([2028]);
    expect(p.ruleReview.join("\n")).toMatch(/2028年.*公式のみ 2028-06-15 海洋の日/);
    const day = computeHolidays(2028, holidayDataOf(p.data)).find((h) => h.iso === "2028-06-15");
    expect(day).toMatchObject({ name: "海洋の日", kind: "national", status: "confirmed" });
    expect(p.changes.find((c) => c.year === 2028)?.added).toContain("2028-06-15 海洋の日");
    expect(p.data.overrides[2028].map((h) => h.iso)).toEqual(sorted([...ROWS_2028, { iso: "2028-06-15", name: "x" }]).map((r) => r.iso));
  });

  test("祝日の日付変更（山の日 8/11→8/12）: 旧日付が消え、新日付が出る", () => {
    const p = withChange((r) => r.map((x) => (x.name === "山の日" ? { iso: "2028-08-12", name: "山の日" } : x)));
    const days = computeHolidays(2028, holidayDataOf(p.data));
    expect(days.find((h) => h.iso === "2028-08-11")).toBeUndefined();
    expect(days.find((h) => h.iso === "2028-08-12")).toMatchObject({ name: "山の日" });
    expect(p.changes.find((c) => c.year === 2028)).toMatchObject({ added: ["2028-08-12 山の日"], removed: ["2028-08-11 山の日"] });
  });

  test("祝日名の変更（文化の日→文化芸術の日）", () => {
    const p = withChange((r) => r.map((x) => (x.name === "文化の日" ? { iso: x.iso, name: "文化芸術の日" } : x)));
    expect(computeHolidays(2028, holidayDataOf(p.data)).find((h) => h.iso === "2028-11-03")?.name).toBe("文化芸術の日");
    expect(p.changes.find((c) => c.year === 2028)?.renamed).toEqual(["2028-11-03 文化の日 → 文化芸術の日"]);
    expect(p.overrideYears).toEqual([2028]);
  });

  test("祝日の削除（建国記念の日を廃止）", () => {
    const p = withChange((r) => without(r, "2028-02-11"));
    expect(computeHolidays(2028, holidayDataOf(p.data)).find((h) => h.iso === "2028-02-11")).toBeUndefined();
    expect(p.changes.find((c) => c.year === 2028)?.removed).toEqual(["2028-02-11 建国記念の日"]);
  });

  test("すでに確定済みの年（2027年）の祝日が変更された場合も反映する（今年以降の年）", () => {
    const base2027 = BASE.map((r) => (r.iso === "2027-11-03" ? { iso: "2027-11-04", name: r.name } : r));
    const p = planSync({ rows: parseOfficialCsv(csvOf(base2027)), current: LIVE, currentSnapshot: BASE, today: "2026-10-20" });
    if (p.status !== "update") throw new Error("更新になるはず");
    expect(p.overrideYears).toEqual([2027]);
    expect(computeHolidays(2027, holidayDataOf(p.data)).map((h) => h.iso)).toContain("2027-11-04");
    expect(computeHolidays(2027, holidayDataOf(p.data)).map((h) => h.iso)).not.toContain("2027-11-03");
  });

  test("追加した祝日が日曜なら、公式の「休日」を振替休日に分類する。連休に挟まれた「休日」は国民の休日", () => {
    // 2028-06-04(日)に新しい祝日 → 6/5(月)が「休日」（振替）。6/8(木)・6/10(土)に新しい祝日 → 6/9(金)が「休日」（国民の休日）
    const p = withChange((r) => [
      ...r,
      { iso: "2028-06-04", name: "新しい祝日甲" }, { iso: "2028-06-05", name: "休日" },
      { iso: "2028-06-08", name: "新しい祝日乙" }, { iso: "2028-06-09", name: "休日" }, { iso: "2028-06-10", name: "新しい祝日丙" },
    ]);
    const days = new Map(computeHolidays(2028, holidayDataOf(p.data)).map((h) => [h.iso, h]));
    expect(days.get("2028-06-05")).toMatchObject({ name: "振替休日", kind: "substitute" });
    expect(days.get("2028-06-09")).toMatchObject({ name: "国民の休日", kind: "citizens" });
    expect(days.get("2028-06-04")).toMatchObject({ name: "新しい祝日甲", kind: "national" });
  });

  test("年末の日曜に新しい祝日（2028-12-31）が加わると、翌年（公式CSVの範囲外）の振替休日（2029-01-02）にも影響する", () => {
    const p = withChange((r) => [...r, { iso: "2028-12-31", name: "新しい年末の祝日" }]);
    const data = holidayDataOf(p.data);
    expect(computeHolidays(2028, data).map((h) => h.iso)).toContain("2028-12-31");
    // 2029-01-01(月)は元日。12/31(日)の振替は、元日を飛ばした1/2(火)
    const y2029 = computeHolidays(2029, data);
    expect(y2029.find((h) => h.iso === "2029-01-02")).toMatchObject({ name: "振替休日", kind: "substitute", status: "statutory" });
    expect(computeHolidays(2029, LIVE).find((h) => h.iso === "2029-01-02")).toBeUndefined();
  });

  test("公式の一覧を使う年（override）の祝日は、法律どおり／推定の区別を使わず、すべて確定になる。それより先の年は従来どおり", () => {
    const p = withChange((r) => [...r, { iso: "2028-06-15", name: "海洋の日" }]);
    const data = holidayDataOf(p.data);
    expect(computeHolidays(2028, data).every((h) => h.status === "confirmed")).toBe(true);
    expect(computeHolidays(2029, data).find((h) => h.name === "春分の日")?.status).toBe("estimated");
    expect(computeHolidays(2029, data).find((h) => h.name === "元日")?.status).toBe("statutory");
  });

  test("計算ルールに戻った年は、overrideから外れる（ルールを直したあとの公式との一致）", () => {
    const first = withChange((r) => [...r, { iso: "2028-06-15", name: "海洋の日" }]);
    // 次の取得では、その祝日が取り消され、ルールどおりに戻った
    const back = planSync({ rows: parseOfficialCsv(csvOf([...BASE, ...ROWS_2028])), current: holidayDataOf(first.data), currentSnapshot: first.snapshotRows, today: TODAY });
    if (back.status !== "update") throw new Error("更新になるはず");
    expect(back.data.overrides).toEqual({});
    expect(back.ruleReview).toEqual([]);
  });
});

test.describe("更新の計画: 不正・不審なデータでは、既存データを守る", () => {
  const rejected = (rows: OfficialRow[], re: RegExp, over: { current?: HolidayData; today?: string } = {}) => {
    const p = plan(rows, over);
    expect(p.status).toBe("invalid");
    expect(p.status === "invalid" ? p.problems.join("\n") : "").toMatch(re);
  };

  test("過去の年（今年より前）の祝日が変わっているCSVは、取得データの異常として拒否する", () => {
    rejected([...without(BASE, "2026-01-01"), ...ROWS_2028], /過去の年（2026年）/, { today: "2027-02-10" });
    rejected([...BASE.map((r) => (r.iso === "2025-11-03" ? { iso: "2025-11-04", name: r.name } : r)), ...ROWS_2028], /過去の年（2025年）/);
  });

  test("確定済みの最終年より前までしかないCSV（データが減った）は拒否する", () => {
    rejected(BASE.filter((r) => r.iso < "2027-01-01"), /減っています|前です/);
  });

  test("先の年が極端に先（今年から4年先）まで載っているCSVは拒否する", () => {
    const far = Array.from({ length: 4 }, (_, i) => ROWS_2028.map((r) => ({ iso: `${2028 + i}${r.iso.slice(4)}`, name: r.name }))).flat();
    rejected([...BASE, ...far], /3年を超えて先/, { today: "2026-10-20" });
  });

  test("1年の祝日の数が極端に少ない／多いCSVは拒否する", () => {
    rejected([...BASE, ...ROWS_2028.slice(0, 5), ROWS_2028[15]], /2028年の祝日の数が想定の範囲外/);
  });

  test("最終年が途中までの場合（11月23日より前で終わる）は、その年を確定として扱わない", () => {
    const partial = [...BASE, ...ROWS_2028.filter((r) => r.iso < "2028-11-01")];
    const p = plan(partial);
    // 2028年は不完全 → 最終年は2027年のまま。変更なし
    expect(p).toEqual({ status: "no-change", confirmedThroughYear: 2027 });
  });

  test("変更行数が上限を超える（大量に書き換わったCSV）は、自動では更新しない", () => {
    const many = ROWS_2028.flatMap((r) => [0, 1, 2, 3, 4].map((k) => ({ iso: `${2028 + k}${r.iso.slice(4)}`, name: r.name })));
    rejected([...BASE, ...many], /変更行数|3年を超えて先/, { today: "2028-06-01" });
  });
});

/** 一時フォルダに、更新処理が読み書きするファイルだけを置く */
function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "holiday-sync-"));
  const baseFiles: [string, string][] = [
    ["cao-syukujitsu-decoded.csv", "tests/fixtures/static/cao-syukujitsu-decoded.csv"],
    ["cao-syukujitsu-snapshot.json", "tests/fixtures/static/cao-syukujitsu-snapshot.json"],
    ["holiday-data.generated.ts.txt", "src/lib/calendar/holiday-data.generated.ts"],
  ];
  for (const [from, to] of baseFiles) {
    fs.mkdirSync(path.join(root, path.dirname(to)), { recursive: true });
    fs.copyFileSync(path.join(BASE_DIR, from), path.join(root, to));
  }
  return root;
}
const read = (root: string, f: string) => fs.readFileSync(path.join(root, f), "utf-8");
const TRACKED = ["tests/fixtures/static/cao-syukujitsu-decoded.csv", "tests/fixtures/static/cao-syukujitsu-snapshot.json", "src/lib/calendar/holiday-data.generated.ts"];
const snapshotOf = (root: string) => TRACKED.map((f) => [f, read(root, f)]);

test.describe("更新の実行（ファイルの書き換え）", () => {
  const bytes = (rows: OfficialRow[]) => new Uint8Array(Buffer.from(csvOf(sorted(rows))));

  test("検証に通ると、祝日データ・公式CSVの控え・取得の記録の3つが書き換わる。--dry-run では書き換えない", async () => {
    const root = sandbox();
    const before = snapshotOf(root);
    const dry = await runSync({ root, csvBytes: bytes([...BASE, ...ROWS_2028]), dryRun: true, today: TODAY, current: LIVE });
    expect(dry.status).toBe("updated");
    expect(snapshotOf(root)).toEqual(before);

    const r = await runSync({ root, csvBytes: bytes([...BASE, ...ROWS_2028]), today: TODAY, current: LIVE });
    expect(r).toMatchObject({ exitCode: 0, status: "updated" });
    expect(read(root, "src/lib/calendar/holiday-data.generated.ts")).toContain("CONFIRMED_THROUGH_YEAR = 2028;");
    const csv = read(root, "tests/fixtures/static/cao-syukujitsu-decoded.csv");
    expect(csv.trim().split("\n")).toHaveLength(BASE.length + ROWS_2028.length);
    const meta = JSON.parse(read(root, "tests/fixtures/static/cao-syukujitsu-snapshot.json"));
    expect(meta).toMatchObject({ retrievedAt: TODAY, rows: BASE.length + ROWS_2028.length, firstYear: 2000, lastYear: 2028 });
    expect(meta.snapshotSha256).toBe(crypto.createHash("sha256").update(csv).digest("hex"));
    expect(fs.readdirSync(path.join(root, "src/lib/calendar")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  const failures: [string, Uint8Array][] = [
    ["HTMLが返された", new Uint8Array(Buffer.from("<html>" + "x".repeat(3000)))],
    ["ヘッダー不正", new Uint8Array(Buffer.from(csvOf(BASE, "a,b")))],
    ["過去の年が変わっている", bytes([...without(BASE, "2026-01-01"), ...ROWS_2028])],
    ["空のファイル", new Uint8Array(0)],
  ];
  for (const [label, data] of failures) {
    test(`不正なデータ（${label}）では、どのファイルも書き換えず、終了コード11（データ不正）で終わる`, async () => {
      const root = sandbox();
      const before = snapshotOf(root);
      const r = await runSync({ root, csvBytes: data, today: TODAY, current: LIVE });
      expect(r).toMatchObject({ exitCode: 11, status: "invalid" });
      expect(r.messages.length).toBeGreaterThan(0);
      expect(snapshotOf(root)).toEqual(before);
    });
  }

  test("変更がないときは、何も書き換えない（ファイルの更新日時も変わらない）", async () => {
    const root = sandbox();
    const before = TRACKED.map((f) => fs.statSync(path.join(root, f)).mtimeMs);
    const r = await runSync({ root, csvBytes: bytes(BASE), today: TODAY, current: LIVE });
    expect(r).toMatchObject({ exitCode: 0, status: "no-change" });
    expect(TRACKED.map((f) => fs.statSync(path.join(root, f)).mtimeMs)).toEqual(before);
  });

  /** 公式サイトの代わりのHTTPサーバー */
  async function withServer(handler: http.RequestListener, run: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/syukujitsu.csv`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test("取得に失敗した（HTTP 503・404・HTML・接続できない）ときは、終了コード10（取得失敗）で、何も書き換えない。503は再試行する", async () => {
    process.env.HOLIDAY_SYNC_RETRY_DELAY_MS = "5";
    try {
      const root = sandbox();
      const before = snapshotOf(root);
      let hits = 0;
      await withServer((_req, res) => { hits++; res.statusCode = 503; res.end("busy"); }, async (url) => {
        expect(await runSync({ root, url, today: TODAY, current: LIVE })).toMatchObject({ exitCode: 10, status: "fetch-failed" });
      });
      expect(hits).toBe(3); // 3回まで試す
      await withServer((_req, res) => { res.statusCode = 404; res.end("not found"); }, async (url) => {
        expect(await runSync({ root, url, today: TODAY, current: LIVE })).toMatchObject({ exitCode: 10, status: "fetch-failed" });
      });
      await withServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<html>maintenance</html>"); }, async (url) => {
        expect(await runSync({ root, url, today: TODAY, current: LIVE })).toMatchObject({ exitCode: 10, status: "fetch-failed" });
      });
      expect(await runSync({ root, url: "http://127.0.0.1:1/syukujitsu.csv", today: TODAY, current: LIVE })).toMatchObject({ exitCode: 10, status: "fetch-failed" });
      expect(snapshotOf(root)).toEqual(before);
    } finally {
      delete process.env.HOLIDAY_SYNC_RETRY_DELAY_MS;
    }
  });

  test("HTTPで取得したCSV（Content-Type: text/csv）で、更新まで通る", async () => {
    const root = sandbox();
    await withServer((_req, res) => { res.setHeader("content-type", "text/csv"); res.end(Buffer.from(csvOf(sorted([...BASE, ...ROWS_2028])))); }, async (url) => {
      expect(await runSync({ root, url, today: TODAY, current: LIVE })).toMatchObject({ exitCode: 0, status: "updated" });
    });
    expect(read(root, "src/lib/calendar/holiday-data.generated.ts")).toContain("CONFIRMED_THROUGH_YEAR = 2028;");
  });
});

test.describe("実際のスクリプト（ビルドして実行）を、2回続けて動かす", () => {
  test.setTimeout(180_000);
  /** 本番と同じ手順（TypeScriptをビルド → node で実行）。リポジトリ本体は書き換えず、一時フォルダの複製で行う */
  function cliSandbox(): string {
    const root = sandbox();
    for (const f of ["src/lib/calendar/holidays.ts", "src/lib/calendar/holiday-data.ts", "scripts/holidays/lib.ts", "scripts/holidays/sync.ts", "scripts/holidays/tsconfig.json"]) {
      fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(REPO, f), path.join(root, f));
    }
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
    return root;
  }
  function cli(root: string, args: string[]): { code: number; out: string } {
    execFileSync(path.join(REPO, "node_modules/.bin/tsc"), ["-p", "scripts/holidays/tsconfig.json"], { cwd: root, stdio: "pipe" });
    try {
      const out = execFileSync("node", [".holiday-sync-build/scripts/holidays/sync.js", ...args], { cwd: root, stdio: "pipe", env: { ...process.env, HOLIDAY_SYNC_TODAY: TODAY, HOLIDAY_SYNC_RETRY_DELAY_MS: "5", GITHUB_OUTPUT: path.join(root, "gh-output.txt"), GITHUB_STEP_SUMMARY: path.join(root, "gh-summary.md") } }).toString();
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: Buffer };
      return { code: err.status, out: err.stdout.toString() };
    }
  }

  test("1回目は更新、2回目（同じCSV）は変更なし。HTMLを返された3回目は、データ不正で何も変えない。GitHub Actions用の出力も書かれる", async () => {
    const root = cliSandbox();
    const good = path.join(root, "official.csv");
    fs.writeFileSync(good, csvOf(sorted([...BASE, ...ROWS_2028])));

    const first = cli(root, ["--csv-file", good]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("更新あり");
    expect(read(root, "gh-output.txt")).toContain("status=updated");
    expect(read(root, "gh-output.txt")).toContain("rule_review=false");
    expect(read(root, "src/lib/calendar/holiday-data.generated.ts")).toContain("CONFIRMED_THROUGH_YEAR = 2028;");

    // 2回目: 更新後のデータで、同じCSV → 変更なし。ファイルは1バイトも変わらない
    const afterFirst = snapshotOf(root);
    const mtimes = TRACKED.map((f) => fs.statSync(path.join(root, f)).mtimeMs);
    fs.rmSync(path.join(root, "gh-output.txt"));
    const second = cli(root, ["--csv-file", good]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("変更なし");
    expect(read(root, "gh-output.txt")).toContain("status=no-change");
    expect(snapshotOf(root)).toEqual(afterFirst);
    expect(TRACKED.map((f) => fs.statSync(path.join(root, f)).mtimeMs)).toEqual(mtimes);

    // 3回目: 壊れたデータ → 終了コード11、何も変わらない
    const bad = path.join(root, "bad.csv");
    fs.writeFileSync(bad, "<html>" + "x".repeat(3000));
    const third = cli(root, ["--csv-file", bad]);
    expect(third.code).toBe(11);
    expect(snapshotOf(root)).toEqual(afterFirst);
  });

  test("祝日法の改正を含むCSVでは、更新したうえで、計算ルールの見直しが必要という出力（rule_review=true）を書く", async () => {
    const root = cliSandbox();
    const csv = path.join(root, "official.csv");
    fs.writeFileSync(csv, csvOf(sorted([...BASE, ...ROWS_2028, { iso: "2028-06-15", name: "海洋の日" }])));
    const r = cli(root, ["--csv-file", csv]);
    expect(r.code).toBe(0);
    expect(read(root, "gh-output.txt")).toContain("rule_review=true");
    expect(r.out).toContain("計算ルールの見直し");
    const generated = read(root, "src/lib/calendar/holiday-data.generated.ts");
    expect(generated).toContain('{ iso: "2028-06-15", name: "海洋の日", kind: "national" },');
  });
});

test.describe("更新後のデータが、カレンダーの出力に反映される", () => {
  test.afterEach(() => setHolidayDataForTesting(null));

  test("祝日法の改正（2028-06-15に新しい祝日）が、年度カレンダーのモデル・Excelに出る。改正前は出ない", async () => {
    const p = update([...BASE, ...ROWS_2028, { iso: "2028-06-15", name: "海洋の日" }]);
    const cell = (cal: ReturnType<typeof buildFiscalCalendar>) => cal.months[2].weeks.flat().find((d) => d.iso === "2028-06-15"); // 2028年度の6月

    setHolidayDataForTesting(LIVE);
    expect(cell(buildFiscalCalendar({ fiscalYear: 2028, weekStart: "mon" }))?.holiday).toBeNull();

    setHolidayDataForTesting(holidayDataOf(p.data));
    const cal = buildFiscalCalendar({ fiscalYear: 2028, weekStart: "mon" });
    expect(cell(cal)?.holiday).toMatchObject({ name: "海洋の日", status: "confirmed" });
    const xlsx = await buildCalendarExcel({ calendar: cal, theme: CALENDAR_THEMES.business, orientation: "landscape", showAdjacentDays: false });
    const wb = readXlsxWorkbook(new Uint8Array(await xlsx.arrayBuffer()));
    const names = wb.sheets[2].cells;
    expect([...names.values()].some((c) => c.value === "海洋の日"), "6月のシートに祝日名がある").toBe(true);
    // 2028年度の他の月（4月）には出ない
    expect([...wb.sheets[0].cells.values()].some((c) => c.value === "海洋の日")).toBe(false);
  });

  test("2028年分の公表後は、2028年度のカレンダーの注記から『推定』が消える（春分の日が確定になる）", () => {
    const p = update([...BASE, ...ROWS_2028]);
    setHolidayDataForTesting(LIVE);
    expect(buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }).hasEstimatedHoliday).toBe(true);
    setHolidayDataForTesting(holidayDataOf(p.data));
    expect(buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }).hasEstimatedHoliday).toBe(false);
    expect(buildFiscalCalendar({ fiscalYear: 2028, weekStart: "mon" }).months[11].hasEstimatedHoliday).toBe(true); // 2029年3月は、まだ先
  });
});
