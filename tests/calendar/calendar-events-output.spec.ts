import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { extractTextBoxes, readFontBytes } from "../helpers/pdf-text-boxes";
import { addressOf, excelSerialToIso, readXlsxWorkbook, type XlsxSheetInfo } from "../helpers/xlsx-workbook";
import { validateXlsxStrict } from "../helpers/xlsx-strict";
import { excelFingerprint } from "../helpers/calendar-golden";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { placeEvents, type CalendarEvent } from "@/lib/calendar/events";
import { detectLayout, parseEventRows, type EventCellValue } from "@/lib/calendar/event-import";
import { CALENDAR_THEME_IDS, CALENDAR_THEMES, resolveCalendarTheme, type CalendarThemeChoice } from "@/lib/calendar/themes";
import { FiscalCalendarProcessor, buildFiscalCalendarFileName } from "@/lib/processors/browser/fiscal-calendar";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { readXlsxFileAsSheets } from "./events-fixture";

/**
 * 予定つきカレンダー・2か月表示のExcel/PDF出力のテスト。
 *  - Excel本体のXMLの厳密な検査（tests/helpers/xlsx-strict.ts）を、デザイン×向き×1/2か月×前後の日付×予定の全組み合わせにかける
 *  - 2か月: 6シート・6ページ、シート名、左右の月の組み合わせ、予定が欠けずに出ること
 *  - 往復: 予定表Excel → 読み込み → カレンダーExcel → 読み直し → 同じ予定で再作成して同一になること
 */

const FY = 2026;
const calendarOf = (ws: WeekStart = "mon", fy = FY) => buildFiscalCalendar({ fiscalYear: fy, weekStart: ws });

const EVENTS: CalendarEvent[] = [
  { date: "2026-04-01", title: "入社式", startTime: "10:00", endTime: "11:30", sourceRow: 2 },
  { date: "2026-04-01", title: "歓迎会", startTime: "18:30", endTime: null, sourceRow: 3 },
  { date: "2026-04-01", title: "終日の研修", startTime: null, endTime: null, sourceRow: 4 },
  { date: "2026-05-04", title: "みどりの日 当番", startTime: null, endTime: null, sourceRow: 5 },
  { date: "2026-07-20", title: "海の日 点検", startTime: "09:00", endTime: "10:00", sourceRow: 6 },
  { date: "2026-12-28", title: "仕事納め", startTime: "17:00", endTime: null, sourceRow: 7 },
  { date: "2027-01-04", title: "仕事始め", startTime: "09:00", endTime: null, sourceRow: 8 },
  { date: "2027-03-31", title: "年度末の締め <&\"'> =SUM(A1)", startTime: null, endTime: null, sourceRow: 9 },
  // 年度の外（載らない）
  { date: "2026-03-31", title: "前年度", startTime: null, endTime: null, sourceRow: 10 },
  { date: "2027-04-01", title: "翌年度", startTime: null, endTime: null, sourceRow: 11 },
];

