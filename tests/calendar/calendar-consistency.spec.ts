import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { addressOf, excelSerialToIso, readXlsxWorkbook } from "../helpers/xlsx-workbook";
import { extractTextBoxes, readFontBytes, type PageBoxes, type TextBox } from "../helpers/pdf-text-boxes";
import { buildCalendarExcel } from "@/lib/calendar/excel";
import { buildCalendarPdf } from "@/lib/calendar/pdf";
import { buildFiscalCalendar, type WeekStart } from "@/lib/calendar/model";
import { CALENDAR_THEMES } from "@/lib/calendar/themes";

/**
 * ExcelとPDFの内容一致テスト（年度カレンダー 工程C）。
 * 同じ年度・週の始まりで作ったExcelとPDFを、それぞれ別の方法で読み取り、
 * 「どの月の何日に、どの祝日名が付いているか」「曜日見出しの並び」が1日ずつ一致することを確かめる。
 * 日付の位置は、どちらも Python標準calendar の参照データ（calendar-grid-reference.json）で決める。
 */

const grid = JSON.parse(
  fs.readFileSync(path.join(fixtures.dir.static, "calendar-grid-reference.json"), "utf-8"),
) as Record<string, [string, number]>;

const MARGIN = (10 * 72) / 25.4;
const TITLE_H = 34;
const HEADER_H = 20;
const NOTE_H = 16;

function dayOffset(startIso: string, days: number): string {
  return new Date(Date.parse(`${startIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function cellOf(page: PageBoxes, weeks: number, box: TextBox) {
  const cellW = (page.width - MARGIN * 2) / 7;
  const rowH = (page.height - MARGIN * 2 - TITLE_H - HEADER_H - NOTE_H) / weeks;
  const gridTop = page.height - MARGIN - TITLE_H - HEADER_H;
  return { col: Math.floor((box.x - MARGIN) / cellW), row: Math.floor((gridTop - box.y) / rowH) };
}

/** PDFから「日付→祝日名（なければ空）」の対応を読み取る */
function readPdfDays(pages: PageBoxes[], fy: number, ws: WeekStart): Map<string, string> {
  const out = new Map<string, string>();
  pages.forEach((p, i) => {
    const m = ((3 + i) % 12) + 1;
    const y = i < 9 ? fy : fy + 1;
    const [start, weeks] = grid[`${y}-${m}-${ws}`];
    const cells = p.boxes.filter((b) => {
      const c = cellOf(p, weeks, b);
      return c.row >= 0 && c.row < weeks;
    });
    for (const n of cells.filter((b) => /^\d{1,2}$/.test(b.str) && b.size >= 13)) {
      const c = cellOf(p, weeks, n);
      const idx = c.row * 7 + c.col;
      const iso = dayOffset(start, idx);
      const name = cells
        .filter((b) => b !== n && b.size < 12 && cellOf(p, weeks, b).row === c.row && cellOf(p, weeks, b).col === c.col)
        .sort((a, b) => b.y - a.y)
        .map((b) => b.str)
        .join("");
      out.set(iso, name);
    }
  });
  return out;
}

/** Excelから「日付→祝日名（なければ空）」の対応を読み取る */
function readExcelDays(wb: ReturnType<typeof readXlsxWorkbook>): Map<string, string> {
  const out = new Map<string, string>();
  for (const sheet of wb.sheets) {
    for (const cell of sheet.cells.values()) {
      if (cell.col % 2 !== 0 || cell.row < 2 || typeof cell.value !== "number") continue;
      const name = sheet.cells.get(addressOf(cell.row, cell.col + 1))?.value;
      out.set(excelSerialToIso(cell.value), typeof name === "string" ? name : "");
    }
  }
  return out;
}

for (const [fy, ws] of [[2026, "mon"], [2026, "sun"], [2027, "mon"], [2027, "sun"], [2023, "mon"]] as const) {
  test(`ExcelとPDFが1日ずつ一致する: ${fy}年度・${ws === "mon" ? "月曜" : "日曜"}始まり`, async () => {
    const calendar = buildFiscalCalendar({ fiscalYear: fy, weekStart: ws });
    const excelBlob = await buildCalendarExcel({ calendar, theme: CALENDAR_THEMES.business, orientation: "landscape" });
    const pdf = await buildCalendarPdf({ calendar, theme: CALENDAR_THEMES.natural, orientation: "portrait", fontBytes: readFontBytes() });

    const wb = readXlsxWorkbook(new Uint8Array(await excelBlob.arrayBuffer()));
    const pages = await extractTextBoxes(new Uint8Array(await pdf.blob.arrayBuffer()));

    const excelDays = readExcelDays(wb);
    const pdfDays = readPdfDays(pages, fy, ws);

    // 年度の全日（4/1〜翌3/31）がちょうど1回ずつ
    const first = `${fy}-04-01`;
    const last = `${fy + 1}-03-31`;
    const total = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000) + 1;
    expect(excelDays.size).toBe(total);
    expect(pdfDays.size).toBe(total);
    expect([...excelDays.keys()].sort()[0]).toBe(first);
    expect([...excelDays.keys()].sort().at(-1)).toBe(last);

    const diffs: string[] = [];
    for (const [iso, name] of excelDays) {
      if (!pdfDays.has(iso)) diffs.push(`${iso}: PDFに無い`);
      else if (pdfDays.get(iso) !== name) diffs.push(`${iso}: Excel=「${name}」 PDF=「${pdfDays.get(iso)}」`);
    }
    expect(diffs).toEqual([]);
    // 祝日が1つ以上あり、空でない祝日名の数が同じ
    const holidaysInExcel = [...excelDays.values()].filter(Boolean).length;
    expect(holidaysInExcel).toBeGreaterThan(10);
    expect([...pdfDays.values()].filter(Boolean).length).toBe(holidaysInExcel);

    // 曜日見出しの並びも一致する
    const excelHeader = [0, 2, 4, 6, 8, 10, 12].map((c) => wb.sheets[0].cells.get(addressOf(1, c))?.value);
    const pdfHeaderY = pages[0].height - MARGIN - TITLE_H - HEADER_H + 6;
    const pdfHeader = pages[0].boxes.filter((b) => Math.abs(b.y - pdfHeaderY) < 1).sort((a, b) => a.x - b.x).map((b) => b.str);
    expect(pdfHeader).toEqual(excelHeader);
  });
}
