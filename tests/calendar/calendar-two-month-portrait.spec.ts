import { test, expect } from "@playwright/test";
import { extractTextBoxes, readFontBytes, type PageBoxes } from "../helpers/pdf-text-boxes";
import { excelSerialToIso, readXlsxWorkbook, type XlsxSheetInfo } from "../helpers/xlsx-workbook";
import { validateXlsxStrict } from "../helpers/xlsx-strict";
import { excelFingerprint } from "../helpers/calendar-golden";
import { buildCalendarExcel, monthSheetGeometry, printAreaOf, sheetGeometry } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { groupMonths, sheetArrangement } from "@/lib/calendar/layout";
import { placeEvents, type CalendarEvent } from "@/lib/calendar/events";
import { CALENDAR_THEME_IDS, CALENDAR_THEMES, resolveCalendarTheme, type CalendarThemeChoice } from "@/lib/calendar/themes";
import { FiscalCalendarProcessor } from "@/lib/processors/browser/fiscal-calendar";

/**
 * 「2か月・1枚」のA4縦（上下配置）のテスト。
 *   - 横向き: 左に前の月、右に次の月（従来どおり）
 *   - 縦向き: 上に前の月、下に次の月
 * Excel・PDFで、用紙の向きと月の並びが一致すること、年度またぎ・祝日・予定・テーマ・1か月表示に影響しないことを確かめる。
 */

const FY = 2026;
const calendarOf = (ws: WeekStart = "mon", fy = FY) => buildFiscalCalendar({ fiscalYear: fy, weekStart: ws });

const EVENTS: CalendarEvent[] = [
  { date: "2026-04-01", title: "入社式", startTime: "10:00", endTime: "11:30", sourceRow: 2 },
  { date: "2026-05-04", title: "みどりの日 当番", startTime: null, endTime: null, sourceRow: 3 },
  { date: "2026-12-28", title: "仕事納め", startTime: "17:00", endTime: null, sourceRow: 4 },
  { date: "2027-01-04", title: "仕事始め", startTime: "09:00", endTime: null, sourceRow: 5 },
  { date: "2027-03-31", title: "年度末の締め", startTime: null, endTime: null, sourceRow: 6 },
  { date: "2027-04-01", title: "翌年度", startTime: null, endTime: null, sourceRow: 7 },
];

const SHEET_NAMES = ["4月・5月", "6月・7月", "8月・9月", "10月・11月", "12月・1月", "2月・3月"];
const TITLES = [
  ["2026年4月", "2026年5月"],
  ["2026年6月", "2026年7月"],
  ["2026年8月", "2026年9月"],
  ["2026年10月", "2026年11月"],
  ["2026年12月", "2027年1月"],
  ["2027年2月", "2027年3月"],
];

