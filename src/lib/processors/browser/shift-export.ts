import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { csvRowsToBlob } from "@/lib/utils/csv";
import {
  colorHex,
  formatDuration,
  monthDays,
  resizeCells,
  summarize,
  timingOf,
  formatTime,
  type ShiftSchedule,
  type ShiftType,
} from "@/lib/shift/model";

/**
 * シフト表（勤務表）の出力（Excel・PDF・CSV）。ブラウザ内だけで作る（名前は外部に送らない）。
 * - Excel: 「シフト表」シート（色つき。右に出勤日数・休日数・未入力・実働時間、下に日ごとの出勤人数）と「凡例」シート。
 * - PDF: A4横。1ページに収まらない人数は、ページを分ける。
 * - CSV: 1行が1人（UTF-8・BOM付き）。
 */

export function shiftTitle(schedule: ShiftSchedule): string {
  const t = schedule.title.trim();
  return t === "" ? `${schedule.year}年${schedule.month}月 シフト表` : t;
}

/** CSVをExcelで開いたときに、数式として実行されないようにする（=, +, -, @ で始まる文字の前に ' を付ける） */
function csvSafe(text: string): string {
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function typeTimeText(type: ShiftType): string {
  if (type.kind === "off") return "休み（実働に含めない）";
  const t = timingOf(type);
  if (!t) return "時刻の入力に不備があります";
  const start = formatTime(t.startMinutes);
  const end = t.overnight ? `翌${formatTime(t.endMinutes - 1440)}` : t.endMinutes === 1440 ? "24:00" : formatTime(t.endMinutes);
  return `${start}〜${end}（休憩${type.breakMinutes}分・実働${formatDuration(t.netMinutes)}）`;
}

interface Row {
  name: string;
  codes: string[];
  workDays: number;
  offDays: number;
  blankDays: number;
  duration: string;
}

function buildRows(schedule: ShiftSchedule): { rows: Row[]; perDay: number[] } {
  const days = monthDays(schedule.year, schedule.month).length;
  const typeById = new Map(schedule.types.map((t) => [t.id, t]));
  const sum = summarize(schedule);
  const rows = schedule.staff.map((s, i) => {
    const cells = resizeCells(schedule.cells[s.id], days);
    return {
      name: s.name.trim(),
      codes: cells.map((id) => (id === null ? "" : (typeById.get(id)?.code.trim() ?? ""))),
      workDays: sum.perStaff[i].workDays,
      offDays: sum.perStaff[i].offDays,
      blankDays: sum.perStaff[i].blankDays,
      duration: formatDuration(sum.perStaff[i].workMinutes),
    };
  });
  return { rows, perDay: sum.perDay.map((d) => d.working) };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
export function shiftToCsvBlob(schedule: ShiftSchedule): Blob {
  const days = monthDays(schedule.year, schedule.month);
  const { rows, perDay } = buildRows(schedule);
  const header = ["氏名", ...days.map((d) => `${d.day}日(${d.weekdayLabel})`), "出勤日数", "休日数", "未入力", "実働時間"];
  const body = rows.map((r) => [csvSafe(r.name), ...r.codes.map(csvSafe), String(r.workDays), String(r.offDays), String(r.blankDays), r.duration]);
  const footer = ["出勤人数", ...perDay.map(String), "", "", "", ""];
  return csvRowsToBlob([header, ...body, footer]);
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------
const BORDER = { borderColor: "#9CA3AF", borderStyle: "thin" } as const;

export async function shiftToXlsxBlob(schedule: ShiftSchedule): Promise<Blob> {
  const days = monthDays(schedule.year, schedule.month);
  const typeByCode = new Map(schedule.types.map((t) => [t.code.trim(), t]));
  const { rows, perDay } = buildRows(schedule);
  const cell = (value: string | number | null, extra: Record<string, unknown> = {}) => ({ value, align: "center", alignVertical: "center", ...BORDER, ...extra });

  const dayHeader = days.map((d) => {
    const bg = d.holiday !== null || d.weekday === 0 ? "#FECACA" : d.weekday === 6 ? "#BFDBFE" : "#F3F4F6";
    return cell(`${d.day}\n${d.weekdayLabel}`, { backgroundColor: bg, fontWeight: "bold", wrap: true });
  });
  const sumHeader = ["出勤日数", "休日数", "未入力", "実働時間"].map((t) => cell(t, { backgroundColor: "#E5E7EB", fontWeight: "bold" }));
  const titleRow = [{ value: shiftTitle(schedule), fontWeight: "bold", fontSize: 14 }];
  const sheetRows: unknown[][] = [titleRow, [], [cell("氏名", { backgroundColor: "#E5E7EB", fontWeight: "bold" }), ...dayHeader, ...sumHeader]];
  for (const r of rows) {
    sheetRows.push([
      cell(r.name, { align: "left" }),
      ...r.codes.map((code) => {
        const type = typeByCode.get(code);
        return cell(code === "" ? null : code, type ? { backgroundColor: colorHex(type.color) } : {});
      }),
      cell(r.workDays),
      cell(r.offDays),
      cell(r.blankDays),
      cell(r.duration),
    ]);
  }
  sheetRows.push([cell("出勤人数", { backgroundColor: "#E5E7EB", fontWeight: "bold" }), ...perDay.map((n) => cell(n, { backgroundColor: "#F3F4F6" })), cell(null), cell(null), cell(null), cell(null)]);

  const legendRows: unknown[][] = [
    ["略称", "名前", "種類", "時間"].map((t) => cell(t, { backgroundColor: "#E5E7EB", fontWeight: "bold" })),
    ...schedule.types.map((t) => [
      cell(t.code.trim(), { backgroundColor: colorHex(t.color) }),
      cell(t.name.trim(), { align: "left" }),
      cell(t.kind === "work" ? "勤務" : "休み"),
      cell(typeTimeText(t), { align: "left" }),
    ]),
  ];

  return writeXlsxSheets([
    {
      name: "シフト表",
      rows: sheetRows,
      columns: [{ width: 16 }, ...days.map(() => ({ width: 4.5 })), { width: 9 }, { width: 8 }, { width: 8 }, { width: 11 }],
    },
    { name: "凡例", rows: legendRows, columns: [{ width: 8 }, { width: 18 }, { width: 8 }, { width: 44 }] },
  ]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
const PAGE_W = 841.89; // A4横
const PAGE_H = 595.28;
const MARGIN = 28;
const INK: [number, number, number] = [0.13, 0.13, 0.15];
const MUTED: [number, number, number] = [0.45, 0.45, 0.5];
const LINE: [number, number, number] = [0.6, 0.6, 0.65];
const HEAD_BG: [number, number, number] = [0.93, 0.94, 0.96];
const SUN_BG: [number, number, number] = [0.99, 0.82, 0.82];
const SAT_BG: [number, number, number] = [0.8, 0.88, 0.99];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): number {
  const w = font.widthOfTextAtSize(text, size);
  return w <= maxWidth ? size : Math.max(4, (size * maxWidth) / w);
}

/** 1ページに載せる人数の上限（行が細くなりすぎないように） */
export const SHIFT_PDF_ROWS_PER_PAGE = 30;

export async function shiftToPdfBlob(schedule: ShiftSchedule): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadJapaneseFontBytes(), { subset: false });
  const days = monthDays(schedule.year, schedule.month);
  const typeByCode = new Map(schedule.types.map((t) => [t.code.trim(), t]));
  const { rows, perDay } = buildRows(schedule);

  const nameW = 78;
  const sumW = [34, 30, 30, 42];
  const dayW = (PAGE_W - MARGIN * 2 - nameW - sumW.reduce((a, b) => a + b, 0)) / days.length;
  const headH = 26;
  const chunks: Row[][] = [];
  for (let i = 0; i < rows.length; i += SHIFT_PDF_ROWS_PER_PAGE) chunks.push(rows.slice(i, i + SHIFT_PDF_ROWS_PER_PAGE));
  if (chunks.length === 0) chunks.push([]);
  const legendH = 18;

  chunks.forEach((chunk, pageIndex) => {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const title = shiftTitle(schedule);
    page.drawText(title, { x: MARGIN, y: PAGE_H - MARGIN - 14, size: fit(title, font, 16, PAGE_W - MARGIN * 2 - 70), font, color: rgb(...INK) });
    page.drawText(`${pageIndex + 1} / ${chunks.length}`, { x: PAGE_W - MARGIN - 36, y: PAGE_H - MARGIN - 12, size: 9, font, color: rgb(...MUTED) });

    const top = PAGE_H - MARGIN - 30;
    const isLast = pageIndex === chunks.length - 1;
    const footerRows = isLast ? 1 : 0;
    const available = top - headH - MARGIN - legendH - 6;
    const rowH = Math.min(20, available / (chunk.length + footerRows || 1));
    const fs = Math.min(9, rowH * 0.62);

    const cellBox = (x: number, y: number, w: number, h: number, bg?: [number, number, number]) =>
      page.drawRectangle({ x, y, width: w, height: h, color: bg ? rgb(...bg) : undefined, borderColor: rgb(...LINE), borderWidth: 0.4 });
    const center = (text: string, x: number, y: number, w: number, h: number, size: number) => {
      const s = fit(text, font, size, w - 2);
      page.drawText(text, { x: x + (w - font.widthOfTextAtSize(text, s)) / 2, y: y + (h - s) / 2 + s * 0.12, size: s, font, color: rgb(...INK) });
    };

    // 見出し
    let x = MARGIN;
    cellBox(x, top - headH, nameW, headH, HEAD_BG);
    center("氏名", x, top - headH, nameW, headH, 9);
    x += nameW;
    days.forEach((d) => {
      const bg = d.holiday !== null || d.weekday === 0 ? SUN_BG : d.weekday === 6 ? SAT_BG : HEAD_BG;
      cellBox(x, top - headH, dayW, headH, bg);
      center(String(d.day), x, top - headH / 2, dayW, headH / 2, 7.5);
      center(d.weekdayLabel, x, top - headH, dayW, headH / 2, 7.5);
      x += dayW;
    });
    ["出勤", "休日", "未入力", "実働"].forEach((t, i) => {
      cellBox(x, top - headH, sumW[i], headH, HEAD_BG);
      center(t, x, top - headH, sumW[i], headH, 7.5);
      x += sumW[i];
    });

    // 本体
    chunk.forEach((r, ri) => {
      const y = top - headH - (ri + 1) * rowH;
      let cx = MARGIN;
      cellBox(cx, y, nameW, rowH);
      const ns = fit(r.name, font, fs, nameW - 6);
      page.drawText(r.name, { x: cx + 3, y: y + (rowH - ns) / 2 + ns * 0.12, size: ns, font, color: rgb(...INK) });
      cx += nameW;
      r.codes.forEach((code) => {
        const type = typeByCode.get(code);
        cellBox(cx, y, dayW, rowH, type ? hexToRgb(colorHex(type.color)) : undefined);
        if (code !== "") center(code, cx, y, dayW, rowH, fs);
        cx += dayW;
      });
      [String(r.workDays), String(r.offDays), String(r.blankDays), r.duration].forEach((t, i) => {
        cellBox(cx, y, sumW[i], rowH);
        center(t, cx, y, sumW[i], rowH, fs);
        cx += sumW[i];
      });
    });

    // 出勤人数（最後のページ）
    let bottom = top - headH - chunk.length * rowH;
    if (isLast) {
      const y = bottom - rowH;
      let cx = MARGIN;
      cellBox(cx, y, nameW, rowH, HEAD_BG);
      center("出勤人数", cx, y, nameW, rowH, fs);
      cx += nameW;
      perDay.forEach((n) => {
        cellBox(cx, y, dayW, rowH, HEAD_BG);
        center(String(n), cx, y, dayW, rowH, fs);
        cx += dayW;
      });
      bottom = y;
    }

    // 凡例
    let lx = MARGIN;
    const ly = bottom - legendH;
    for (const t of schedule.types) {
      const label = `${t.code.trim()} ${t.name.trim()}${t.kind === "work" ? ` ${timingOf(t) ? typeTimeText(t).split("（")[0] : ""}` : ""}`;
      const s = 7.5;
      const w = font.widthOfTextAtSize(label, s) + 18;
      if (lx + w > PAGE_W - MARGIN) break;
      page.drawRectangle({ x: lx, y: ly + 3, width: 10, height: 10, color: rgb(...hexToRgb(colorHex(t.color))), borderColor: rgb(...LINE), borderWidth: 0.4 });
      page.drawText(label, { x: lx + 14, y: ly + 5, size: s, font, color: rgb(...INK) });
      lx += w + 6;
    }
  });

  const bytes = await doc.save();
  return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), pageCount: chunks.length };
}
