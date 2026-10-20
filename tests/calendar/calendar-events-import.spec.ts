import { test, expect } from "@playwright/test";
import {
  MAX_IMPORT_ROWS,
  detectLayout,
  parseDateCell,
  parseEventRows,
  parseTimeCell,
  pickEventSheet,
  summarizeImport,
  type EventCellValue,
} from "@/lib/calendar/event-import";
import {
  calendarDateRange,
  eventsCellText,
  fitEventLines,
  formatEventLine,
  groupEventsByDate,
  hiddenCountLabel,
  placeEvents,
  sanitizeEventText,
  type CalendarEvent,
} from "@/lib/calendar/events";
import { effectiveOrientation, groupButtonLabel, groupMonths, sheetNameOf } from "@/lib/calendar/layout";
import { buildFiscalCalendar } from "@/lib/calendar/model";

/**
 * Excel予定表の読み込み・予定の共通モデル・1か月/2か月の組み合わせの単体テスト。
 * 期待値はこのファイルに直接書き、実装の関数から作らない。
 */

const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min));
const importRows = (rows: EventCellValue[][]) => {
  const layout = detectLayout(rows);
  if (!layout) throw new Error("列を推定できませんでした");
  return { layout, result: parseEventRows(rows, layout.mapping, layout.headerRow) };
};

test.describe("予定表の列名の推定", () => {
  const HEADERS: [string, EventCellValue[]][] = [
    ["日付/予定/開始時刻/終了時刻", ["日付", "予定", "開始時刻", "終了時刻"]],
    ["日/内容/開始/終了", ["日", "内容", "開始", "終了"]],
    ["件名/イベント の別名", ["日付", "件名", "開始", "終了"]],
    ["イベント", ["日付", "イベント", "開始", "終了"]],
    ["タイトル", ["日付", "タイトル", "開始", "終了"]],
    ["英語 date/title/start/end", ["date", "title", "start", "end"]],
    ["英語 Date/Event/Start Time/End Time", ["Date", "event", "Start Time", "End Time"]],
    ["英語 subject", ["Date", "Subject", "start time", "end time"]],
    ["全角・空白・括弧の表記ゆれ", [" 日　付 ", "予定（内容）", "開始時刻（時:分）", "ＥＮＤ"]],
  ];
  for (const [name, header] of HEADERS) {
    test(`見出し行から4つの列を割り当てる: ${name}`, () => {
      const rows: EventCellValue[][] = [header, [utc(2026, 4, 1), "朝礼", "09:00", "09:15"]];
      const layout = detectLayout(rows);
      expect(layout, "列を推定できる").not.toBeNull();
      expect(layout!.fromHeader).toBe(true);
      expect(layout!.headerRow).toBe(0);
      expect(layout!.mapping).toEqual({ date: 0, title: 1, start: 2, end: 3 });
    });
  }

  test("列の順序が違っても、見出しの文字で割り当てる", () => {
    const layout = detectLayout([["終了", "開始", "予定", "日付"], ["10:00", "09:00", "会議", utc(2026, 4, 1)]]);
    expect(layout!.mapping).toEqual({ date: 3, title: 2, start: 1, end: 0 });
  });

  test("時刻の列がなくても読める（開始・終了は null）", () => {
    const layout = detectLayout([["日付", "予定"], [utc(2026, 4, 1), "休み"]]);
    expect(layout!.mapping).toEqual({ date: 0, title: 1, start: null, end: null });
  });

  test("見出し行の前に題名の行があっても、見出し行を見つける", () => {
    const rows: EventCellValue[][] = [["2026年度 予定表"], [null], ["日付", "予定"], [utc(2026, 4, 1), "入社式"]];
    const { layout, result } = importRows(rows);
    expect(layout.headerRow).toBe(2);
    expect(result.events.map((e) => e.sourceRow)).toEqual([4]);
  });

  test("見出しがなくても、1列目が日付なら 日付/予定/開始/終了 として読む", () => {
    const rows: EventCellValue[][] = [
      [utc(2026, 4, 1), "入社式", "10:00", "11:00"],
      [utc(2026, 4, 2), "研修", null, null],
      [utc(2026, 4, 3), "研修", null, null],
    ];
    const layout = detectLayout(rows);
    expect(layout).not.toBeNull();
    expect(layout!.fromHeader).toBe(false);
    expect(layout!.headerRow).toBe(-1);
    expect(parseEventRows(rows, layout!.mapping, layout!.headerRow).events).toHaveLength(3);
  });

  test("予定表ではないシート（日付も予定も見つからない）は推定できない → 画面で列を選ぶ", () => {
    expect(detectLayout([["商品", "数量"], ["りんご", 3], ["みかん", 5]])).toBeNull();
    expect(detectLayout([])).toBeNull();
  });

  test("複数シートでは、予定表として読めるシートを選ぶ", () => {
    const sheets = [
      { name: "メモ", rows: [["あ", "い"]] as EventCellValue[][] },
      { name: "予定", rows: [["日付", "予定"], [utc(2026, 4, 1), "a"]] as EventCellValue[][] },
    ];
    expect(pickEventSheet(sheets)).toBe(1);
  });
});

