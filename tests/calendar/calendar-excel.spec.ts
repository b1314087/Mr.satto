import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { addressOf, excelSerialToIso, readXlsxWorkbook, type XlsxSheetInfo, type XlsxWorkbookInfo } from "../helpers/xlsx-workbook";
import { buildCalendarExcel, type CalendarOrientation } from "@/lib/calendar/excel";
import { STATUTORY_NOTE, buildFiscalCalendar, monthNote, type WeekStart } from "@/lib/calendar/model";
import { CALENDAR_THEMES, type CalendarThemeId } from "@/lib/calendar/themes";
import { pinHolidayData } from "../helpers/holiday-pin";

pinHolidayData(); // 祝日の表示の仕様は、固定データ（2027年まで確定）で確かめる

/**
 * 年度カレンダーのExcel出力のテスト（工程B）。
 * 出力ファイルを、アプリの実装とは別のXMLリーダー（tests/helpers/xlsx-workbook.ts）で読み取り、
 * 次の独立した参照データと突き合わせる。
 *   - 月の表の開始日と週数: Python標準calendarの結果（calendar-grid-reference.json）
 *   - 祝日名: python-holidays の結果（holidays-reference-python-holidays-2000-2099.json）
 */

const STATIC = fixtures.dir.static;
const grid = JSON.parse(fs.readFileSync(path.join(STATIC, "calendar-grid-reference.json"), "utf-8")) as Record<string, [string, number]>;
const holidayRef = JSON.parse(
  fs.readFileSync(path.join(STATIC, "holidays-reference-python-holidays-2000-2099.json"), "utf-8"),
).holidays as Record<string, [string, string][]>;
const refHolidayName = (iso: string): string | undefined =>
  holidayRef[iso.slice(0, 4)]?.find(([d]) => d === iso)?.[1];

const MONTH_SHEETS = ["4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月", "1月", "2月", "3月"];

async function build(fiscalYear: number, weekStart: WeekStart, theme: CalendarThemeId, orientation: CalendarOrientation, showAdjacentDays = false) {
  const blob = await buildCalendarExcel({
    calendar: buildFiscalCalendar({ fiscalYear, weekStart }),
    theme: CALENDAR_THEMES[theme],
    orientation,
    showAdjacentDays,
  });
  return readXlsxWorkbook(new Uint8Array(await blob.arrayBuffer()));
}

function monthOfSheet(fiscalYear: number, index: number): { y: number; m: number } {
  const m = ((3 + index) % 12) + 1;
  return { y: index < 9 ? fiscalYear : fiscalYear + 1, m };
}