async function excelOf(opts: {
  ws?: WeekStart;
  theme?: CalendarThemeChoice;
  orientation: "landscape" | "portrait";
  mps: 1 | 2;
  adj?: boolean;
  events?: CalendarEvent[];
  fy?: number;
}) {
  const cal = calendarOf(opts.ws ?? "mon", opts.fy ?? FY);
  const blob = await buildCalendarExcel({
    calendar: cal,
    theme: resolveCalendarTheme(opts.theme ?? "business", { main: "#2E7D32", accent: "#C62828", background: "#FFFDE7", ink: "#263238" }),
    orientation: opts.orientation,
    showAdjacentDays: opts.adj ?? false,
    monthsPerSheet: opts.mps,
    events: opts.events ? placeEvents(cal, opts.events).byDate : undefined,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

const dateCells = (sheet: XlsxSheetInfo) =>
  [...sheet.cells.values()].filter((c) => typeof c.value === "number" && c.value > 40000).map((c) => ({ iso: excelSerialToIso(c.value as number), row: c.row, col: c.col }));
const textCells = (sheet: XlsxSheetInfo) => [...sheet.cells.values()].filter((c) => typeof c.value === "string").map((c) => ({ text: c.value as string, row: c.row, col: c.col }));

test.describe("並べ方の決まり", () => {
  test("横向き=左右、縦向き=上下。1か月は並べない", () => {
    expect(sheetArrangement("landscape", 2)).toBe("side-by-side");
    expect(sheetArrangement("portrait", 2)).toBe("stacked");
    expect(sheetArrangement("landscape", 1)).toBe("single");
    expect(sheetArrangement("portrait", 1)).toBe("single");
  });

  test("縦向きの2か月は、1か月と同じ14列で、余白の列なし・月の間に余白の行が1つ", () => {
    for (const weeks of [4, 5, 6]) {
      const g = sheetGeometry(weeks, 2, "portrait");
      expect(g.columnCount).toBe(14);
      expect(g.gapColumnMm).toBe(0);
      expect(g.gapRowPt).toBeGreaterThan(0);
      expect(g.rowCount).toBe((3 + weeks * 2) * 2 + 1);
      expect(g.memoRowPt).toBeGreaterThan(20);
      expect(printAreaOf(weeks, "portrait", 2)).toBe(`A1:N${g.rowCount}`);
    }
    // 横向きの2か月・1か月は従来どおり
    expect(sheetGeometry(6, 2, "landscape").columnCount).toBe(29);
    expect(sheetGeometry(6, 2, "landscape").gapRowPt).toBe(0);
    expect(sheetGeometry(6, 1, "portrait")).toMatchObject({ columnCount: 14, gapColumnMm: 0, gapRowPt: 0, rowCount: monthSheetGeometry(6, "portrait").rowCount });
  });

  test("縦向きの2か月は、A4縦1枚の高さに収まる（行の高さの合計が、余白を除いたA4縦の高さ以下）", () => {
    const usable = ((297 - 20) * 72) / 25.4;
    for (const weeks of [4, 5, 6]) {
      const g = sheetGeometry(weeks, 2, "portrait");
      // 日付行20pt + 予定行 memoRowPt が weeks×2か月ぶん、タイトル26・見出し16・注記16が2か月ぶん、余白の行
      const total = 2 * (26 + 16 + 16 + weeks * (20 + g.memoRowPt)) + g.gapRowPt;
      expect(total, `${weeks}週`).toBeLessThanOrEqual(usable);
    }
  });
});

test.describe("Excel: 2か月・A4縦（上下配置）", () => {
  test("6シート・シート名・A4縦・余白・1ページに収める・印刷範囲（A〜N列）", async () => {
    const wb = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2 }));
    expect(wb.sheets.map((s) => s.name)).toEqual(SHEET_NAMES);
    for (const s of wb.sheets) {
      expect(s.pageSetup.orientation).toBe("portrait");
      expect(s.pageSetup.paperSize).toBe("9");
      expect(s.fitToPage).toBe(true);
      expect(s.horizontalCentered).toBe(true);
    }
    const areas = wb.definedNames.filter((d) => d.name === "_xlnm.Print_Area");
    expect(areas).toHaveLength(6);
    areas.forEach((a) => expect(a.ref).toMatch(/^'[^']+'!\$A\$1:\$N\$\d+$/));
    // 印刷範囲の最終行は、シートの実際の最終行と一致する（印刷が途中で切れない）
    wb.sheets.forEach((s, i) => {
      const lastRow = Math.max(...[...s.cells.values()].map((c) => c.row)) + 1;
      expect(Number(/\$N\$(\d+)$/.exec(areas.find((a) => a.localSheetId === i)!.ref)![1]), s.name).toBe(lastRow);
    });
  });

  test("上に前の月・下に次の月: 日付の行が上下で重ならず、列はすべてA〜N、月見出しは上が前の月", async () => {
    const wb = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2 }));
    wb.sheets.forEach((s, i) => {
      const [first, second] = TITLES[i];
      const titles = textCells(s).filter((c) => /^\d{4}年\d{1,2}月$/.test(c.text));
      expect(titles.map((t) => t.text), s.name).toEqual([first, second]);
      const [upper, lower] = titles;
      expect(upper.row, s.name).toBe(0);
      expect(lower.row, s.name).toBeGreaterThan(upper.row + 8);
      // 2つの月見出しは同じ列から始まる（左右ではなく上下に並ぶ）
      expect(lower.col).toBe(upper.col);
      // 使う列は14列（A〜N）だけ
      expect(Math.max(...[...s.cells.values()].map((c) => c.col))).toBeLessThanOrEqual(13);
      // 日付セルは、前の月の日が上の月の範囲、次の月の日が下の月の範囲にある
      const dates = dateCells(s);
      const ym = (iso: string) => iso.slice(0, 7);
      const firstKey = `${first.slice(0, 4)}-${first.slice(5, first.length - 1).padStart(2, "0")}`;
      const secondKey = `${second.slice(0, 4)}-${second.slice(5, second.length - 1).padStart(2, "0")}`;
      for (const d of dates) {
        if (ym(d.iso) === firstKey) expect(d.row, `${s.name} ${d.iso}`).toBeLessThan(lower.row);
        if (ym(d.iso) === secondKey) expect(d.row, `${s.name} ${d.iso}`).toBeGreaterThan(lower.row);
      }
      // 月の日付はどちらの月も全日ある
      const days = (key: string) => new Set(dates.filter((d) => ym(d.iso) === key).map((d) => d.iso));
      const [y1, m1] = firstKey.split("-").map(Number);
      const [y2, m2] = secondKey.split("-").map(Number);
      expect(days(firstKey).size, `${s.name} ${firstKey}`).toBe(new Date(Date.UTC(y1, m1, 0)).getUTCDate());
      expect(days(secondKey).size, `${s.name} ${secondKey}`).toBe(new Date(Date.UTC(y2, m2, 0)).getUTCDate());
    });
  });

  test("年度をまたぐ12月・1月: 上が2026年12月、下が2027年1月", async () => {
    const wb = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2 }));
    const dec = wb.sheets[4];
    const dates = dateCells(dec);
    const d1231 = dates.find((d) => d.iso === "2026-12-31")!;
    const d0101 = dates.find((d) => d.iso === "2027-01-01")!;
    expect(d1231).toBeTruthy();
    expect(d0101).toBeTruthy();
    expect(d1231.row).toBeLessThan(d0101.row);
  });

  test("上下の余白の行がある（高さが指定され、月見出しの間に空の行がはさまる）", async () => {
    const wb = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2 }));
    for (const s of wb.sheets) {
      const titles = textCells(s).filter((c) => /^\d{4}年\d{1,2}月$/.test(c.text));
      const lowerTitleRow = titles[1].row;
      const spacerRow = lowerTitleRow - 1;
      expect([...s.cells.values()].filter((c) => c.row === spacerRow && c.value !== null), s.name).toEqual([]);
      expect(s.rowHeights.get(spacerRow), s.name).toBeGreaterThan(0);
      expect(s.rowHeights.get(spacerRow)!, s.name).toBeLessThan(20);
    }
  });

  test("横向きの2か月は従来どおり（左右・A4横・A〜AC列）で、縦向きとは別のレイアウト", async () => {
    const land = readXlsxWorkbook(await excelOf({ orientation: "landscape", mps: 2 }));
    for (const s of land.sheets) {
      expect(s.pageSetup.orientation).toBe("landscape");
      expect(Math.max(...[...s.cells.values()].map((c) => c.col))).toBe(28);
    }
    const first = land.sheets[0];
    const titles = textCells(first).filter((c) => /^\d{4}年\d{1,2}月$/.test(c.text));
    expect(titles[0].row).toBe(titles[1].row);
    expect(titles[0].col).toBeLessThan(titles[1].col);
  });

  test("日付・祝日名・予定は、横向きと縦向きで同じ（並べ方だけが違う）", async () => {
    for (const ws of ["mon", "sun"] as const) {
      const land = readXlsxWorkbook(await excelOf({ orientation: "landscape", mps: 2, ws, events: EVENTS, adj: ws === "sun" }));
      const port = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2, ws, events: EVENTS, adj: ws === "sun" }));
      expect(port.sheets).toHaveLength(land.sheets.length);
      port.sheets.forEach((s, i) => {
        const sortKey = (a: string, b: string) => a.localeCompare(b);
        expect(dateCells(s).map((d) => d.iso).sort(sortKey), `${ws} ${s.name} 日付`).toEqual(dateCells(land.sheets[i]).map((d) => d.iso).sort(sortKey));
        expect(textCells(s).map((c) => c.text).sort(sortKey), `${ws} ${s.name} 文字`).toEqual(textCells(land.sheets[i]).map((c) => c.text).sort(sortKey));
      });
    }
  });

  test("予定は正しい日の予定欄に全件入る（年度の外は入らない）。同じ日に多数あっても欠けない", async () => {
    const many: CalendarEvent[] = Array.from({ length: 10 }, (_, i) => ({
      date: "2026-06-10",
      title: `予定${String(i + 1).padStart(2, "0")}`,
      startTime: `${String(8 + i).padStart(2, "0")}:00`,
      endTime: null,
      sourceRow: i + 2,
    }));
    const wb = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2, events: [...EVENTS, ...many] }));
    const memoBelow = (iso: string) => {
      for (const s of wb.sheets) {
        const cell = [...s.cells.values()].find((c) => typeof c.value === "number" && c.value > 40000 && excelSerialToIso(c.value as number) === iso);
        if (cell) {
          const below = [...s.cells.values()].find((c) => c.row === cell.row + 1 && c.col === cell.col);
          return typeof below?.value === "string" ? below.value : null;
        }
      }
      return undefined;
    };
    expect(memoBelow("2026-04-01")).toBe("10:00-11:30 入社式");
    expect(memoBelow("2026-12-28")).toBe("17:00 仕事納め");
    expect(memoBelow("2027-01-04")).toBe("09:00 仕事始め");
    expect(memoBelow("2027-03-31")).toBe("年度末の締め");
    expect(memoBelow("2026-06-10")!.split("\n")).toHaveLength(10);
    const all = wb.sheets.flatMap((s) => textCells(s)).map((c) => c.text);
    expect(all.some((t) => t.includes("翌年度"))).toBe(false);
  });

  test("祝日名が各シートに出る（4・5月: 昭和の日・憲法記念日・みどりの日・こどもの日）", async () => {
    const wb = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2 }));
    const text = textCells(wb.sheets[0]).map((c) => c.text).join("|");
    for (const h of ["昭和の日", "憲法記念日", "みどりの日", "こどもの日"]) expect(text).toContain(h);
  });

  test("全デザイン×月曜/日曜始まり×前後の日付×予定で、Excelの構造検査（修復の原因）が0件", async () => {
    const choices: CalendarThemeChoice[] = [...CALENDAR_THEME_IDS, "custom"];
    for (const theme of choices)
      for (const ws of ["mon", "sun"] as const)
        for (const adj of [false, true]) {
          const bytes = await excelOf({ orientation: "portrait", mps: 2, theme, ws, adj, events: EVENTS });
          const report = validateXlsxStrict(bytes);
          expect(report.problems, `${theme}/${ws}/前後=${adj}`).toEqual([]);
          expect(report.sheetCount).toBe(6);
        }
  });

  test("年度（2020・2035・2050）でも、6シート・A4縦・構造検査0件", async () => {
    for (const fy of [2020, 2035, 2050]) {
      const bytes = await excelOf({ orientation: "portrait", mps: 2, fy });
      expect(validateXlsxStrict(bytes).problems, `${fy}年度`).toEqual([]);
      const wb = readXlsxWorkbook(bytes);
      expect(wb.sheets).toHaveLength(6);
      expect(wb.sheets.every((s) => s.pageSetup.orientation === "portrait")).toBe(true);
    }
  });

  test("デザインの色が反映される（縦向き2か月のタイトル帯・曜日見出しの塗りが、1か月縦と同じ配色）", async () => {
    const two = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 2, theme: "business" }));
    const one = readXlsxWorkbook(await excelOf({ orientation: "portrait", mps: 1, theme: "business" }));
    const fills = (w: ReturnType<typeof readXlsxWorkbook>) => new Set(w.styles.map((s) => s.fillColor).filter(Boolean));
    for (const c of fills(one)) expect(fills(two).has(c), `色 ${c}`).toBe(true);
  });

  test("1か月の出力は、今回の変更で変わらない（向き・前後の日付・予定の指定でも、同じ入力は同じ内容）", async () => {
    for (const orientation of ["landscape", "portrait"] as const) {
      const a = excelFingerprint(await excelOf({ orientation, mps: 1, events: EVENTS }));
      const b = excelFingerprint(await excelOf({ orientation, mps: 1, events: EVENTS }));
      expect(b).toEqual(a);
      const wb = readXlsxWorkbook(await excelOf({ orientation, mps: 1 }));
      expect(wb.sheets).toHaveLength(12);
      expect(wb.sheets.every((s) => s.pageSetup.orientation === orientation)).toBe(true);
      expect(Math.max(...[...wb.sheets[0].cells.values()].map((c) => c.col))).toBe(13);
    }
  });
});