test.describe("日付・時刻のセルの読み取り", () => {
  test("日付のセル（Date）は、タイムゾーンに左右されず同じ日になる", () => {
    expect(parseDateCell(utc(2026, 4, 1))).toEqual({ iso: "2026-04-01", time: null });
    expect(parseDateCell(utc(2027, 3, 31, 23, 59))).toEqual({ iso: "2027-03-31", time: "23:59" });
  });

  const TEXT_DATES: [string, string][] = [
    ["2026/4/1", "2026-04-01"],
    ["2026/04/01", "2026-04-01"],
    ["2026-4-1", "2026-04-01"],
    ["2026.4.1", "2026-04-01"],
    ["2026年4月1日", "2026-04-01"],
    ["２０２６年４月１日", "2026-04-01"],
    ["2026/4/1(水)", "2026-04-01"],
    ["2026年4月1日（水）", "2026-04-01"],
    ["20260401", "2026-04-01"],
    ["令和8年4月1日", "2026-04-01"],
    ["R8.4.1", "2026-04-01"],
    ["平成31年4月30日", "2019-04-30"],
    ["昭和64年1月7日", "1989-01-07"],
    ["2026/4/1 10:30", "2026-04-01"],
  ];
  for (const [input, iso] of TEXT_DATES) {
    test(`日付の文字を読む: ${input}`, () => {
      const r = parseDateCell(input);
      expect("iso" in r && r.iso).toBe(iso);
    });
  }

  test("Excelのシリアル値（数値）と8桁の数値を日付として読む", () => {
    // 2026-04-01 のシリアル値 = 46113
    expect(parseDateCell(46113)).toEqual({ iso: "2026-04-01", time: null });
    expect(parseDateCell(20260401)).toEqual({ iso: "2026-04-01", time: null });
  });

  test("日付として読めないものはエラー（年のない「4/1」、存在しない日、文字、時刻だけのセル）", () => {
    for (const bad of ["4/1", "2026/2/30", "2026/13/1", "来週", "未定", "2026/4/", true, utc(1899, 12, 30, 10, 0)] as EventCellValue[]) {
      expect("error" in parseDateCell(bad), `${String(bad)} は日付として読めない`).toBe(true);
    }
    expect(parseDateCell(null)).toEqual({ empty: true });
    expect(parseDateCell("")).toEqual({ empty: true });
  });

  test("時刻の読み取り: 文字・Excelの時刻（小数・時刻のDate）・日本語表記", () => {
    expect(parseTimeCell("9:30")).toEqual({ time: "09:30" });
    expect(parseTimeCell("10:00")).toEqual({ time: "10:00" });
    expect(parseTimeCell("10:00:00")).toEqual({ time: "10:00" });
    expect(parseTimeCell("１０：００")).toEqual({ time: "10:00" });
    expect(parseTimeCell("10時")).toEqual({ time: "10:00" });
    expect(parseTimeCell("10時30分")).toEqual({ time: "10:30" });
    expect(parseTimeCell("10時半")).toEqual({ time: "10:30" });
    expect(parseTimeCell(10 / 24)).toEqual({ time: "10:00" });
    expect(parseTimeCell(0.5)).toEqual({ time: "12:00" });
    expect(parseTimeCell(new Date(Date.UTC(1899, 11, 30, 13, 45)))).toEqual({ time: "13:45" });
    expect(parseTimeCell(null)).toEqual({ time: null });
    expect(parseTimeCell("")).toEqual({ time: null });
  });

  test("時刻として読めないものはエラー（24:00以上、60分以上、文字）", () => {
    for (const bad of ["24:00", "25:10", "10:60", "午前", "あとで", 1.5, true] as EventCellValue[]) {
      expect("error" in parseTimeCell(bad), `${String(bad)} は時刻として読めない`).toBe(true);
    }
  });
});

