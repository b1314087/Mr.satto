import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { assertDownloadedFile, clickAndDownload } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import {
  bulkFill,
  checkSchedule,
  clearType,
  daysInMonth,
  defaultTypes,
  DEFAULT_SETTINGS,
  emptyCells,
  formatDuration,
  monthDays,
  parseSavedSchedule,
  parseStaffNames,
  parseTime,
  resizeCells,
  serializeSchedule,
  summarize,
  timingOf,
  validateStaff,
  validateType,
  validateTypes,
  validateYearMonth,
  type ShiftSchedule,
  type ShiftType,
} from "../../src/lib/shift/model";
import { shiftToCsvBlob, typeTimeText } from "../../src/lib/processors/browser/shift-export";

/**
 * シフト表作成（shift-schedule）のテスト。
 * 1. 時間の計算・入力の検証・集計・目安との比較・一括入力・保存ファイルの規則（純粋な関数）の単体テスト
 * 2. 実際に勤務を入れ、集計・警告・PDF/Excel/CSVの内容を確認する画面テスト。名前は外部に送信されない。値はすべて架空。
 */

const TYPES = defaultTypes(); // t1 早(07:00-16:00,休憩60=実働8:00) t2 遅(12:00-21:00) t3 日(09:00-18:00) t4 休 t5 有
function make(rows: Record<string, (string | null)[]>, over: Partial<ShiftSchedule> = {}): ShiftSchedule {
  const staff = Object.keys(rows).map((name, i) => ({ id: `s${i + 1}`, name }));
  const cells: Record<string, (string | null)[]> = {};
  staff.forEach((s) => (cells[s.id] = rows[s.name]));
  return { title: "", year: 2026, month: 10, types: TYPES, staff, cells, settings: { ...DEFAULT_SETTINGS }, ...over };
}
const fill = (n: number, id: string | null) => Array.from({ length: n }, () => id);