test.describe("PDF: 2か月・A4縦（上下配置）", () => {
  const fontBytes = readFontBytes();
  const margin = (10 * 72) / 25.4;

  async function pdfOf(orientation: "landscape" | "portrait", events?: CalendarEvent[], ws: WeekStart = "mon", adj = false) {
    const cal = calendarOf(ws);
    const { blob, pageCount } = await buildCalendarPdf({
      calendar: cal,
      theme: CALENDAR_THEMES.business,
      orientation,
      showAdjacentDays: adj,
      monthsPerSheet: 2,
      events: events ? placeEvents(cal, events).byDate : undefined,
      fontBytes,
    });
    return { pageCount, pages: await extractTextBoxes(new Uint8Array(await blob.arrayBuffer())) };
  }
  const flat = (p: PageBoxes) => p.boxes.map((b) => b.str).join("").replace(/\s+/g, "");

  test("6ページ・すべてA4縦（595×842pt）", async () => {
    const { pageCount, pages } = await pdfOf("portrait");
    expect(pageCount).toBe(6);
    expect(pages).toHaveLength(6);
    for (const p of pages) {
      expect(p.width).toBeCloseTo(595.28, 1);
      expect(p.height).toBeCloseTo(841.89, 1);
    }
  });

  test("上に前の月・下に次の月（年度またぎの12月・1月を含む）。月見出しは同じ左端で、上の月が高い位置", async () => {
    const { pages } = await pdfOf("portrait", EVENTS);
    pages.forEach((page, i) => {
      const upper = page.boxes.find((b) => b.str.includes(TITLES[i][0]));
      const lower = page.boxes.find((b) => b.str.includes(TITLES[i][1]));
      expect(upper, `${i + 1}ページ 上の月`).toBeTruthy();
      expect(lower, `${i + 1}ページ 下の月`).toBeTruthy();
      expect(upper!.x).toBeCloseTo(lower!.x, 0);
      expect(upper!.y).toBeGreaterThan(lower!.y);
      // 上の月は上半分の最上部、下の月はページ中央より下
      expect(upper!.y).toBeGreaterThan(page.height - margin - 40);
      expect(lower!.y).toBeLessThan(page.height / 2);
      expect(lower!.y).toBeGreaterThan(margin);
    });
  });

  test("全文字が、ページの余白（10mm）の内側に収まる", async () => {
    for (const ws of ["mon", "sun"] as const) {
      const { pages } = await pdfOf("portrait", EVENTS, ws, ws === "sun");
      pages.forEach((page, i) => {
        for (const b of page.boxes) {
          expect(b.x, `${ws} ${i + 1}ページ: ${b.str}`).toBeGreaterThanOrEqual(margin - 0.5);
          expect(b.x + b.width, `${ws} ${i + 1}ページ: ${b.str}`).toBeLessThanOrEqual(page.width - margin + 0.5);
          expect(b.y, `${ws} ${i + 1}ページ: ${b.str}`).toBeGreaterThanOrEqual(margin - 1);
          expect(b.y + b.size, `${ws} ${i + 1}ページ: ${b.str}`).toBeLessThanOrEqual(page.height - margin + 1);
        }
      });
    }
  });

  test("祝日名・予定が載る（年度の外の予定は載らない）。同じ入力の横向きと、載っている文字が同じ", async () => {
    const port = await pdfOf("portrait", EVENTS);
    const land = await pdfOf("landscape", EVENTS);
    const text = port.pages.map(flat);
    expect(text[0]).toContain("昭和の日");
    expect(text[0]).toContain("みどりの日");
    expect(text[0]).toContain("入社式");
    expect(text[0]).toContain("みどりの日当番");
    expect(text[4]).toContain("仕事納め");
    expect(text[4]).toContain("仕事始め");
    expect(text[5]).toContain("年度末の締め");
    expect(text.join("")).not.toContain("翌年度");
    port.pages.forEach((p, i) => {
      const sortedChars = (t: string) => [...t].sort().join("");
      expect(sortedChars(flat(p)), `${i + 1}ページ`).toBe(sortedChars(flat(land.pages[i])));
    });
  });

  test("月見出しの間隔が、A4縦の半分ほど（約半ページ）になり、上下の枠が重ならない", async () => {
    const { pages } = await pdfOf("portrait", EVENTS);
    pages.forEach((page, i) => {
      const lowerTitle = page.boxes.find((b) => b.str.includes(TITLES[i][1]))!;
      const upperTitle = page.boxes.find((b) => b.str.includes(TITLES[i][0]))!;
      expect(upperTitle.y - lowerTitle.y).toBeGreaterThan(300);
      expect(upperTitle.y - lowerTitle.y).toBeLessThan(420);
    });
  });

  test("横向きの2か月PDFは従来どおり（A4横・左右）", async () => {
    const { pages } = await pdfOf("landscape");
    pages.forEach((page, i) => {
      expect(page.width).toBeCloseTo(841.89, 1);
      const left = page.boxes.find((b) => b.str.includes(TITLES[i][0]))!;
      const right = page.boxes.find((b) => b.str.includes(TITLES[i][1]))!;
      expect(left.x).toBeLessThan(right.x);
      expect(left.y).toBeCloseTo(right.y, 0);
    });
  });

  test("1か月のPDF（A4横・縦）は12ページのまま", async () => {
    const cal = calendarOf();
    for (const orientation of ["landscape", "portrait"] as const) {
      const { pageCount, blob } = await buildCalendarPdf({ calendar: cal, theme: CALENDAR_THEMES.business, orientation, monthsPerSheet: 1, fontBytes });
      expect(pageCount).toBe(12);
      const pages = await extractTextBoxes(new Uint8Array(await blob.arrayBuffer()));
      expect(pages).toHaveLength(12);
      expect(pages[0].width).toBeCloseTo(orientation === "landscape" ? 841.89 : 595.28, 1);
    }
  });
});