test.describe("予定の行の読み込み", () => {
  const header: EventCellValue[] = ["日付", "予定", "開始時刻", "終了時刻"];

  test("正常な行: 日付・予定名・開始・終了を読み、Excelの行番号を覚える", () => {
    const { result } = importRows([header, [utc(2026, 4, 10), "営業会議", "10:00", "11:30"], [utc(2026, 4, 11), "出張", null, null]]);
    expect(result.events).toEqual([
      { date: "2026-04-10", title: "営業会議", startTime: "10:00", endTime: "11:30", sourceRow: 2 },
      { date: "2026-04-11", title: "出張", startTime: null, endTime: null, sourceRow: 3 },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.dataRowCount).toBe(2);
  });

  test("同じ日に複数の予定があっても、1件も落とさない", () => {
    const rows: EventCellValue[][] = [header];
    for (let i = 0; i < 7; i++) rows.push([utc(2026, 5, 7), `予定${i}`, `${9 + i}:00`, null]);
    const { result } = importRows(rows);
    expect(result.events).toHaveLength(7);
    expect(groupEventsByDate(result.events).get("2026-05-07")).toHaveLength(7);
  });

  test("問題のある行だけを別にして、残りは読み込む（ファイル全体を失敗にしない）", () => {
    const { result } = importRows([
      header,
      [utc(2026, 4, 1), "OK1", null, null],
      ["来週", "日付が読めない", null, null],
      [utc(2026, 4, 3), "", null, null],
      [utc(2026, 4, 4), "   ", null, null],
      [null, "日付が空", null, null],
      [utc(2026, 4, 6), "時刻が変", "あとで", "25:00"],
      [utc(2026, 4, 7), "OK2", "9:00", null],
    ]);
    expect(result.events.map((e) => e.title)).toEqual(["OK1", "時刻が変", "OK2"]);
    const byKind = (k: string) => result.issues.filter((i) => i.kind === k).map((i) => i.row);
    expect(byKind("bad-date")).toEqual([3, 6]);
    expect(byKind("empty-title")).toEqual([4, 5]);
    expect(byKind("bad-time")).toEqual([7]);
    // 時刻が読めない行は予定を残し、時刻なしで配置する
    const bad = result.events.find((e) => e.title === "時刻が変")!;
    expect([bad.startTime, bad.endTime]).toEqual([null, null]);
    const s = summarizeImport(result, 2);
    expect(s).toMatchObject({ totalRows: 7, recognized: 3, inYear: 2, outOfYear: 1, badDateRows: 2, emptyTitleRows: 2, badTimeRows: 1 });
  });

  test("空行は数えない・飛ばす", () => {
    const { result } = importRows([header, [utc(2026, 4, 1), "a", null, null], [null, null, null, null], [], [utc(2026, 4, 2), "b", null, null]]);
    expect(result.dataRowCount).toBe(2);
    expect(result.events.map((e) => e.sourceRow)).toEqual([2, 5]);
  });

  test("開始の列に「10:00-11:00」「10:00〜11:00」と書かれていても、開始と終了に分ける", () => {
    const { result } = importRows([header, [utc(2026, 4, 1), "a", "10:00-11:00", null], [utc(2026, 4, 2), "b", "9:30〜10:15", null]]);
    expect(result.events.map((e) => [e.startTime, e.endTime])).toEqual([
      ["10:00", "11:00"],
      ["09:30", "10:15"],
    ]);
  });

  test("日時のセル（日付＋時刻）なら、開始時刻にも使う", () => {
    const { result } = importRows([header, [utc(2026, 4, 1, 14, 0), "a", null, null]]);
    expect(result.events[0]).toMatchObject({ date: "2026-04-01", startTime: "14:00" });
  });

  test("数値の予定名（会議室の番号など）も文字として読む", () => {
    const { result } = importRows([header, [utc(2026, 4, 1), 123, null, null]]);
    expect(result.events[0].title).toBe("123");
  });

  test("安全な文字: 制御文字は取り除き、<>&\"' や =SUM() は文字のまま残す", () => {
    expect(sanitizeEventText("a\u0000b\u0008c\u000Bd￾e")).toBe("abcde");
    expect(sanitizeEventText("\ud800x")).toBe("x");
    expect(sanitizeEventText("a\r\nb\rc")).toBe("a\nb\nc");
    const title = `<b>&"'=SUM(A1)</b>`;
    expect(sanitizeEventText(title)).toBe(title);
    const { result } = importRows([header, [utc(2026, 4, 1), `x\u0001${title}`, null, null]]);
    expect(result.events[0].title).toBe(`x${title}`);
  });

  test(`行数の上限（${MAX_IMPORT_ROWS}行）を超えたら、画面が固まる前に止める`, () => {
    const rows: EventCellValue[][] = [header];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i++) rows.push([utc(2026, 4, 1), "x", null, null]);
    expect(() => parseEventRows(rows, { date: 0, title: 1, start: 2, end: 3 }, 0)).toThrow(/多すぎ/);
    rows.pop();
    expect(parseEventRows(rows, { date: 0, title: 1, start: 2, end: 3 }, 0).events).toHaveLength(MAX_IMPORT_ROWS);
  });

  test("列を手で選んだときの割り当て（日付と予定だけ）で読める", () => {
    const rows: EventCellValue[][] = [["x", "y"], ["商談", utc(2026, 6, 1)]];
    const r = parseEventRows(rows, { date: 1, title: 0, start: null, end: null }, 0);
    expect(r.events).toEqual([{ date: "2026-06-01", title: "商談", startTime: null, endTime: null, sourceRow: 2 }]);
  });
});