function dayOffset(startIso: string, days: number): string {
  return new Date(Date.parse(`${startIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 週ごとの行（0始まり）。日付行は 2+2w、予定欄は 3+2w */
const dateRowOf = (w: number) => 2 + 2 * w;
const memoRowOf = (w: number) => 3 + 2 * w;

test.describe("年度カレンダーExcel: シート構成", () => {
  test("月別12シートが4月→翌年3月の順に並ぶ", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    expect(wb.sheets.map((s) => s.name)).toEqual(MONTH_SHEETS);
  });

  test("タイトル行に年・月・和暦・年度が入る（年度と西暦の区別）", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const apr = wb.sheets[0];
    expect(apr.cells.get("A1")?.value).toBe("2026年4月");
    expect(apr.cells.get("K1")?.value).toBe("令和8年4月　2026年度");
    const jan = wb.sheets[9];
    expect(jan.cells.get("A1")?.value).toBe("2027年1月");
    expect(jan.cells.get("K1")?.value).toBe("令和9年1月　2026年度");
  });

  for (const ws of ["mon", "sun"] as const) {
    test(`曜日見出しの並び（${ws === "mon" ? "月曜" : "日曜"}始まり）`, async () => {
      const wb = await build(2026, ws, "business", "landscape");
      const expected = ws === "mon" ? ["月", "火", "水", "木", "金", "土", "日"] : ["日", "月", "火", "水", "木", "金", "土"];
      for (const sheet of wb.sheets) {
        expect([0, 2, 4, 6, 8, 10, 12].map((c) => sheet.cells.get(addressOf(1, c))?.value)).toEqual(expected);
      }
    });
  }
});

test.describe("年度カレンダーExcel: 日付・曜日・祝日名", () => {
  for (const [fy, ws] of [[2026, "mon"], [2026, "sun"], [2027, "mon"], [2023, "sun"]] as const) {
    test(`${fy}年度・${ws === "mon" ? "月曜" : "日曜"}始まり: 全シートの日付と祝日名が参照データと一致する`, async () => {
      const wb = await build(fy, ws, "business", "landscape");
      const problems: string[] = [];
      wb.sheets.forEach((sheet, i) => {
        const { y, m } = monthOfSheet(fy, i);
        const [start, weeks] = grid[`${y}-${m}-${ws}`];
        for (let w = 0; w < weeks; w++) {
          for (let c = 0; c < 7; c++) {
            const iso = dayOffset(start, w * 7 + c);
            const inMonth = iso.startsWith(`${y}-${String(m).padStart(2, "0")}-`);
            const numCell = sheet.cells.get(addressOf(dateRowOf(w), c * 2));
            const nameCell = sheet.cells.get(addressOf(dateRowOf(w), c * 2 + 1));
            if (inMonth) {
              if (typeof numCell?.value !== "number" || excelSerialToIso(numCell.value) !== iso) {
                problems.push(`${sheet.name} ${iso}: 日付セル=${numCell?.value}`);
              }
              const style = wb.style(numCell);
              if (style?.numberFormat !== "d") problems.push(`${sheet.name} ${iso}: 表示形式=${style?.numberFormat}`);
              let expectedName: string | null = refHolidayName(iso) ?? null;
              // 暦要項の公示前（2027年末より後）の春分の日・秋分の日だけが「推定」で、※が付く
              if (expectedName && iso > "2027-12-31" && /^(春分|秋分)の日$/.test(expectedName)) expectedName += "※";
              if ((nameCell?.value ?? null) !== expectedName) {
                problems.push(`${sheet.name} ${iso}: 祝日名=${nameCell?.value} 期待=${expectedName}`);
              }
            } else if (numCell?.value != null || nameCell?.value != null) {
              problems.push(`${sheet.name} ${iso}: その月でない日にも値がある`);
            }
          }
        }
        // 注記行（週の次の1行）より後ろに、セルが無い
        const lastRow = Math.max(...[...sheet.cells.values()].map((c) => c.row));
        if (lastRow !== dateRowOf(weeks)) problems.push(`${sheet.name}: 最終行=${lastRow + 1} 期待=${dateRowOf(weeks) + 1}`);
      });
      expect(problems).toEqual([]);
    });
  }

  test("うるう年: 2028年2月（2027年度）に2月29日がある。2027年2月（2026年度）にはない", async () => {
    const leap = (await build(2027, "mon", "business", "landscape")).sheets[10];
    const serials = [...leap.cells.values()].filter((c) => c.col % 2 === 0 && c.row >= 2 && typeof c.value === "number").map((c) => excelSerialToIso(c.value as number));
    expect(serials).toContain("2028-02-29");
    expect(serials).toHaveLength(29);
    const common = (await build(2026, "mon", "business", "landscape")).sheets[10];
    const s2 = [...common.cells.values()].filter((c) => c.col % 2 === 0 && c.row >= 2 && typeof c.value === "number").map((c) => excelSerialToIso(c.value as number));
    expect(s2).toHaveLength(28);
    expect(s2).not.toContain("2027-02-29");
  });

  test("4週・5週・6週の月で、日付行・予定欄の行数が週数どおり（2026年度 月曜始まり: 2027年2月=4週、8月=6週）", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const rowsOf = (s: XlsxSheetInfo) => Math.max(...[...s.cells.values()].map((c) => c.row)) + 1;
    expect(rowsOf(wb.sheets[10])).toBe(3 + 4 * 2); // 2027年2月
    expect(rowsOf(wb.sheets[4])).toBe(3 + 6 * 2); // 2026年8月
    expect(rowsOf(wb.sheets[0])).toBe(3 + 5 * 2); // 2026年4月
  });

  test("未確定の祝日の注記: 推定（※）の月、法律どおりの月に出る。確定済みの月（2027年内）には出ない", async () => {
    const wb = await build(2027, "mon", "business", "landscape");
    const noteOf = (i: number) =>
      [...wb.sheets[i].cells.values()].find(
        (c) => typeof c.value === "string" && (c.value.startsWith("※は") || c.value.startsWith("祝日は現行")),
      )?.value;
    // 2027年4月〜12月は確定済み（注記なし）
    for (let i = 0; i < 9; i++) expect(noteOf(i), `${wb.sheets[i].name}`).toBeUndefined();
    // 2028年1月・2月: 祝日は法律どおり（推定の日なし）→ 「※」は付けず、法改正の注記だけ
    expect(noteOf(9)).toBe(STATUTORY_NOTE);
    expect(noteOf(10)).toBe(STATUTORY_NOTE);
    // 2028年3月: 祝日は春分の日（推定）だけ → 「※」の注記
    expect(noteOf(11)).toBe(monthNote(buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" }).months[11]));
    expect(noteOf(11)).toContain("推定日");
  });

  test("前後の月の日付を表示するオプション: 既定は空欄、オンにすると薄い色で日付が入る", async () => {
    const off = (await build(2026, "mon", "business", "landscape", false)).sheets[0];
    expect(off.cells.get("A3")?.value ?? null).toBeNull();
    const onWb = await build(2026, "mon", "business", "landscape", true);
    const on = onWb.sheets[0];
    expect(excelSerialToIso(on.cells.get("A3")!.value as number)).toBe("2026-03-30");
    expect(onWb.style(on.cells.get("A3"))?.fillColor).toBe("F2F2F2");
    // 前の月の日に祝日名は出さない
    expect(on.cells.get("B3")?.value ?? null).toBeNull();
  });
});

test.describe("年度カレンダーExcel: 予定記入欄と編集性", () => {
  test("各日の予定欄は日付の2列ぶんを結合した空のセルで、日付行・祝日名の下にある", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const apr = wb.sheets[0];
    for (let w = 0; w < 5; w++) {
      for (let c = 0; c < 7; c++) {
        const range = `${addressOf(memoRowOf(w), c * 2)}:${addressOf(memoRowOf(w), c * 2 + 1)}`;
        expect(apr.merged, range).toContain(range);
        expect(apr.cells.get(addressOf(memoRowOf(w), c * 2))?.value ?? null, range).toBeNull();
      }
    }
  });

  test("予定欄は折り返し・上寄せで、十分な高さ（40pt以上）がある。日付行は予定欄より低い", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    for (const sheet of wb.sheets) {
      const weeks = (Math.max(...[...sheet.cells.values()].map((c) => c.row)) + 1 - 3) / 2;
      for (let w = 0; w < weeks; w++) {
        const memoH = sheet.rowHeights.get(memoRowOf(w))!;
        expect(memoH, `${sheet.name} 週${w}`).toBeGreaterThanOrEqual(40);
        expect(sheet.rowHeights.get(dateRowOf(w))!).toBeLessThan(memoH);
        const style = wb.style(sheet.cells.get(addressOf(memoRowOf(w), 0)));
        expect(style?.wrap).toBe(true);
        expect(style?.vertical).toBe("top");
      }
    }
  });

  test("予定欄に文字を入れても日付・祝日名のセルは別なので消えない（結合範囲が日付行に重ならない）", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const apr = wb.sheets[0];
    const dateRows = new Set([2, 4, 6, 8, 10].map((r) => r + 1));
    for (const ref of apr.merged) {
      const rows = [...ref.matchAll(/\d+/g)].map((m) => Number(m[0]));
      // 結合は、タイトル(1行目)・曜日見出し(2行目)・予定欄・注記行のみ
      for (const r of rows) expect(dateRows.has(r), ref).toBe(false);
    }
  });

  test("結合セルの隠れた側のセルにも、罫線・背景色が付いている（枠線が欠けない）", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const apr = wb.sheets[0];
    const master = wb.style(apr.cells.get("A4"));
    const hidden = wb.style(apr.cells.get("B4"));
    expect(hidden).not.toBeNull();
    expect(hidden?.fillColor).toBe(master?.fillColor);
    expect(hidden?.borders).toEqual({ left: "thin", right: "thin", top: "thin", bottom: "thin" });
  });

  test("日付は本物の日付セル（数値のシリアル値＋表示形式「d」）で、文字列ではない", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const cell = wb.sheets[0].cells.get("E3")!; // 2026-04-01
    expect(typeof cell.value).toBe("number");
    expect(excelSerialToIso(cell.value as number)).toBe("2026-04-01");
    expect(wb.style(cell)?.numberFormat).toBe("d");
  });
});

test.describe("年度カレンダーExcel: 色分けと書式", () => {
  test("ビジネス: 平日・土曜・日曜・祝日で日付の文字色と背景色が変わる（2026年10月）", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const oct = wb.sheets[6]; // 2026年10月: 1日=木。月曜始まり: 1行目に 木1 金2 土3 日4
    const at = (w: number, c: number) => wb.style(oct.cells.get(addressOf(dateRowOf(w), c * 2)));
    expect(at(0, 3)).toMatchObject({ fontColor: "1F2937", fillColor: "FFFFFF", bold: true }); // 木 1日（平日）
    expect(at(0, 5)).toMatchObject({ fontColor: "1F4E9E", fillColor: "EAF0FB" }); // 土 3日
    expect(at(0, 6)).toMatchObject({ fontColor: "B42318", fillColor: "FDECEC" }); // 日 4日
    expect(at(2, 0)).toMatchObject({ fontColor: "B42318", fillColor: "FDECEC" }); // 月 12日 スポーツの日（祝日）
    expect(oct.cells.get(addressOf(dateRowOf(2), 1))?.value).toBe("スポーツの日");
    // 祝日名の文字色
    expect(wb.style(oct.cells.get(addressOf(dateRowOf(2), 1)))?.fontColor).toBe("B42318");
    // 前の月の日（空欄）は灰色の背景
    expect(wb.style(oct.cells.get(addressOf(dateRowOf(0), 0)))?.fillColor).toBe("F2F2F2");
  });

  test("ナチュラル: 見出し・曜日見出し・日付・タブの色がビジネスと異なる", async () => {
    const wb = await build(2026, "mon", "natural", "landscape");
    const apr = wb.sheets[0];
    expect(wb.style(apr.cells.get("A1"))).toMatchObject({ fillColor: "4F6B4A", fontColor: "FFFFFF" });
    expect(wb.style(apr.cells.get("A2"))?.fillColor).toBe("E8E4D0");
    expect(wb.style(apr.cells.get("E3"))?.fillColor).toBe("FBF8EF"); // 平日
    expect(apr.tabColor).toBe("4F6B4A");
    const biz = (await build(2026, "mon", "business", "landscape")).sheets[0];
    expect(biz.tabColor).toBe("1F3864");
  });

  test("日付行・予定欄のすべてのセルに、四辺の罫線がある", async () => {
    const wb = await build(2026, "mon", "natural", "portrait");
    const sheet = wb.sheets[4]; // 6週の月
    for (let w = 0; w < 6; w++) {
      for (let c = 0; c < 14; c++) {
        for (const r of [dateRowOf(w), memoRowOf(w)]) {
          const s = wb.style(sheet.cells.get(addressOf(r, c)));
          expect(s?.borders, addressOf(r, c)).toEqual({ left: "thin", right: "thin", top: "thin", bottom: "thin" });
        }
      }
    }
  });

  test("文字の書体は游ゴシック、ブックの標準フォントはArial 10（列幅の単位を環境によらず固定するため）", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    expect(wb.defaultFont).toEqual({ name: "Arial", size: 10 });
    expect(wb.style(wb.sheets[0].cells.get("A1"))?.fontName).toBe("Yu Gothic");
    expect(wb.style(wb.sheets[0].cells.get("E3"))?.fontName).toBe("Yu Gothic");
  });
});

test.describe("年度カレンダーExcel: 印刷設定", () => {
  for (const orientation of ["landscape", "portrait"] as const) {
    test(`A4・${orientation === "landscape" ? "横" : "縦"}・余白10mm・水平中央・1ページに収める設定が全シートにある`, async () => {
      const wb = await build(2026, "mon", "business", orientation);
      for (const sheet of wb.sheets) {
        expect(sheet.pageSetup.paperSize, sheet.name).toBe("9");
        expect(sheet.pageSetup.orientation, sheet.name).toBe(orientation);
        expect(sheet.pageSetup.fitToWidth, sheet.name).toBe("1");
        expect(sheet.pageSetup.fitToHeight, sheet.name).toBe("1");
        expect(sheet.fitToPage, sheet.name).toBe(true);
        expect(sheet.horizontalCentered, sheet.name).toBe(true);
        for (const side of ["left", "right", "top", "bottom"]) {
          expect(Number(sheet.pageMargins[side]), `${sheet.name} ${side}`).toBeCloseTo(10 / 25.4, 3);
        }
        expect(sheet.frozenRows, sheet.name).toBe(2);
      }
    });
  }

  test("印刷範囲（Print_Area）が全シートに、各シートの表全体として設定される", async () => {
    const wb = await build(2026, "mon", "business", "landscape");
    const areas = wb.definedNames.filter((d) => d.name === "_xlnm.Print_Area");
    expect(areas).toHaveLength(12);
    wb.sheets.forEach((sheet, i) => {
      const lastRow = Math.max(...[...sheet.cells.values()].map((c) => c.row)) + 1;
      const area = areas.find((a) => a.localSheetId === i);
      expect(area?.ref, sheet.name).toBe(`'${sheet.name}'!$A$1:$N$${lastRow}`);
    });
  });

  test("列幅と行の高さの合計がA4の印刷可能範囲に収まり、等倍に近い（縮小しすぎない）", async () => {
    for (const orientation of ["landscape", "portrait"] as const) {
      const wb = await build(2026, "mon", "business", orientation);
      // 印刷可能範囲(mm→px/pt)。Excelの列幅は 文字数×7px+5px（標準フォントArial 10の数字幅7px）
      const widthMm = (orientation === "landscape" ? 297 : 210) - 20;
      const heightPt = ((orientation === "landscape" ? 210 : 297) - 20) * (72 / 25.4);
      for (const sheet of wb.sheets) {
        const widthPx = [...sheet.columnWidths.values()].reduce((sum, w) => sum + Math.round(w * 7 + 5), 0);
        const widthMmActual = (widthPx * 25.4) / 96;
        expect(widthMmActual, `${sheet.name} 幅`).toBeLessThanOrEqual(widthMm * 1.03);
        expect(widthMmActual, `${sheet.name} 幅`).toBeGreaterThanOrEqual(widthMm * 0.93);
        const rowCount = Math.max(...[...sheet.cells.values()].map((c) => c.row)) + 1;
        let h = 0;
        for (let r = 0; r < rowCount; r++) h += sheet.rowHeights.get(r) ?? 15;
        expect(h, `${sheet.name} 高さ`).toBeLessThanOrEqual(heightPt);
        expect(h, `${sheet.name} 高さ`).toBeGreaterThanOrEqual(heightPt * 0.78);
      }
    }
  });
});

test.describe("年度カレンダーExcel: 出力の健全性", () => {
  test("ZIPとして正しく、必要な部品（ブック・12シート・スタイル）がそろう", async () => {
    const blob = await buildCalendarExcel({
      calendar: buildFiscalCalendar({ fiscalYear: 2026, weekStart: "mon" }),
      theme: CALENDAR_THEMES.business,
      orientation: "landscape",
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    const { unzipSync } = await import("fflate");
    const names = Object.keys(unzipSync(bytes));
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/styles.xml");
    expect(names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))).toHaveLength(12);
    expect(blob.size).toBeGreaterThan(5_000);
    expect(blob.size).toBeLessThan(500_000);
  });

  test("年度の範囲外はエラーになる", async () => {
    await expect(async () => buildFiscalCalendar({ fiscalYear: 1999, weekStart: "mon" })).rejects.toThrow();
  });

  test("タイムゾーンが違っても、日付が1日ずれない（日本時間・米国西海岸・UTCのいずれでも同じ）", async () => {
    const original = process.env.TZ;
    try {
      const seen = new Set<string>();
      for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        const wb = await build(2026, "mon", "business", "landscape");
        seen.add(excelSerialToIso(wb.sheets[0].cells.get("E3")!.value as number));
      }
      expect([...seen]).toEqual(["2026-04-01"]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

export type { XlsxWorkbookInfo };