// ---------------------------------------------------------------------------
// 1. 規則（単体）
// ---------------------------------------------------------------------------
plainTest.describe("shift-schedule: 時刻と勤務区分", () => {
  plainTest("時刻は半角・全角どちらでも読め、範囲外は読まない。24:00は終了時刻だけ", () => {
    plainExpect(parseTime("09:00")).toBe(540);
    plainExpect(parseTime("９：００".replace("：", ":"))).toBe(540);
    plainExpect(parseTime(" 7:05 ")).toBe(425);
    plainExpect(parseTime("24:00")).toBeNull();
    plainExpect(parseTime("24:00", true)).toBe(1440);
    plainExpect(parseTime("24:01", true)).toBeNull();
    plainExpect(parseTime("12:60")).toBeNull();
    plainExpect(parseTime("abc")).toBeNull();
    plainExpect(parseTime("")).toBeNull();
    plainExpect(formatDuration(152 * 60 + 30)).toBe("152:30");
  });

  plainTest("実働は、終了−開始−休憩。日をまたぐ勤務は翌日の時刻として数える", () => {
    plainExpect(timingOf(TYPES[0])?.netMinutes).toBe(8 * 60);
    const night: ShiftType = { id: "n", code: "夜", name: "夜勤", kind: "work", start: "22:00", end: "06:00", breakMinutes: 60, color: "purple" };
    const t = timingOf(night)!;
    plainExpect(t.overnight).toBe(true);
    plainExpect(t.netMinutes).toBe(7 * 60);
    plainExpect(t.endMinutes).toBe(30 * 60);
    plainExpect(typeTimeText(night)).toBe("22:00〜翌06:00（休憩60分・実働7:00）");
    plainExpect(typeTimeText({ ...night, start: "00:00", end: "24:00", breakMinutes: 0 })).toBe("00:00〜24:00（休憩0分・実働24:00）");
    plainExpect(typeTimeText(TYPES[3])).toContain("休み");
    plainExpect(timingOf(TYPES[3])).toBeNull();
  });

  plainTest("入力の不備（略称の重複・空・長すぎ、時刻、休憩）を、理由つきで見つける", () => {
    plainExpect(validateTypes(TYPES)).toEqual([]);
    const dup = [...TYPES, { ...TYPES[0], id: "x", name: "別の早番" }];
    plainExpect(validateTypes(dup).join("\n")).toContain("略称「早」が、ほかの勤務区分と重なっています");
    plainExpect(validateType({ ...TYPES[0], code: "" }, TYPES).join("")).toContain("略称が空です");
    plainExpect(validateType({ ...TYPES[0], code: "あいうえ" }, TYPES).join("")).toContain("3文字まで");
    plainExpect(validateType({ ...TYPES[0], start: "25:00" }, TYPES).join("")).toContain("開始時刻");
    plainExpect(validateType({ ...TYPES[0], end: "9時" }, TYPES).join("")).toContain("終了時刻");
    plainExpect(validateType({ ...TYPES[0], start: "09:00", end: "09:00" }, TYPES).join("")).toContain("同じです");
    plainExpect(validateType({ ...TYPES[0], breakMinutes: 600 }, TYPES).join("")).toContain("勤務時間以上");
    plainExpect(validateType({ ...TYPES[0], breakMinutes: -5 }, TYPES).join("")).toContain("休憩");
    plainExpect(validateType({ ...TYPES[3], start: "bad", end: "bad" }, TYPES)).toEqual([]); // 休みは時刻を見ない
    plainExpect(validateTypes([]).join("")).toContain("勤務区分がありません");
    plainExpect(validateTypes(Array.from({ length: 13 }, (_, i) => ({ ...TYPES[0], id: `q${i}`, code: String(i) }))).join("")).toContain("12個まで");
  });

  plainTest("スタッフの名前は、空・重複（全角半角・空白の違いを含む）を見つけ、貼り付けは区切って読む", () => {
    plainExpect(validateStaff([{ id: "a", name: "山田" }, { id: "b", name: "佐藤" }])).toEqual([]);
    plainExpect(validateStaff([{ id: "a", name: "山田" }, { id: "b", name: " 山田 " }]).join("")).toContain("重なっています");
    plainExpect(validateStaff([{ id: "a", name: "ＡＢＣ" }, { id: "b", name: "ABC" }]).join("")).toContain("重なっています");
    plainExpect(validateStaff([{ id: "a", name: "" }]).join("")).toContain("名前が空");
    plainExpect(validateStaff([]).join("")).toContain("スタッフがいません");
    plainExpect(validateStaff(Array.from({ length: 61 }, (_, i) => ({ id: `s${i}`, name: `n${i}` }))).join("")).toContain("60人まで");
    plainExpect(parseStaffNames("山田\n\n 佐藤 、鈴木,高橋，田中\r\n")).toEqual(["山田", "佐藤", "鈴木", "高橋", "田中"]);
  });

  plainTest("年月の範囲と、月の日数・祝日・曜日", () => {
    plainExpect(validateYearMonth(2026, 10)).toBeNull();
    plainExpect(validateYearMonth(1999, 1)).toContain("年");
    plainExpect(validateYearMonth(2026, 13)).toContain("月");
    plainExpect(daysInMonth(2024, 2)).toBe(29);
    plainExpect(daysInMonth(2026, 2)).toBe(28);
    const days = monthDays(2026, 1);
    plainExpect(days[0]).toMatchObject({ day: 1, weekdayLabel: "木", holiday: "元日" });
    plainExpect(days).toHaveLength(31);
  });
});