test.describe("予定の共通モデル（並び・年度の範囲・表示文字）", () => {
  const ev = (date: string, title: string, startTime: string | null, endTime: string | null, sourceRow: number): CalendarEvent => ({
    date,
    title,
    startTime,
    endTime,
    sourceRow,
  });

  test("1日の中の並び: 時刻なしが先、そのあとは開始時刻順、同じなら行の順", () => {
    const map = groupEventsByDate([
      ev("2026-04-01", "c", "13:00", null, 2),
      ev("2026-04-01", "終日", null, null, 3),
      ev("2026-04-01", "a", "09:00", null, 4),
      ev("2026-04-01", "b", "09:00", null, 5),
    ]);
    expect(map.get("2026-04-01")!.map((e) => e.title)).toEqual(["終日", "a", "b", "c"]);
  });

  test("表示用の文字: 時刻つき・開始のみ・終了のみ・時刻なし", () => {
    expect(formatEventLine({ title: "会議", startTime: "10:00", endTime: "11:00" })).toBe("10:00-11:00 会議");
    expect(formatEventLine({ title: "会議", startTime: "10:00", endTime: null })).toBe("10:00 会議");
    expect(formatEventLine({ title: "会議", startTime: null, endTime: "11:00" })).toBe("〜11:00 会議");
    expect(formatEventLine({ title: "会議", startTime: null, endTime: null })).toBe("会議");
    expect(eventsCellText([ev("2026-04-01", "a", "09:00", null, 2), ev("2026-04-01", "b", null, null, 3)])).toBe("09:00 a\nb");
  });

  test("年度の範囲は 4月1日〜翌年3月31日（うるう年の2月も含む）", () => {
    expect(calendarDateRange(buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" }))).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(calendarDateRange(buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }))).toEqual({ start: "2027-04-01", end: "2028-03-31" });
  });

  test("年度の境界: 3/31と4/1、1〜3月は翌年の暦年。範囲外は別の年度へ動かさない", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });
    const events = [
      ev("2026-03-31", "前年度の最終日", null, null, 2),
      ev("2026-04-01", "年度初日", null, null, 3),
      ev("2027-01-15", "1月（翌年）", null, null, 4),
      ev("2027-03-31", "年度末日", null, null, 5),
      ev("2027-04-01", "翌年度の初日", null, null, 6),
      ev("2026-01-15", "前の暦年の1月", null, null, 7),
    ];
    const placed = placeEvents(cal, events);
    expect(placed.inRange.map((e) => e.title)).toEqual(["年度初日", "1月（翌年）", "年度末日"]);
    expect(placed.outOfRange.map((e) => e.title)).toEqual(["前年度の最終日", "翌年度の初日", "前の暦年の1月"]);
    expect([...placed.byDate.keys()].sort()).toEqual(["2026-04-01", "2027-01-15", "2027-03-31"]);
    // 年度を2027に変えると、翌年度の初日だけが載る
    const placed2027 = placeEvents(buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }), events);
    expect(placed2027.inRange.map((e) => e.title)).toEqual(["翌年度の初日"]);
    // 件数は失われない
    expect(placed.inRange.length + placed.outOfRange.length).toBe(events.length);
  });

  test("「他N件」: 行数に収まれば全件、収まらなければ最後の1行を「他N件」にする", () => {
    const list = Array.from({ length: 5 }, (_, i) => ev("2026-04-01", `e${i}`, null, null, i + 2));
    expect(fitEventLines(list, 5)).toEqual({ shown: list, hiddenCount: 0 });
    expect(fitEventLines(list, 3)).toEqual({ shown: list.slice(0, 2), hiddenCount: 3 });
    expect(fitEventLines(list, 1)).toEqual({ shown: [], hiddenCount: 5 });
    expect(fitEventLines(list, 0)).toEqual({ shown: [], hiddenCount: 5 });
    expect(hiddenCountLabel(3, 2)).toBe("他3件");
    expect(hiddenCountLabel(5, 0)).toBe("予定5件");
  });
});