test.describe("Processor（画面と同じ処理）", () => {
  test("縦向きの2か月: Excelは6シート・A4縦、ページ数は6、ファイル名は「_縦_2か月」", async () => {
    const processor = new FiscalCalendarProcessor();
    const input = { fiscalYear: 2026, weekStart: "mon", theme: "business", orientation: "portrait", showAdjacentDays: false, monthsPerSheet: 2, events: EVENTS, format: "excel" } as const;
    const out = await processor.process(input);
    expect(out.pageCount).toBe(6);
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    expect(validateXlsxStrict(bytes).problems).toEqual([]);
    const wb = readXlsxWorkbook(bytes);
    expect(wb.sheets.every((s) => s.pageSetup.orientation === "portrait")).toBe(true);
    // 同じ入力で作り直すと同じ内容
    const again = await processor.process(input);
    expect(excelFingerprint(new Uint8Array(await again.blob.arrayBuffer()))).toEqual(excelFingerprint(bytes));
  });

  test("グループ分けは、向きに関わらず同じ（4+5, 6+7, 8+9, 10+11, 12+1, 2+3）", () => {
    const cal = calendarOf();
    const names = groupMonths(cal, 2).map((g) => g.map((m) => `${m.year}-${m.month}`).join("/"));
    expect(names).toEqual(["2026-4/2026-5", "2026-6/2026-7", "2026-8/2026-9", "2026-10/2026-11", "2026-12/2027-1", "2027-2/2027-3"]);
  });
});
