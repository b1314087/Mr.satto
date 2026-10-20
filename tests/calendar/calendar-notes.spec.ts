import { test, expect } from "@playwright/test";
import { addressOf, readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { extractTextBoxes, readFontBytes } from "../helpers/pdf-text-boxes";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import {
  ESTIMATED_AND_STATUTORY_NOTE,
  ESTIMATED_MARK,
  ESTIMATED_NOTE,
  STATUTORY_NOTE,
  buildFiscalCalendar,
  holidayDisplayName,
  monthNote,
} from "@/lib/calendar/model";
import { CONFIRMED_THROUGH_YEAR } from "@/lib/calendar/holiday-data";
import { getHolidays } from "@/lib/calendar/holidays";
import { CALENDAR_THEMES } from "@/lib/calendar/themes";

/**
 * 「確定」「法律どおり」「推定」の区別（2028年以降の表示）の仕様テスト。
 *   - 確定（公式CSVのある2027年まで）: ※なし・注記なし
 *   - 法律どおり（2028年以降の、日付が祝日法だけで決まる祝日）: ※は付けない。月の注記で、法改正で変わりうることを知らせる
 *   - 推定（2028年以降の春分の日・秋分の日と、それに伴う振替休日・国民の休日）: ※を付ける
 * 画面・Excel・PDFは同じ monthNote() を使うため、3つの出力で注記の出る月が一致することも確かめる。
 */

test.describe("確度の区別（エンジン）", () => {
  test("2027年までは全祝日が確定。2028年以降は、春分・秋分と、それに伴う日だけが推定", () => {
    for (let y = 2000; y <= CONFIRMED_THROUGH_YEAR; y++) {
      expect(getHolidays(y).every((h) => h.status === "confirmed"), `${y}`).toBe(true);
    }
    for (let y = CONFIRMED_THROUGH_YEAR + 1; y <= 2099; y++) {
      const hs = getHolidays(y);
      for (const h of hs) {
        if (h.status === "confirmed") throw new Error(`${h.iso} が確定扱いになっている`);
        if (h.status === "estimated") {
          const equinoxRelated =
            h.name === "春分の日" || h.name === "秋分の日" || h.kind === "substitute" || h.kind === "citizens";
          expect(equinoxRelated, `${h.iso} ${h.name} が推定扱い`).toBe(true);
        }
      }
      // 春分・秋分は必ず推定
      expect(hs.find((h) => h.name === "春分の日")?.status, `${y}春分`).toBe("estimated");
      expect(hs.find((h) => h.name === "秋分の日")?.status, `${y}秋分`).toBe("estimated");
      // 元日・憲法記念日・文化の日などは、法律どおり（推定ではない）
      for (const n of ["元日", "成人の日", "建国記念の日", "天皇誕生日", "昭和の日", "憲法記念日", "みどりの日", "こどもの日", "海の日", "山の日", "敬老の日", "スポーツの日", "文化の日", "勤労感謝の日"]) {
        expect(hs.find((h) => h.name === n)?.status, `${y}${n}`).toBe("statutory");
      }
    }
  });

  test("推定の日だけに※が付く（2028年は、春分の日と、秋分の日の前後のうち推定の日だけ）", () => {
    const names = getHolidays(2028).map((h) => `${h.iso}:${holidayDisplayName({ holiday: h } as never)}`);
    expect(names).toContain(`2028-03-20:春分の日${ESTIMATED_MARK}`);
    expect(names).toContain("2028-01-01:元日");
    expect(names).toContain("2028-05-03:憲法記念日");
    expect(names.filter((n) => n.includes(ESTIMATED_MARK)).length).toBe(
      getHolidays(2028).filter((h) => h.status === "estimated").length,
    );
  });

  test("2027年と2028年の境界: 2027年12月31日までは確定、2028年1月1日からは法律どおり", () => {
    const cal = buildFiscalCalendar({ fiscalYear: 2027, weekStart: "mon" });
    const all = cal.months.flatMap((m) => m.holidays);
    const statusOf = (iso: string) => all.find((d) => d.iso === iso)?.holiday?.status;
    expect(statusOf("2027-11-23")).toBe("confirmed");
    expect(statusOf("2028-01-01")).toBe("statutory");
    expect(statusOf("2028-01-10")).toBe("statutory");
    expect(statusOf("2028-03-20")).toBe("estimated");
    // 2027年内の祝日に、法律どおり・推定は1つもない
    expect(all.filter((d) => d.year === 2027).every((d) => d.holiday?.status === "confirmed")).toBe(true);
  });
});

test.describe("月の注記（monthNote）", () => {
  test("確定のみ→注記なし／法律どおり→法改正の注記／推定を含む→※の注記／両方→両方を伝える注記", () => {
    expect(monthNote({ hasEstimatedHoliday: false, hasStatutoryHoliday: false })).toBeNull();
    expect(monthNote({ hasEstimatedHoliday: false, hasStatutoryHoliday: true })).toBe(STATUTORY_NOTE);
    expect(monthNote({ hasEstimatedHoliday: true, hasStatutoryHoliday: false })).toBe(ESTIMATED_NOTE);
    expect(monthNote({ hasEstimatedHoliday: true, hasStatutoryHoliday: true })).toBe(ESTIMATED_AND_STATUTORY_NOTE);
  });

  test("注記の文面: 推定日を『確定』と呼ばず、法改正の可能性に触れる", () => {
    for (const n of [ESTIMATED_NOTE, STATUTORY_NOTE, ESTIMATED_AND_STATUTORY_NOTE]) expect(n).not.toContain("確定した");
    expect(ESTIMATED_NOTE).toContain("推定");
    expect(STATUTORY_NOTE).toContain("法改正");
    expect(ESTIMATED_AND_STATUTORY_NOTE).toContain("推定");
    expect(ESTIMATED_AND_STATUTORY_NOTE).toContain("法改正");
  });

  test("年度ごとの、注記が出る月（2026年度は無し、2027年度は1〜3月、2028年度は全月のうち祝日のある月）", () => {
    const notesOf = (fy: number) => buildFiscalCalendar({ fiscalYear: fy, weekStart: "mon" }).months.map((m) => !!monthNote(m));
    expect(notesOf(2026)).toEqual(Array(12).fill(false));
    expect(notesOf(2027)).toEqual([...Array(9).fill(false), true, true, true]);
    const fy28 = buildFiscalCalendar({ fiscalYear: 2028, weekStart: "sun" }).months;
    // 祝日のある月は必ず注記が出て、祝日のない月（6月）には出ない
    for (const m of fy28) expect(!!monthNote(m), `${m.year}年${m.month}月`).toBe(m.holidays.length > 0);
    expect(fy28.find((m) => m.month === 6)?.holidays.length).toBe(0);
  });
});

for (const fy of [2026, 2027, 2028] as const) {
  test(`${fy}年度: 画面と同じ注記が、Excelの月シートとPDFの月ページに（出る月にだけ）出る`, async () => {
    const calendar = buildFiscalCalendar({ fiscalYear: fy, weekStart: "mon" });
    const wb = readXlsxWorkbook(
      new Uint8Array(await (await buildCalendarExcel({ calendar, theme: CALENDAR_THEMES.business, orientation: "landscape" })).arrayBuffer()),
    );
    const pdf = await buildCalendarPdf({ calendar, theme: CALENDAR_THEMES.natural, orientation: "portrait", fontBytes: readFontBytes() });
    const pages = await extractTextBoxes(new Uint8Array(await pdf.blob.arrayBuffer()));
    const noteTexts = [ESTIMATED_NOTE, STATUTORY_NOTE, ESTIMATED_AND_STATUTORY_NOTE];

    calendar.months.forEach((m, i) => {
      const expected = monthNote(m);
      const excelNotes = [...wb.sheets[i].cells.values()].filter((c) => typeof c.value === "string" && noteTexts.includes(c.value)).map((c) => c.value);
      const pdfNoteBoxes = pages[i].boxes.filter((b) => noteTexts.includes(b.str));
      const pdfNotes = pdfNoteBoxes.map((b) => b.str);
      // PDFの注記は、左右の余白（10mm）の内側に1行で収まる
      const margin = (10 * 72) / 25.4;
      for (const b of pdfNoteBoxes) {
        expect(b.x, `PDF注記の左端 ${m.year}年${m.month}月`).toBeGreaterThanOrEqual(margin - 0.5);
        expect(b.x + b.width, `PDF注記の右端 ${m.year}年${m.month}月`).toBeLessThanOrEqual(pages[i].width - margin + 0.5);
      }
      expect(excelNotes, `Excel ${m.year}年${m.month}月`).toEqual(expected ? [expected] : []);
      expect(pdfNotes, `PDF ${m.year}年${m.month}月`).toEqual(expected ? [expected] : []);
      // 注記は、日付や祝日名のセルと別のセル（注記行）にある
      if (expected) {
        const cell = [...wb.sheets[i].cells.values()].find((c) => c.value === expected)!;
        expect(cell.col, "注記は左端のセルから").toBe(0);
        expect(addressOf(cell.row, cell.col).startsWith("A")).toBe(true);
      }
    });

    // ※の付く祝日名の数が、Excel・PDF・モデルで一致する
    const modelMarked = calendar.months.flatMap((m) => m.holidays).filter((d) => d.holiday?.status === "estimated").length;
    const excelMarked = wb.sheets.flatMap((s) => [...s.cells.values()]).filter((c) => typeof c.value === "string" && c.value.endsWith(ESTIMATED_MARK) && c.value.length <= 8).length;
    const pdfMarked = pages.flatMap((p) => p.boxes).filter((b) => b.str.endsWith(ESTIMATED_MARK) && b.str.length <= 8).length;
    expect(excelMarked).toBe(modelMarked);
    expect(pdfMarked).toBe(modelMarked);
  });
}