plainTest.describe("shift-schedule: 集計と目安との比較", () => {
  plainTest("出勤日数・休日数・未入力・実働時間と、日ごとの出勤人数を数える", () => {
    const row = (...ids: (string | null)[]) => [...ids, ...fill(31 - ids.length, null)];
    const s = make({ 山田: row("t1", "t1", "t4", "t2", "t5"), 佐藤: row("t3", "t4", null, "t1") });
    const sum = summarize(s);
    plainExpect(sum.perStaff[0]).toEqual({ workDays: 3, offDays: 2, blankDays: 26, workMinutes: 3 * 480 });
    plainExpect(sum.perStaff[1]).toEqual({ workDays: 2, offDays: 1, blankDays: 28, workMinutes: 2 * 480 });
    plainExpect(sum.perDay[0].working).toBe(2); // 山田・佐藤とも勤務
    plainExpect(sum.perDay[1].working).toBe(1);
    plainExpect(sum.perDay[2].working).toBe(0);
    plainExpect(sum.perDay[0].byType.t1).toBe(1);
  });

  plainTest("連続勤務の上限を超えたら、期間つきで知らせる。上限ちょうどは問題にしない。0は確認しない", () => {
    const n = 31;
    const seven = [...fill(7, "t3"), "t4", ...fill(n - 8, null)];
    const six = [...fill(6, "t3"), "t4", ...fill(n - 7, null)];
    const issues = checkSchedule(make({ 山田: seven, 佐藤: six }));
    const cons = issues.filter((i) => i.kind === "consecutive");
    plainExpect(cons).toHaveLength(1);
    plainExpect(cons[0].message).toContain("山田：7日連続の勤務です（10月1日(木)〜10月7日(水)");
    plainExpect(cons[0].days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const off = checkSchedule(make({ 山田: seven }, { settings: { ...DEFAULT_SETTINGS, maxConsecutive: 0 } }));
    plainExpect(off.filter((i) => i.kind === "consecutive")).toEqual([]);
    // 月の最後まで続く連続も数える
    const tail = [...fill(n - 7, null), ...fill(7, "t3")];
    plainExpect(checkSchedule(make({ 山田: tail })).filter((i) => i.kind === "consecutive")).toHaveLength(1);
  });

  plainTest("勤務間の休息時間は、前日の終了から翌日の開始まで。夜勤は翌日にかかった分を含める", () => {
    const n = 31;
    const pad = (ids: (string | null)[]) => [...ids, ...fill(n - ids.length, null)];
    // 遅番(〜21:00)→早番(07:00〜) = 10時間 < 11
    const late = checkSchedule(make({ 山田: pad(["t2", "t1"]) })).filter((i) => i.kind === "rest");
    plainExpect(late).toHaveLength(1);
    plainExpect(late[0].message).toContain("10:00しかあいていません（目安は11時間以上）");
    plainExpect(late[0].days).toEqual([1, 2]);
    // 早番(〜16:00)→早番(07:00〜) = 15時間 → 問題なし
    plainExpect(checkSchedule(make({ 山田: pad(["t1", "t1"]) })).filter((i) => i.kind === "rest")).toEqual([]);
    // 休みをはさめば確認しない
    plainExpect(checkSchedule(make({ 山田: pad(["t2", "t4", "t1"]) })).filter((i) => i.kind === "rest")).toEqual([]);
    // 夜勤(22:00〜翌06:00)→翌日の日勤(09:00〜)は、3時間
    const night: ShiftType = { id: "t9", code: "夜", name: "夜勤", kind: "work", start: "22:00", end: "06:00", breakMinutes: 60, color: "purple" };
    const nightIssues = checkSchedule(make({ 山田: pad(["t9", "t3"]) }, { types: [...TYPES, night] })).filter((i) => i.kind === "rest");
    plainExpect(nightIssues).toHaveLength(1);
    plainExpect(nightIssues[0].message).toContain("3:00しかあいていません");
    // 夜勤→夜勤は、16時間あく
    plainExpect(checkSchedule(make({ 山田: pad(["t9", "t9"]) }, { types: [...TYPES, night] })).filter((i) => i.kind === "rest")).toEqual([]);
    // 確認しない設定(0)
    plainExpect(checkSchedule(make({ 山田: pad(["t2", "t1"]) }, { settings: { ...DEFAULT_SETTINGS, minRestHours: 0 } })).filter((i) => i.kind === "rest")).toEqual([]);
  });

  plainTest("1日の必要人数と、未入力の数を知らせる", () => {
    const n = 31;
    const s = make({ 山田: [...fill(n, "t3")], 佐藤: [...fill(n - 1, "t3"), "t4"] }, { settings: { ...DEFAULT_SETTINGS, maxConsecutive: 0, minStaffPerDay: 2 } });
    const issues = checkSchedule(s);
    const min = issues.filter((i) => i.kind === "min-staff");
    plainExpect(min).toHaveLength(1);
    plainExpect(min[0].message).toContain("10月31日(土)：出勤が1人です（必要人数は2人）");
    plainExpect(issues.some((i) => i.kind === "blank")).toBe(false);
    const blank = checkSchedule(make({ 山田: [...fill(30, "t3"), null] }, { settings: { ...DEFAULT_SETTINGS, maxConsecutive: 0 } }));
    plainExpect(blank.find((i) => i.kind === "blank")?.message).toContain("未入力のセルが1個");
  });
});

plainTest.describe("shift-schedule: 一括入力・日数の変更・保存ファイル", () => {
  plainTest("曜日・祝日を指定して入れる。すでに入っているマスを変えない指定もできる", () => {
    // 2026年10月: 土曜 3,10,17,24,31 / 日曜 4,11,18,25 / 祝日 12日（スポーツの日）
    const s = make({ 山田: fill(31, null), 佐藤: [...fill(2, "t3"), "t1", ...fill(28, null)] });
    const r = bulkFill(s, { staffIds: [], weekdays: [0, 6], includeHolidays: true, typeId: "t4", onlyBlank: true });
    plainExpect(r.changed).toBe(19); // 2人 × (5+4+1) − 佐藤の3日（すでに入っている）
    const yamada = r.cells.s1;
    plainExpect(yamada.map((v, i) => (v === "t4" ? i + 1 : 0)).filter(Boolean)).toEqual([3, 4, 10, 11, 12, 17, 18, 24, 25, 31]);
    // 佐藤の3日（土）は「早」が入っているが、onlyBlank なので変えない
    plainExpect(r.cells.s2[2]).toBe("t1");
    const over = bulkFill(s, { staffIds: ["s2"], weekdays: [6], includeHolidays: false, typeId: "t4", onlyBlank: false });
    plainExpect(over.cells.s2[2]).toBe("t4");
    plainExpect(over.cells.s1.every((v) => v === null)).toBe(true); // 対象外の人は変わらない
    const cleared = bulkFill({ ...s, cells: r.cells }, { staffIds: ["s1"], weekdays: [6], includeHolidays: false, typeId: null, onlyBlank: false });
    plainExpect(cleared.cells.s1[2]).toBeNull();
    plainExpect(cleared.changed).toBe(5);
  });

  plainTest("月を変えたら日数にそろえ、勤務区分を消したら、その区分のマスは未入力に戻す", () => {
    plainExpect(resizeCells(["t1", "t2", "t3"], 2)).toEqual(["t1", "t2"]);
    plainExpect(resizeCells(["t1"], 3)).toEqual(["t1", null, null]);
    plainExpect(resizeCells(undefined, 2)).toEqual([null, null]);
    const r = clearType({ s1: ["t1", "t2", "t1"], s2: ["t1", null, "t3"] }, "t1");
    plainExpect(r.cleared).toBe(3);
    plainExpect(r.cells).toEqual({ s1: [null, "t2", null], s2: [null, null, "t3"] });
    plainExpect(emptyCells(3)).toEqual([null, null, null]);
  });

  plainTest("保存ファイルは、書き出して読み直すと同じ。壊れた・別形式・不正な内容は、理由を返して読まない", () => {
    const s = make({ 山田: [...fill(5, "t1"), ...fill(26, null)], 佐藤: fill(31, "t4") }, { title: "10月分" });
    const text = serializeSchedule(s);
    const back = parseSavedSchedule(text);
    plainExpect(back.error).toBeNull();
    plainExpect(back.schedule).toEqual(s);

    plainExpect(parseSavedSchedule("{壊れた").error).toContain("JSONの形式ではありません");
    plainExpect(parseSavedSchedule(JSON.stringify({ app: "other", version: 1, schedule: {} })).error).toContain("このツールで保存したファイルではありません");
    plainExpect(parseSavedSchedule(JSON.stringify({ app: "mr-satto-shift", version: 99, schedule: {} })).error).toContain("バージョン");
    const bad = JSON.parse(text);
    bad.schedule.month = 13;
    plainExpect(parseSavedSchedule(JSON.stringify(bad)).error).toContain("年月");
    const dupId = JSON.parse(text);
    dupId.schedule.staff[1].id = dupId.schedule.staff[0].id;
    plainExpect(parseSavedSchedule(JSON.stringify(dupId)).error).toContain("スタッフのID");
    // 未知の勤務区分IDのマス・文字でないマスは、未入力に直す。未知の色は灰色にする
    const odd = JSON.parse(text);
    odd.schedule.cells.s1[0] = "zzz";
    odd.schedule.cells.s1[1] = 5;
    odd.schedule.types[0].color = "nonexistent";
    const fixed = parseSavedSchedule(JSON.stringify(odd)).schedule!;
    plainExpect(fixed.cells.s1.slice(0, 3)).toEqual([null, null, "t1"]);
    plainExpect(fixed.types[0].color).toBe("gray");
    // 人数・区分数が上限を超えるファイルは読まない
    const many = JSON.parse(text);
    many.schedule.staff = Array.from({ length: 61 }, (_, i) => ({ id: `q${i}`, name: String(i) }));
    plainExpect(parseSavedSchedule(JSON.stringify(many)).error).toContain("上限");
  });

  plainTest("CSVは、1行が1人。数式として実行される名前の先頭に ' を付ける。BOM付きのUTF-8", async () => {
    const s = make({ "=1+1": [...fill(2, "t1"), ...fill(29, null)], 佐藤: fill(31, "t4") });
    const blob = shiftToCsvBlob(s);
    const buf = Buffer.from(await blob.arrayBuffer());
    plainExpect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString("utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
    plainExpect(lines[0].startsWith("氏名,1日(木),2日(金)")).toBe(true);
    plainExpect(lines[0].endsWith("出勤日数,休日数,未入力,実働時間")).toBe(true);
    plainExpect(lines[1].startsWith("'=1+1,早,早,")).toBe(true);
    plainExpect(lines[1].endsWith(",2,0,29,16:00")).toBe(true);
    plainExpect(lines[2].endsWith(",0,31,0,0:00")).toBe(true);
    plainExpect(lines[3].startsWith("出勤人数,1,1,0,")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------
async function openTool(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/tools/shift-schedule");
  await expect(page.getByTestId("shift-title")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="shift-title"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
  // 年月を固定する（2026年10月: 1日が木曜）
  await page.getByTestId("shift-year").fill("2026");
  await page.getByTestId("shift-month").selectOption("10");
  await expect(page.getByTestId("shift-cell-0-31")).toBeVisible();
}

const cell = (page: Page, staff: number, day: number) => page.getByTestId(`shift-cell-${staff}-${day}`);

test("shift-schedule: 初めから表が出て、勤務区分を選んでマスを押すと入り、集計に反映される。同じ区分を押し直しても変わらない", async ({ page }) => {
  await openTool(page);
  await expect(page.getByTestId("tool-preview")).toBeVisible();
  await expect(page.getByTestId("shift-row-3")).toBeVisible(); // 初期は4人
  await expect(cell(page, 0, 1)).toHaveAttribute("data-code", "");

  await page.getByTestId("shift-brush-早").click();
  await cell(page, 0, 1).click();
  await cell(page, 0, 1).click();
  await expect(cell(page, 0, 1)).toHaveAttribute("data-code", "早");
  await page.getByTestId("shift-brush-休").click();
  await cell(page, 0, 2).click();
  await expect(page.getByTestId("shift-sum-work-0")).toHaveText("1");
  await expect(page.getByTestId("shift-sum-off-0")).toHaveText("1");
  await expect(page.getByTestId("shift-sum-blank-0")).toHaveText("29");
  await expect(page.getByTestId("shift-sum-time-0")).toHaveText("8:00");
  await expect(page.getByTestId("shift-day-count-1")).toHaveText("1");
  await expect(page.getByTestId("shift-day-count-2")).toHaveText("0");

  // 消す
  await page.getByTestId("shift-brush-clear").click();
  await cell(page, 0, 1).click();
  await expect(cell(page, 0, 1)).toHaveAttribute("data-code", "");
  await expect(page.getByTestId("shift-sum-work-0")).toHaveText("0");

  // キーボード（Enter）でも入る
  await page.getByTestId("shift-brush-日").click();
  await cell(page, 1, 5).focus();
  await page.keyboard.press("Enter");
  await expect(cell(page, 1, 5)).toHaveAttribute("data-code", "日");
});

test("shift-schedule: マウスでなぞると、続けて入る", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("shift-brush-日").click();
  const from = await cell(page, 2, 3).boundingBox();
  const to = await cell(page, 2, 8).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await page.mouse.up();
  for (let d = 3; d <= 8; d++) await expect(cell(page, 2, d), `${d}日`).toHaveAttribute("data-code", "日");
  await expect(cell(page, 2, 2)).toHaveAttribute("data-code", "");
  await expect(cell(page, 2, 9)).toHaveAttribute("data-code", "");
  // マウスを離したあとは、動かしても入らない
  await page.mouse.move(to!.x + 100, to!.y + to!.height / 2, { steps: 4 });
  await expect(cell(page, 2, 10)).toHaveAttribute("data-code", "");
});

test("shift-schedule: 曜日を指定してまとめて入れる（土日・祝日。入っているマスは変えない指定）", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("shift-brush-日").click();
  await cell(page, 0, 3).click(); // 土曜に先に「日」
  await page.getByTestId("shift-bulk-weekday-0").check();
  await page.getByTestId("shift-bulk-weekday-6").check();
  await page.getByTestId("shift-bulk-holiday").check();
  await page.getByTestId("shift-bulk-type").selectOption({ label: "休 休み" });
  await page.getByTestId("shift-bulk-run").click();
  // 4人 × 10日 − すでに入っていた1マス
  await expect(page.getByTestId("shift-bulk-message")).toHaveText("39個のセルを変更しました。");
  await expect(cell(page, 0, 3)).toHaveAttribute("data-code", "日");
  await expect(cell(page, 0, 4)).toHaveAttribute("data-code", "休");
  await expect(cell(page, 1, 12)).toHaveAttribute("data-code", "休"); // 祝日（スポーツの日）
  await expect(cell(page, 1, 5)).toHaveAttribute("data-code", ""); // 月曜
  await expect(page.getByTestId("shift-sum-off-0")).toHaveText("9");

  // 曜日も祝日も選ばないと、入れずに知らせる
  await page.getByTestId("shift-bulk-weekday-0").uncheck();
  await page.getByTestId("shift-bulk-weekday-6").uncheck();
  await page.getByTestId("shift-bulk-holiday").uncheck();
  await page.getByTestId("shift-bulk-run").click();
  await expect(page.getByTestId("shift-bulk-message")).toContainText("曜日を1つ以上");
});

test("shift-schedule: 連続勤務・休息時間・必要人数が目安に合わない箇所を、印と一覧で知らせる", async ({ page }) => {
  await openTool(page);
  await expect(page.getByTestId("shift-issues")).toContainText("未入力のセルが");
  await page.getByTestId("shift-brush-日").click();
  for (let d = 1; d <= 7; d++) await cell(page, 0, d).click();
  await expect(page.getByTestId("shift-issues")).toContainText("スタッフ1：7日連続の勤務です");
  await expect(cell(page, 0, 4)).toHaveAttribute("data-flagged", "true");
  await expect(cell(page, 1, 4)).not.toHaveAttribute("data-flagged", "true");
  // 上限を7日にすると、問題でなくなる
  await page.getByTestId("shift-max-consecutive").fill("7");
  await expect(page.getByTestId("shift-issues")).not.toContainText("連続の勤務です");
  await expect(cell(page, 0, 4)).not.toHaveAttribute("data-flagged", "true");

  // 遅番→翌日の早番は、10時間しかあかない
  await page.getByTestId("shift-brush-遅").click();
  await cell(page, 1, 10).click();
  await page.getByTestId("shift-brush-早").click();
  await cell(page, 1, 11).click();
  await expect(page.getByTestId("shift-issues")).toContainText("スタッフ2：10月10日(土)の「遅番」の終了から、翌日の「早番」の開始まで、10:00しかあいていません");
  await expect(cell(page, 1, 11)).toHaveAttribute("data-flagged", "true");

  // 必要人数
  await page.getByTestId("shift-min-staff").fill("2");
  await expect(page.getByTestId("shift-issues")).toContainText("10月8日(木)：出勤が0人です（必要人数は2人）");
  await expect(page.getByTestId("shift-issues")).toContainText("10月1日(木)：出勤が1人です");
});

test("shift-schedule: 勤務区分に不備があると、理由を示して書き出しを止め、確認も止める。直すと元に戻る", async ({ page }) => {
  await openTool(page);
  await expect(page.getByRole("button", { name: "PDFでダウンロード" })).toBeEnabled();
  // 略称を重ねる
  await page.getByTestId("shift-type-code-1").fill("早");
  await expect(page.getByTestId("shift-type-errors")).toContainText("略称「早」が、ほかの勤務区分と重なっています");
  await expect(page.getByTestId("shift-export-blocked")).toBeVisible();
  await expect(page.getByRole("button", { name: "PDFでダウンロード" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Excelでダウンロード" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toBeDisabled();
  await expect(page.getByTestId("shift-issues")).toContainText("確認は行っていません");
  await page.getByTestId("shift-type-code-1").fill("遅");
  await expect(page.getByTestId("shift-type-errors")).toHaveCount(0);

  // 時刻の不備・休憩が長すぎる
  await page.getByTestId("shift-type-start-0").fill("25:00");
  await expect(page.getByTestId("shift-type-errors")).toContainText("開始時刻");
  await page.getByTestId("shift-type-start-0").fill("07:00");
  await page.getByTestId("shift-type-break-0").fill("600");
  await expect(page.getByTestId("shift-type-errors")).toContainText("勤務時間以上");
  await page.getByTestId("shift-type-break-0").fill("60");
  await expect(page.getByTestId("shift-type-errors")).toHaveCount(0);

  // 同じ名前のスタッフ
  await page.getByTestId("shift-staff-name-1").fill("スタッフ1");
  await expect(page.getByTestId("shift-staff-errors")).toContainText("重なっています");
  await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toBeDisabled();
  await page.getByTestId("shift-staff-name-1").fill("スタッフ2");
  await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toBeEnabled();
});

test("shift-schedule: 夜勤（日をまたぐ）を足すと、実働が計算され、勤務区分を削除するとそのマスは空になる", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("shift-add-type").click();
  await page.getByTestId("shift-type-code-5").fill("夜");
  await page.getByTestId("shift-type-name-5").fill("夜勤");
  await page.getByTestId("shift-type-start-5").fill("22:00");
  await page.getByTestId("shift-type-end-5").fill("06:00");
  await page.getByTestId("shift-type-break-5").fill("60");
  await expect(page.getByTestId("shift-type-errors")).toHaveCount(0);
  await page.getByTestId("shift-brush-夜").click();
  await cell(page, 0, 1).click();
  await cell(page, 0, 2).click();
  await expect(page.getByTestId("shift-sum-time-0")).toHaveText("14:00");
  // 夜勤→翌日の日勤 は、休息が足りない
  await page.getByTestId("shift-brush-日").click();
  await cell(page, 1, 1).click();
  await page.getByTestId("shift-brush-夜").click();
  await cell(page, 1, 2).click();
  await page.getByTestId("shift-brush-日").click();
  await cell(page, 1, 3).click();
  await expect(page.getByTestId("shift-issues")).toContainText("スタッフ2：10月2日(金)の「夜勤」の終了から、翌日の「日勤」の開始まで");

  await page.getByRole("button", { name: "夜勤を削除" }).click();
  await expect(cell(page, 0, 1)).toHaveAttribute("data-code", "");
  await expect(page.getByTestId("shift-sum-time-0")).toHaveText("0:00");
});

test("shift-schedule: スタッフをまとめて追加・並べ替え・削除でき、上限を超えた分は追加しない", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("shift-staff-bulk").fill("山田、佐藤\n鈴木");
  await page.getByTestId("shift-staff-bulk-add").click();
  await expect(page.getByTestId("shift-row-6")).toBeVisible();
  await expect(page.getByTestId("shift-staff-name-4")).toHaveValue("山田");
  await page.getByRole("button", { name: "鈴木を上へ" }).click();
  await expect(page.getByTestId("shift-staff-name-5")).toHaveValue("鈴木");
  await expect(page.getByTestId("shift-staff-name-6")).toHaveValue("佐藤");
  await page.getByRole("button", { name: "鈴木を削除" }).click();
  await expect(page.getByTestId("shift-row-5")).toBeVisible();
  await expect(page.getByTestId("shift-row-6")).toHaveCount(0);

  const many = Array.from({ length: 70 }, (_, i) => `職員${i + 1}`).join("\n");
  await page.getByTestId("shift-staff-bulk").fill(many);
  await page.getByTestId("shift-staff-bulk-add").click();
  await expect(page.getByTestId("shift-row-59")).toBeVisible();
  await expect(page.getByTestId("shift-row-60")).toHaveCount(0);
  await expect(page.getByTestId("shift-message")).toContainText("60人まで");
});

test("shift-schedule: 月を変えると、日数が変わる（2月は28日・うるう年は29日）。入れた勤務は残る", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("shift-brush-日").click();
  await cell(page, 0, 2).click();
  await page.getByTestId("shift-month").selectOption("2");
  await expect(cell(page, 0, 28)).toBeVisible();
  await expect(cell(page, 0, 29)).toHaveCount(0);
  await expect(cell(page, 0, 2)).toHaveAttribute("data-code", "日");
  await page.getByTestId("shift-year").fill("2028");
  await expect(cell(page, 0, 29)).toBeVisible();
  await expect(cell(page, 0, 30)).toHaveCount(0);
  // 範囲外の年は、表を出さずに知らせる
  await page.getByTestId("shift-year").fill("1999");
  await expect(page.getByRole("alert").filter({ hasText: "年は2000〜2099" }).first()).toBeVisible();
  await expect(page.getByTestId("shift-grid")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "CSVでダウンロード" })).toBeDisabled();
});

test("shift-schedule: PDF・Excel・CSVで保存でき、内容は画面の表と一致する。名前は外部に送信されない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  const NAME = "架空の職員ゲンカイ";
  await page.getByTestId("shift-staff-name-0").fill(NAME);
  await page.getByTestId("shift-title").fill("10月 店舗シフト");
  await page.getByTestId("shift-brush-早").click();
  for (const d of [1, 2, 3]) await cell(page, 0, d).click();
  await page.getByTestId("shift-brush-休").click();
  await cell(page, 0, 4).click();
  await page.getByTestId("shift-brush-遅").click();
  await cell(page, 1, 1).click();

  // PDF
  const pdfDownload = await clickAndDownload(page, "PDFでダウンロード");
  expect(pdfDownload.suggestedFilename()).toBe("10月 店舗シフト.pdf");
  const { path: pdfPath } = await assertDownloadedFile(pdfDownload, { format: "pdf", minBytes: 1000 });
  expect(isValidPdfFile(pdfPath)).toBe(true);
  const pdf = await extractPdfContent(pdfPath);
  expect(pdf.pageCount).toBe(1);
  expect(pdf.pages[0].width).toBeCloseTo(841.89, 0); // A4横
  const pdfText = pdf.text.replace(/\s+/g, "");
  expect(pdfText).toContain("10月店舗シフト");
  expect(pdfText).toContain(NAME);
  expect(pdfText).toContain("出勤人数");
  expect(pdfText).toContain("早番");

  // Excel
  const xlsxDownload = await clickAndDownload(page, "Excelでダウンロード");
  expect(xlsxDownload.suggestedFilename()).toBe("10月 店舗シフト.xlsx");
  const { path: xlsxPath } = await assertDownloadedFile(xlsxDownload, { format: "zip", minBytes: 500 });
  const sheet = await readXlsxSheet(xlsxPath);
  expect(sheet.headers[0]).toBe("10月 店舗シフト");
  const body = sheet.rows.filter((r) => r.some((v) => v !== null && v !== ""));
  const header = body[0].map(String);
  expect(header[0]).toBe("氏名");
  expect(header[1]).toContain("1");
  expect(header.slice(-4)).toEqual(["出勤日数", "休日数", "未入力", "実働時間"]);
  const row = body.find((r) => r[0] === NAME)!;
  expect(row.slice(1, 5)).toEqual(["早", "早", "早", "休"]);
  expect(row.slice(-4)).toEqual([3, 1, 27, "24:00"]);
  const footer = body[body.length - 1];
  expect(footer[0]).toBe("出勤人数");
  expect(footer[1]).toBe(2);
  expect(footer[4]).toBe(0);

  // CSV
  const csvDownload = await clickAndDownload(page, "CSVでダウンロード");
  expect(csvDownload.suggestedFilename()).toBe("10月 店舗シフト.csv");
  const { path: csvPath } = await assertDownloadedFile(csvDownload, { minBytes: 20 });
  const lines = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  expect(lines[0].split(",").slice(0, 3)).toEqual(["氏名", "1日(木)", "2日(金)"]);
  const csvRow = lines.find((l) => l.startsWith(NAME))!.split(",");
  expect(csvRow.slice(1, 5)).toEqual(["早", "早", "早", "休"]);
  expect(csvRow.slice(-4)).toEqual(["3", "1", "27", "24:00"]);

  // 通信: 名前が自社API・外部へ送られていない
  const origin = new URL(baseURL!).origin;
  expect(findLeakedRequests(recorder, NAME)).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
});

test("shift-schedule: 31日の月でも、人数が多いときは、PDFがページに分かれる", async ({ page }) => {
  await openTool(page);
  const names = Array.from({ length: 36 }, (_, i) => `職員${i + 1}`).join("\n");
  await page.getByTestId("shift-staff-bulk").fill(names);
  await page.getByTestId("shift-staff-bulk-add").click();
  await expect(page.getByTestId("shift-row-39")).toBeVisible(); // 4 + 36 = 40人
  const download = await clickAndDownload(page, "PDFでダウンロード");
  const { path: pdfPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1000 });
  const pdf = await extractPdfContent(pdfPath);
  expect(pdf.pageCount).toBe(2);
  const text = pdf.text.replace(/\s+/g, "");
  expect(text).toContain("職員36");
  expect(text).toContain("1/2");
});

test("shift-schedule: 保存ファイル（JSON）を作って読み込むと、同じ表に戻る。別の形式のファイルは理由を示して読まない", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("shift-title").fill("保存テスト");
  await page.getByTestId("shift-staff-name-0").fill("保存職員");
  await page.getByTestId("shift-brush-日").click();
  await cell(page, 0, 7).click();
  const saved = page.waitForEvent("download");
  await page.getByTestId("shift-save-json").click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe("保存テスト（保存用）.json");
  // ダウンロードされたファイルの実体は拡張子のない名前なので、.json の名前でコピーしてから選ぶ
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), "shift-"));
  const jsonPath = path.join(dir0, "保存テスト.json");
  fs.copyFileSync((await download.path())!, jsonPath);
  const text = fs.readFileSync(jsonPath, "utf8");
  expect(JSON.parse(text).app).toBe("mr-satto-shift");

  // 画面を作り直して読み込む
  await openTool(page);
  await expect(page.getByTestId("shift-title")).toHaveValue("");
  await page.locator('input[type="file"]').first().setInputFiles(jsonPath);
  await expect(page.getByTestId("shift-message")).toContainText("読み込みました");
  await expect(page.getByTestId("shift-title")).toHaveValue("保存テスト");
  await expect(page.getByTestId("shift-staff-name-0")).toHaveValue("保存職員");
  await expect(cell(page, 0, 7)).toHaveAttribute("data-code", "日");

  // 別の形式
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shift-"));
  const other = path.join(dir, "other.json");
  fs.writeFileSync(other, JSON.stringify({ hello: "world" }));
  await page.locator('input[type="file"]').first().setInputFiles(other);
  await expect(page.getByTestId("shift-load-error")).toContainText("このツールで保存したファイルではありません");
  await expect(page.getByTestId("shift-staff-name-0")).toHaveValue("保存職員"); // 表は変わらない
});