test.describe("1か月/2か月の組み合わせ", () => {
  const cal = buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" });

  test("1か月: 12グループ、2か月: 6グループ（4+5, 6+7, 8+9, 10+11, 12+1, 2+3）", () => {
    expect(groupMonths(cal, 1)).toHaveLength(12);
    const pairs = groupMonths(cal, 2);
    expect(pairs.map((g) => g.map((m) => `${m.year}-${m.month}`))).toEqual([
      ["2026-4", "2026-5"],
      ["2026-6", "2026-7"],
      ["2026-8", "2026-9"],
      ["2026-10", "2026-11"],
      ["2026-12", "2027-1"],
      ["2027-2", "2027-3"],
    ]);
    expect(pairs.map(sheetNameOf)).toEqual(["4月・5月", "6月・7月", "8月・9月", "10月・11月", "12月・1月", "2月・3月"]);
    expect(pairs.map(groupButtonLabel)).toEqual(["4・5月", "6・7月", "8・9月", "10・11月", "12・1月", "2・3月"]);
    expect(groupMonths(cal, 1).map(sheetNameOf)[0]).toBe("4月");
  });

  test("2か月は横向きに固定、1か月は指定どおり", () => {
    expect(effectiveOrientation("portrait", 2)).toBe("landscape");
    expect(effectiveOrientation("landscape", 2)).toBe("landscape");
    expect(effectiveOrientation("portrait", 1)).toBe("portrait");
  });
});