async function excelOf(opts: {
  ws?: WeekStart;
  theme?: CalendarThemeChoice;
  orientation?: "landscape" | "portrait";
  adj?: boolean;
  mps?: 1 | 2;
  events?: CalendarEvent[];
}) {
  const cal = calendarOf(opts.ws ?? "mon");
  const blob = await buildCalendarExcel({
    calendar: cal,
    theme: resolveCalendarTheme(opts.theme ?? "business", { main: "#2E7D32", accent: "#C62828", background: "#FFFDE7", ink: "#263238" }),
    orientation: opts.orientation ?? "landscape",
    showAdjacentDays: opts.adj ?? false,
    monthsPerSheet: opts.mps ?? 1,
    events: opts.events ? placeEvents(cal, opts.events).byDate : undefined,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** シートの中で、ある日付の日付セルの1つ下（予定欄）の文字を返す。日付セルがなければ undefined */
function memoOf(sheet: XlsxSheetInfo, iso: string, nth = 0): string | null | undefined {
  const hits = [...sheet.cells.values()].filter((c) => typeof c.value === "number" && c.value > 40000 && excelSerialToIso(c.value) === iso);
  const cell = hits[nth];
  if (!cell) return undefined;
  const below = sheet.cells.get(addressOf(cell.row + 1, cell.col));
  return typeof below?.value === "string" ? below.value : null;
}

test.describe("Excelの厳密な構造検査（Excelの「修復しますか」を防ぐ）", () => {
  test("全組み合わせ（デザイン6種 × 向き × 1/2か月 × 前後の日付 × 予定）でXMLの問題が0件", async () => {
    const choices: CalendarThemeChoice[] = [...CALENDAR_THEME_IDS, "custom"];
    let checked = 0;
    for (const theme of choices)
      for (const orientation of ["landscape", "portrait"] as const)
        for (const mps of [1, 2] as const)
          for (const adj of [false, true])
            for (const withEvents of [false, true]) {
              const bytes = await excelOf({ theme, orientation, mps, adj, events: withEvents ? EVENTS : undefined, ws: adj ? "sun" : "mon" });
              const report = validateXlsxStrict(bytes);
              expect(report.problems, `${theme}/${orientation}/${mps}か月/前後=${adj}/予定=${withEvents}`).toEqual([]);
              expect(report.sheetCount).toBe(mps === 2 ? 6 : 12);
              expect(report.partCount).toBeGreaterThan(5);
              checked++;
            }
    expect(checked).toBe(choices.length * 2 * 2 * 2 * 2);
  });

  test("検査そのものが働く: 重複セル・存在しないスタイル番号・重なる結合セルを含むファイルは検出する", async () => {
    const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate");
    const files = unzipSync(await excelOf({}));
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]);
    const broken = (xml: string) => {
      const copy = { ...files, "xl/worksheets/sheet1.xml": strToU8(xml) };
      return validateXlsxStrict(zipSync(copy)).problems;
    };
    // 同じセルを2回書く（Excelが修復を求める典型）
    const dup = sheet.replace(/<c r="A1"([^>]*)>/, '<c r="A1"$1></c><c r="A1"$1>');
    expect(broken(dup).length).toBeGreaterThan(0);
    // 存在しないスタイル番号
    expect(broken(sheet.replace(/<c r="A1" s="\d+"/, '<c r="A1" s="9999"')).length).toBeGreaterThan(0);
    // 重なる結合セル
    expect(broken(sheet.replace("</mergeCells>", '<mergeCell ref="A1:C1"/><mergeCell ref="B1:D1"/></mergeCells>')).length).toBeGreaterThan(0);
  });
});

test.describe("2か月表示のExcel", () => {
  test("6シート・シート名・左が前の月/右が次の月・A4横・印刷範囲", async () => {
    const wb = readXlsxWorkbook(await excelOf({ mps: 2, orientation: "landscape" }));
    expect(wb.sheets.map((s) => s.name)).toEqual(["4月・5月", "6月・7月", "8月・9月", "10月・11月", "12月・1月", "2月・3月"]);
    for (const s of wb.sheets) {
      expect(s.pageSetup.orientation).toBe("landscape");
      expect(s.pageSetup.paperSize).toBe("9");
      expect(s.fitToPage).toBe(true);
    }
    const area = wb.definedNames.filter((d) => d.name === "_xlnm.Print_Area");
    expect(area).toHaveLength(6);
    for (const a of area) expect(a.ref).toMatch(/^'[^']+'!\$A\$1:\$AC\$\d+$/);
    // 左の月の日付は左の14列（A〜N）、右の月は右の14列（P〜AC）。間の1列（O）は空き
    const first = wb.sheets[0];
    const dateCols = (iso: string) => [...first.cells.values()].filter((c) => typeof c.value === "number" && c.value > 40000 && excelSerialToIso(c.value) === iso).map((c) => c.col);
    for (const c of dateCols("2026-04-15")) expect(c).toBeLessThan(14);
    for (const c of dateCols("2026-05-15")) expect(c).toBeGreaterThanOrEqual(15);
    expect([...first.cells.values()].filter((c) => c.col === 14 && c.value !== null)).toEqual([]);
    // 12月・1月は年をまたぐ組み合わせ
    const dec = wb.sheets[4];
    expect([...dec.cells.values()].some((c) => typeof c.value === "number" && excelSerialToIso(c.value) === "2026-12-31")).toBe(true);
    expect([...dec.cells.values()].some((c) => typeof c.value === "number" && excelSerialToIso(c.value) === "2027-01-01")).toBe(true);
  });

  test("日付・曜日の並び・祝日名は、1か月の出力と同じ（同じ日の日付セルと祝日名が、2か月の側にもある）", async () => {
    const one = readXlsxWorkbook(await excelOf({ mps: 1 }));
    const two = readXlsxWorkbook(await excelOf({ mps: 2 }));
    const holidayTexts = (sheets: XlsxSheetInfo[]) =>
      sheets
        .flatMap((s) => [...s.cells.values()])
        .filter((c) => typeof c.value === "string" && /(の日|節分|元日|振替休日|休日|天皇誕生日|成人の日|建国記念の日|春分|秋分|憲法記念日|文化の日|勤労感謝|スポーツの日|昭和の日|こどもの日|みどりの日|山の日|敬老の日|海の日)/.test(c.value as string))
        .map((c) => c.value as string)
        .sort();
    expect(holidayTexts(two.sheets)).toEqual(holidayTexts(one.sheets));
    const dates = (sheets: XlsxSheetInfo[]) =>
      sheets
        .flatMap((s) => [...s.cells.values()])
        .filter((c) => typeof c.value === "number" && c.value > 40000)
        .map((c) => excelSerialToIso(c.value as number))
        .sort();
    expect(dates(two.sheets)).toEqual(dates(one.sheets));
  });

  test("曜日見出し（月曜始まり/日曜始まり）が左右とも正しい", async () => {
    for (const [ws, first] of [["mon", "月"], ["sun", "日"]] as const) {
      const wb = readXlsxWorkbook(await excelOf({ mps: 2, ws }));
      const s = wb.sheets[0];
      const heads = [...s.cells.values()].filter((c) => typeof c.value === "string" && /^[日月火水木金土]/.test(c.value as string) && (c.value as string).length <= 3);
      const left = heads.filter((c) => c.col < 14).sort((a, b) => a.col - b.col)[0];
      const right = heads.filter((c) => c.col >= 15).sort((a, b) => a.col - b.col)[0];
      expect((left.value as string)[0], `${ws} 左`).toBe(first);
      expect((right.value as string)[0], `${ws} 右`).toBe(first);
    }
  });
});

test.describe("予定の出力（Excel）", () => {
  for (const mps of [1, 2] as const) {
    test(`${mps}か月: 予定が正しい日の予定欄に、全件・時刻順で入る（年度の外は入らない）`, async () => {
      const wb = readXlsxWorkbook(await excelOf({ mps, events: EVENTS }));
      const all = wb.sheets.flatMap((s) => [...s.cells.values()]).filter((c) => typeof c.value === "string").map((c) => c.value as string);
      const sheetOf = (iso: string) => wb.sheets.find((s) => memoOf(s, iso) !== undefined)!;
      expect(memoOf(sheetOf("2026-04-01"), "2026-04-01")).toBe("終日の研修\n10:00-11:30 入社式\n18:30 歓迎会");
      expect(memoOf(sheetOf("2026-05-04"), "2026-05-04")).toBe("みどりの日 当番");
      expect(memoOf(sheetOf("2026-07-20"), "2026-07-20")).toBe("09:00-10:00 海の日 点検");
      expect(memoOf(sheetOf("2026-12-28"), "2026-12-28")).toBe("17:00 仕事納め");
      expect(memoOf(sheetOf("2027-01-04"), "2027-01-04")).toBe("09:00 仕事始め");
      expect(memoOf(sheetOf("2027-03-31"), "2027-03-31")).toBe("年度末の締め <&\"'> =SUM(A1)");
      expect(all.some((t) => t.includes("前年度") || t.includes("翌年度"))).toBe(false);
      // 日付の数・祝日名の数は、予定の有無で変わらない
      const without = readXlsxWorkbook(await excelOf({ mps }));
      const count = (w: typeof wb) => w.sheets.flatMap((s) => [...s.cells.values()]).filter((c) => typeof c.value === "number" && c.value > 40000).length;
      expect(count(wb)).toBe(count(without));
    });
  }

  test("同じ日に多数の予定があっても、Excelのセルには全件残る", async () => {
    const many: CalendarEvent[] = Array.from({ length: 12 }, (_, i) => ({
      date: "2026-06-10",
      title: `予定${String(i + 1).padStart(2, "0")}`,
      startTime: `${String(8 + i).padStart(2, "0")}:00`,
      endTime: null,
      sourceRow: i + 2,
    }));
    for (const mps of [1, 2] as const) {
      const wb = readXlsxWorkbook(await excelOf({ mps, events: many }));
      const sheet = wb.sheets.find((s) => memoOf(s, "2026-06-10") !== undefined)!;
      const text = memoOf(sheet, "2026-06-10")!;
      expect(text.split("\n")).toHaveLength(12);
      expect(text.split("\n")[0]).toBe("08:00 予定01");
      expect(text.split("\n")[11]).toBe("19:00 予定12");
    }
  });

  test("前後の月の日付を表示しても、予定は本来の月の側にだけ入る（二重にならない）", async () => {
    const wb = readXlsxWorkbook(await excelOf({ mps: 1, adj: true, events: [EVENTS[0]] }));
    const holders = wb.sheets.flatMap((s) => [...s.cells.values()]).filter((c) => typeof c.value === "string" && (c.value as string).includes("入社式"));
    expect(holders).toHaveLength(1);
  });

  test("予定がないとき、1か月の出力は従来と完全に同じ（events なし/空のMapで同一）", async () => {
    const plain = excelFingerprint(await excelOf({ mps: 1 }));
    const empty = excelFingerprint(await excelOf({ mps: 1, events: [] }));
    expect(empty).toEqual(plain);
  });

  test("予定を載せても、日付・祝日名・デザインの色（styles）は変わらない", async () => {
    const a = excelFingerprint(await excelOf({ mps: 1 }));
    const b = excelFingerprint(await excelOf({ mps: 1, events: EVENTS }));
    // 変わるのは、予定を入れたシートのセルの内容と、文字列の表・スタイルの数（予定の文字色）だけ
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const key of ["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) expect(b[key], key).toBe(a[key]);
    const wa = readXlsxWorkbook(await excelOf({ mps: 1 }));
    const wb = readXlsxWorkbook(await excelOf({ mps: 1, events: EVENTS }));
    for (let i = 0; i < 12; i++) {
      expect(wb.sheets[i].pageSetup).toEqual(wa.sheets[i].pageSetup);
      expect(wb.sheets[i].pageMargins).toEqual(wa.sheets[i].pageMargins);
      expect(wb.sheets[i].tabColor).toBe(wa.sheets[i].tabColor);
      expect(wb.sheets[i].merged).toEqual(wa.sheets[i].merged);
      expect(wb.sheets[i].rowHeights).toEqual(wa.sheets[i].rowHeights);
      expect(wb.sheets[i].columnWidths).toEqual(wa.sheets[i].columnWidths);
    }
  });
});

test.describe("2か月表示・予定のPDF", () => {
  const fontBytes = readFontBytes();
  const pdf = async (mps: 1 | 2, events?: CalendarEvent[], orientation: "landscape" | "portrait" = "landscape") => {
    const cal = calendarOf();
    const { blob, pageCount } = await buildCalendarPdf({
      calendar: cal,
      theme: CALENDAR_THEMES.business,
      orientation,
      showAdjacentDays: false,
      monthsPerSheet: mps,
      events: events ? placeEvents(cal, events).byDate : undefined,
      fontBytes,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { pageCount, pages: await extractTextBoxes(bytes) };
  };

  test("2か月: 6ページ。横向きはA4横、縦向きはA4縦（向きの指定どおり）", async () => {
    for (const orientation of ["landscape", "portrait"] as const) {
      const { pageCount, pages } = await pdf(2, undefined, orientation);
      expect(pageCount).toBe(6);
      expect(pages).toHaveLength(6);
      for (const p of pages) {
        expect(p.width).toBeCloseTo(orientation === "landscape" ? 841.89 : 595.28, 1);
        expect(p.height).toBeCloseTo(orientation === "landscape" ? 595.28 : 841.89, 1);
      }
    }
  });

  test("2か月: 各ページに左右の月の見出しがあり、全文字がページの余白の内側に収まる", async () => {
    const { pages } = await pdf(2, EVENTS);
    const margin = (10 * 72) / 25.4;
    const titles = [["2026年4月", "2026年5月"], ["2026年6月", "2026年7月"], ["2026年8月", "2026年9月"], ["2026年10月", "2026年11月"], ["2026年12月", "2027年1月"], ["2027年2月", "2027年3月"]];
    pages.forEach((page, i) => {
      const text = page.boxes.map((b) => b.str).join(" ");
      const left = page.boxes.find((b) => b.str.includes(titles[i][0]));
      const right = page.boxes.find((b) => b.str.includes(titles[i][1]));
      expect(left, `${i + 1}ページ左の月見出し`).toBeTruthy();
      expect(right, `${i + 1}ページ右の月見出し`).toBeTruthy();
      expect(left!.x).toBeLessThan(right!.x);
      expect(text).toContain("月");
      for (const b of page.boxes) {
        expect(b.x, `${i + 1}ページ: ${b.str}`).toBeGreaterThanOrEqual(margin - 0.5);
        expect(b.x + b.width, `${i + 1}ページ: ${b.str}`).toBeLessThanOrEqual(page.width - margin + 0.5);
        expect(b.y).toBeGreaterThanOrEqual(margin - 1);
        expect(b.y + b.size).toBeLessThanOrEqual(page.height - margin + 1);
      }
    });
  });

  test("予定が載る: 1か月・2か月とも、該当ページに予定名がある。年度の外の予定は載らない", async () => {
    for (const mps of [1, 2] as const) {
      const { pages } = await pdf(mps, EVENTS);
      // PDFの文字は、日本語の途中で区切られて取り出されることがあるため、空白を除いて探す
      const pageText = pages.map((p) => p.boxes.map((b) => b.str).join("").replace(/\s+/g, ""));
      const pageOf = (needle: string) => pageText.findIndex((t) => t.includes(needle));
      expect(pageOf("入社式"), `${mps}か月 入社式`).toBe(0);
      expect(pageOf("仕事納め"), `${mps}か月 仕事納め`).toBe(mps === 2 ? 4 : 8);
      expect(pageOf("仕事始め"), `${mps}か月 仕事始め`).toBe(mps === 2 ? 4 : 9);
      expect(pageOf("年度末の締め"), `${mps}か月 年度末`).toBe(mps === 2 ? 5 : 11);
      expect(pageText.some((t) => t.includes("前年度") || t.includes("翌年度"))).toBe(false);
    }
  });

  test("多数の予定は「他N件」にまとめ、マスからはみ出さない", async () => {
    const many: CalendarEvent[] = Array.from({ length: 15 }, (_, i) => ({ date: "2026-06-10", title: `予定${i + 1}`, startTime: null, endTime: null, sourceRow: i + 2 }));
    for (const mps of [1, 2] as const) {
      const { pages } = await pdf(mps, many);
      const text = pages.flatMap((p) => p.boxes.map((b) => b.str)).join(" ");
      expect(text, `${mps}か月`).toMatch(/他\d+件|予定\d+件/);
    }
  });

  test("予定がないとき、1か月のPDFは従来と同じページ数（12）", async () => {
    expect((await pdf(1)).pageCount).toBe(12);
    expect((await pdf(1, [])).pageCount).toBe(12);
  });
});

test.describe("Excel予定表 → カレンダー の往復", () => {
  const rows: EventCellValue[][] = [
    ["日付", "予定", "開始時刻", "終了時刻"],
    [new Date(Date.UTC(2026, 3, 1)), "入社式", "10:00", "11:30"],
    [new Date(Date.UTC(2026, 3, 1)), "歓迎会", "18:30", null],
    [new Date(Date.UTC(2026, 4, 4)), "当番", null, null],
    ["来週", "日付が読めない", null, null],
    [new Date(Date.UTC(2027, 0, 4)), "仕事始め", "09:00", null],
    [new Date(Date.UTC(2025, 11, 31)), "年度の外", null, null],
  ];

  test("予定表のExcelを作る → 読み込む → Excel/PDFを作る → 出力を読み直しても予定が同じ → 再作成すると同一", async () => {
    // 1. 予定表のExcel（実際にxlsxファイルとして書き出す）
    const listBlob = await writeXlsxSheets([{ name: "予定表", rows: rows.map((r) => r.map((c) => (c === null ? null : c))) }]);
    const listBytes = new Uint8Array(await listBlob.arrayBuffer());
    expect(validateXlsxStrict(listBytes).problems).toEqual([]);
    // 2. 読み込み → 予定モデル
    const sheets = await readXlsxFileAsSheets(listBytes, "schedule.xlsx");
    const layout = detectLayout(sheets[0].rows)!;
    const result = parseEventRows(sheets[0].rows, layout.mapping, layout.headerRow);
    expect(result.events.map((e) => [e.date, e.title, e.startTime, e.endTime])).toEqual([
      ["2026-04-01", "入社式", "10:00", "11:30"],
      ["2026-04-01", "歓迎会", "18:30", null],
      ["2026-05-04", "当番", null, null],
      ["2027-01-04", "仕事始め", "09:00", null],
      ["2025-12-31", "年度の外", null, null],
    ]);
    expect(result.issues.map((i) => [i.row, i.kind])).toEqual([[5, "bad-date"]]);
    // 3. 処理（画面と同じ Processor）で 1か月・2か月 のExcelを作る
    const processor = new FiscalCalendarProcessor();
    const input = { fiscalYear: 2026, weekStart: "mon", theme: "business", orientation: "landscape", showAdjacentDays: false, events: result.events, format: "excel" } as const;
    for (const monthsPerSheet of [1, 2] as const) {
      const out1 = await processor.process({ ...input, monthsPerSheet });
      const bytes1 = new Uint8Array(await out1.blob.arrayBuffer());
      expect(out1.pageCount).toBe(monthsPerSheet === 2 ? 6 : 12);
      expect(validateXlsxStrict(bytes1).problems).toEqual([]);
      // 4. 出力したカレンダーExcelを、予定表として読み込み直しても、壊れずに「予定表の列がない」と分かる
      const reread = await readXlsxFileAsSheets(bytes1, "calendar.xlsx");
      expect(reread).toHaveLength(monthsPerSheet === 2 ? 6 : 12);
      expect(detectLayout(reread[0].rows)).toBeNull();
      // 5. 出力に予定が全件（年度の中のもの）入っている
      const wb = readXlsxWorkbook(bytes1);
      const texts = wb.sheets.flatMap((s) => [...s.cells.values()]).map((c) => c.value).filter((v): v is string => typeof v === "string");
      for (const t of ["入社式", "歓迎会", "当番", "仕事始め"]) expect(texts.some((x) => x.includes(t)), `${monthsPerSheet}か月 ${t}`).toBe(true);
      expect(texts.some((x) => x.includes("年度の外"))).toBe(false);
      // 6. 同じ入力で作り直すと、Excelの中身が同一（出力が決まった形で作られる）
      const out2 = await processor.process({ ...input, monthsPerSheet });
      expect(excelFingerprint(new Uint8Array(await out2.blob.arrayBuffer()))).toEqual(excelFingerprint(bytes1));
    }
    // 7. PDFも同じ予定（同じ placeEvents の結果）から作れる。
    //    （Processor経由のPDFは日本語フォントをブラウザで取得するため、画面のE2E（tests/tools/fiscal-calendar-events.spec.ts）で確認する）
    const cal = calendarOf();
    const pdf = await buildCalendarPdf({
      calendar: cal,
      theme: CALENDAR_THEMES.business,
      orientation: "landscape",
      monthsPerSheet: 2,
      events: placeEvents(cal, result.events).byDate,
      fontBytes: readFontBytes(),
    });
    expect(pdf.pageCount).toBe(6);
    expect(pdf.blob.size).toBeGreaterThan(5000);
  });

  test("ファイル名: 2か月は「_2か月」が付き、向き（横/縦）は指定どおり", () => {
    const base = { fiscalYear: 2026, weekStart: "mon", theme: "business", orientation: "portrait", showAdjacentDays: false } as const;
    expect(buildFiscalCalendarFileName({ ...base, format: "excel" })).toBe("2026年度カレンダー_月曜始まり_縦.xlsx");
    expect(buildFiscalCalendarFileName({ ...base, monthsPerSheet: 2, format: "excel" })).toBe("2026年度カレンダー_月曜始まり_縦_2か月.xlsx");
    expect(buildFiscalCalendarFileName({ ...base, monthsPerSheet: 2, format: "pdf" })).toBe("2026年度カレンダー_月曜始まり_縦_2か月.pdf");
    const land = { ...base, orientation: "landscape" } as const;
    expect(buildFiscalCalendarFileName({ ...land, monthsPerSheet: 2, format: "excel" })).toBe("2026年度カレンダー_月曜始まり_横_2か月.xlsx");
    expect(buildFiscalCalendarFileName({ ...land, monthsPerSheet: 2, format: "pdf" })).toBe("2026年度カレンダー_月曜始まり_横_2か月.pdf");
  });

  test("入力の検証: 1シートの月数が不正ならエラー", async () => {
    const processor = new FiscalCalendarProcessor();
    await expect(
      processor.process({ fiscalYear: 2026, weekStart: "mon", theme: "business", orientation: "landscape", showAdjacentDays: false, monthsPerSheet: 3 as never, format: "excel" }),
    ).rejects.toThrow(/1か月か2か月/);
  });
});

test.describe("LibreOfficeでの読み込み（Excel本体の代わりの補助確認）", () => {
  const hasSoffice = (() => {
    try {
      execFileSync("soffice", ["--version"], { stdio: "ignore", timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  })();
  test.skip(!hasSoffice, "LibreOffice(soffice)が無い環境のため未実施");
  test.setTimeout(240_000);

  test("予定つき2か月のExcelをPDFに変換でき、6ページ（A4横）になる。注意: Excel本体での確認ではない", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cal-two-"));
    try {
      const file = path.join(dir, "two.xlsx");
      fs.writeFileSync(file, await excelOf({ mps: 2, events: EVENTS }));
      execFileSync("soffice", [`-env:UserInstallation=file://${dir}/profile`, "--headless", "--convert-to", "pdf", "--outdir", dir, file], { stdio: "ignore", timeout: 200_000 });
      const pages = await extractTextBoxes(new Uint8Array(fs.readFileSync(path.join(dir, "two.pdf"))));
      expect(pages).toHaveLength(6);
      for (const p of pages) {
        expect(p.width).toBeGreaterThan(p.height);
        expect(p.width).toBeCloseTo(841.89, 0);
      }
      expect(pages[0].boxes.map((b) => b.str).join("").replace(/\s+/g, "")).toContain("入社式");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
