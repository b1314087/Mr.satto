/**
 * 年度カレンダーのExcel出力（月別12シート）。
 *
 * 1シート=1か月。1日につき2列（日付の数字・祝日名）を使い、1週ごとに2行
 * （日付と祝日名の行、予定を書く行）を並べる。予定を書く行は2列を結合した1つのセルで、
 * ここに文字を入力しても日付や祝日名は消えない。日付のセルは本物の日付（表示形式「d」）。
 *
 * 印刷設定（A4・向き・余白・印刷範囲・1ページに収める・水平中央）は、write-excel-file の
 * 「feature」（XMLを書き換える、ライブラリ公式の拡張の仕組み）で出力する。新しい依存は追加しない。
 */
import type { Feature as WriteExcelFeature } from "write-excel-file/universal";

type Feature = WriteExcelFeature<Blob>;
import { mmToExcelColumnWidth } from "@/lib/excel/xlsx-simple-io";
import { holidayDisplayName, ESTIMATED_NOTE, type CalendarDay, type CalendarMonth, type FiscalCalendar } from "./model";
import type { CalendarTheme } from "./themes";

export type CalendarOrientation = "landscape" | "portrait";

export interface CalendarExcelOptions {
  calendar: FiscalCalendar;
  theme: CalendarTheme;
  orientation: CalendarOrientation;
  /** 前後の月の日付を薄く表示するか（既定は空欄） */
  showAdjacentDays?: boolean;
}

/** A4の用紙サイズ(mm)と、印刷の余白(mm)。余白は上下左右とも同じ */
export const A4_MM = { width: 210, height: 297 } as const;
export const PRINT_MARGIN_MM = 10;
const MM_TO_INCH = 1 / 25.4;
const MM_TO_PT = 72 / 25.4;

/** 列の割り当て: 曜日ごとに「日付の数字」「祝日名」の2列 */
export const COLUMNS_PER_DAY = 2;
export const COLUMN_COUNT = 7 * COLUMNS_PER_DAY;

/** 行の高さ(pt) */
const TITLE_ROW_PT = 30;
const HEADER_ROW_PT = 18;
const DATE_ROW_PT = 20;
const NOTE_ROW_PT = 14;
/** 予定欄の高さの上限(pt)。週数の少ない月で縦に伸びすぎないようにする */
const MEMO_MAX_PT = { landscape: 90, portrait: 120 } as const;
/** 用紙の高さに対して使う割合（Excelの表示差でページからはみ出さないための余裕） */
const HEIGHT_SAFETY = 0.97;

const SHEET_NAME_FOR_MONTH = (month: number) => `${month}月`;

export interface MonthSheetGeometry {
  /** 列幅(mm)。[日付の数字, 祝日名] を7日分くり返す */
  numberColumnMm: number;
  nameColumnMm: number;
  memoRowPt: number;
  /** 行の位置（0始まり） */
  titleRow: number;
  headerRow: number;
  firstWeekRow: number;
  noteRow: number;
  rowCount: number;
}

export function monthSheetGeometry(weekCount: number, orientation: CalendarOrientation): MonthSheetGeometry {
  const pageWidthMm = (orientation === "landscape" ? A4_MM.height : A4_MM.width) - PRINT_MARGIN_MM * 2;
  const pageHeightPt =
    ((orientation === "landscape" ? A4_MM.width : A4_MM.height) - PRINT_MARGIN_MM * 2) * MM_TO_PT * HEIGHT_SAFETY;
  const dayMm = pageWidthMm / 7;
  const numberColumnMm = orientation === "landscape" ? 9 : 8;
  const fixedPt = TITLE_ROW_PT + HEADER_ROW_PT + NOTE_ROW_PT;
  const memoRowPt = Math.min(
    MEMO_MAX_PT[orientation],
    Math.floor((pageHeightPt - fixedPt) / weekCount - DATE_ROW_PT),
  );
  return {
    numberColumnMm,
    nameColumnMm: dayMm - numberColumnMm,
    memoRowPt,
    titleRow: 0,
    headerRow: 1,
    firstWeekRow: 2,
    noteRow: 2 + weekCount * 2,
    rowCount: 3 + weekCount * 2,
  };
}

/** 列の位置（0始まり）→ Excelの列記号 */
export function excelColumnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 印刷範囲（例: A1:N16） */
export function printAreaOf(weekCount: number, orientation: CalendarOrientation): string {
  const g = monthSheetGeometry(weekCount, orientation);
  return `A1:${excelColumnLetter(COLUMN_COUNT - 1)}${g.rowCount}`;
}

type CellInput = Record<string, unknown> | null;

function monthRows(
  month: CalendarMonth,
  cal: FiscalCalendar,
  theme: CalendarTheme,
  orientation: CalendarOrientation,
  showAdjacentDays: boolean,
): CellInput[][] {
  const g = monthSheetGeometry(month.weeks.length, orientation);
  const landscape = orientation === "landscape";
  const line = { borderStyle: "thin", borderColor: theme.border } as const;
  const rows: CellInput[][] = [];

  // タイトル行: 左に「2026年4月」、右に和暦と年度
  rows.push([
    {
      value: `${month.year}年${month.month}月`,
      columnSpan: 10,
      height: TITLE_ROW_PT,
      fontSize: landscape ? 20 : 18,
      fontWeight: "bold",
      textColor: theme.titleText,
      backgroundColor: theme.titleBg,
      align: "left",
      alignVertical: "center",
    },
    ...Array<null>(9).fill(null),
    {
      value: `${month.eraLabel}　${cal.fiscalYear}年度`,
      columnSpan: 4,
      height: TITLE_ROW_PT,
      fontSize: landscape ? 11 : 10,
      textColor: theme.titleText,
      backgroundColor: theme.titleBg,
      align: "right",
      alignVertical: "center",
    },
    ...Array<null>(3).fill(null),
  ]);

  // 曜日の見出し行
  const header: CellInput[] = [];
  cal.weekdayOrder.forEach((weekday, c) => {
    const text = weekday === 6 ? theme.headerSaturdayText : weekday === 0 ? theme.headerSundayText : theme.headerText;
    header.push(
      {
        value: cal.weekdayLabels[c],
        columnSpan: COLUMNS_PER_DAY,
        height: HEADER_ROW_PT,
        fontSize: 11,
        fontWeight: "bold",
        textColor: text,
        backgroundColor: theme.headerBg,
        align: "center",
        alignVertical: "center",
        ...line,
      },
      null,
    );
  });
  rows.push(header);

  // 週ごとに「日付と祝日名」「予定欄」の2行
  for (const week of month.weeks) {
    const dateRow: CellInput[] = [];
    const memoRow: CellInput[] = [];
    for (const day of week) {
      const shown = day.inMonth || showAdjacentDays;
      const faded = !day.inMonth;
      const bg = faded ? theme.outOfMonthBg : theme.dayBg[day.kind];
      const memoBg = faded ? theme.memoOutOfMonthBg : theme.memoBg;
      dateRow.push(
        shown
          ? {
              value: new Date(Date.UTC(day.year, day.month - 1, day.day)),
              format: "d",
              height: DATE_ROW_PT,
              fontSize: landscape ? 12 : 11,
              fontWeight: day.inMonth ? "bold" : undefined,
              textColor: faded ? theme.noteText : theme.dayText[day.kind],
              backgroundColor: bg,
              align: "center",
              alignVertical: "center",
              ...line,
            }
          : { value: null, height: DATE_ROW_PT, backgroundColor: bg, ...line },
        {
          value: day.inMonth ? holidayDisplayName(day) || null : null,
          height: DATE_ROW_PT,
          fontSize: landscape ? 9 : 7.5,
          textColor: theme.holidayNameText,
          backgroundColor: bg,
          align: "left",
          alignVertical: "center",
          wrap: true,
          ...line,
        },
      );
      memoRow.push(
        {
          value: null,
          columnSpan: COLUMNS_PER_DAY,
          height: g.memoRowPt,
          fontSize: 10,
          backgroundColor: memoBg,
          align: "left",
          alignVertical: "top",
          wrap: true,
          ...line,
        },
        null,
      );
    }
    rows.push(dateRow, memoRow);
  }

  // 注記行（推定の祝日を含む月だけ）
  rows.push([
    {
      value: month.hasEstimatedHoliday ? ESTIMATED_NOTE : null,
      columnSpan: COLUMN_COUNT,
      height: NOTE_ROW_PT,
      fontSize: 8,
      textColor: theme.noteText,
      align: "left",
      alignVertical: "center",
    },
    ...Array<null>(COLUMN_COUNT - 1).fill(null),
  ]);
  return rows;
}

/** 結合されたセルの「隠れたセル」にも、先頭セルと同じ書式を付ける（結合セルの罫線・背景色が欠けないように） */
export function styleMergedCells(xml: string): string {
  const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/g)];
  let out = xml;
  for (const m of merges) {
    const [, c1, r1, c2, r2] = m;
    if (r1 !== r2) continue; // このカレンダーの結合は横方向のみ
    const colNum = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const colName = (n: number) => {
      let s = "";
      while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s;
    };
    const masterRe = new RegExp(`<c r="${c1}${r1}"([^>]*?)(/>|>[\\s\\S]*?</c>)`);
    const found = masterRe.exec(out);
    if (!found) continue;
    const style = /\ss="(\d+)"/.exec(found[1])?.[1];
    if (style === undefined) continue;
    let hidden = "";
    for (let n = colNum(c1) + 1; n <= colNum(c2); n++) {
      hidden += `<c r="${colName(n)}${r1}" s="${style}"/>`;
    }
    out = out.slice(0, found.index + found[0].length) + hidden + out.slice(found.index + found[0].length);
  }
  return out;
}

/** 1シート分の印刷設定をシートのXMLへ書き込む */
export function applySheetPrintSettings(xml: string, theme: CalendarTheme, orientation: CalendarOrientation): string {
  const tab = `<tabColor rgb="FF${theme.tabColor.slice(1).toUpperCase()}"/>`;
  const fit = `<pageSetUpPr fitToPage="1"/>`;
  let out = xml
    .replace(/<printOptions[^>]*\/>/g, "")
    .replace(/<pageMargins[^>]*\/>/g, "")
    .replace(/<pageSetup[^>]*\/>/g, "");

  if (/<sheetPr\b[^>]*\/>/.test(out)) {
    out = out.replace(/<sheetPr\b[^>]*\/>/, `<sheetPr>${tab}${fit}</sheetPr>`);
  } else if (/<sheetPr\b[^>]*>/.test(out)) {
    out = out.replace(/(<sheetPr\b[^>]*>)/, `$1${tab}`).replace("</sheetPr>", `${fit}</sheetPr>`);
  } else {
    out = out.replace(/(<worksheet\b[^>]*>)/, `$1<sheetPr>${tab}${fit}</sheetPr>`);
  }

  const m = (PRINT_MARGIN_MM * MM_TO_INCH).toFixed(4);
  const tail =
    `<printOptions horizontalCentered="1"/>` +
    `<pageMargins left="${m}" right="${m}" top="${m}" bottom="${m}" header="0.2" footer="0.2"/>` +
    `<pageSetup paperSize="9" orientation="${orientation}" fitToWidth="1" fitToHeight="1"/>`;
  return out.replace("</worksheet>", `${tail}</worksheet>`);
}

/** ブック全体に、シートごとの印刷範囲（定義された名前 _xlnm.Print_Area）を書き込む */
export function applyPrintAreas(xml: string, areas: { sheetName: string; range: string }[]): string {
  const absolute = (range: string) =>
    range.replace(/([A-Z]+)(\d+)/g, (_, c: string, r: string) => `$${c}$${r}`);
  const names = areas
    .map(
      (a, i) =>
        `<definedName name="_xlnm.Print_Area" localSheetId="${i}">'${a.sheetName.replace(/'/g, "''")}'!${absolute(a.range)}</definedName>`,
    )
    .join("");
  const block = `<definedNames>${names}</definedNames>`;
  const cleaned = xml.replace(/<definedNames>[\s\S]*?<\/definedNames>|<definedNames\s*\/>/g, "");
  if (/<calcPr\b/.test(cleaned)) return cleaned.replace(/<calcPr\b/, `${block}<calcPr`);
  return cleaned.replace("</workbook>", `${block}</workbook>`);
}

function printFeature(options: CalendarExcelOptions, sheetNames: string[], weekCounts: number[]): Feature {
  return {
    files: {
      transform: {
        "xl/worksheets/sheet{id}.xml": {
          transform(xml: string) {
            return applySheetPrintSettings(styleMergedCells(xml), options.theme, options.orientation);
          },
        },
        "xl/workbook.xml": {
          transform(xml: string) {
            return applyPrintAreas(
              xml,
              sheetNames.map((sheetName, i) => ({
                sheetName,
                range: printAreaOf(weekCounts[i], options.orientation),
              })),
            );
          },
        },
      },
    },
  };
}

/**
 * 文字の書体（日本語の見やすい游ゴシック）。ブック全体の標準フォントは別にArial 10にしている。
 * Excelの「列幅」は標準フォントの数字1文字の幅を単位にするため、標準フォントを固定しておくと、
 * 環境が違っても列幅（mm換算）がそろい、印刷時の縮小率が安定する。
 */
export const CALENDAR_EXCEL_FONT = "Yu Gothic";
export const CALENDAR_EXCEL_BASE_FONT = { fontFamily: "Arial", fontSize: 10 } as const;

/** 年度カレンダーのExcelファイル（月別12シート）を作る */
export async function buildCalendarExcel(options: CalendarExcelOptions): Promise<Blob> {
  const { calendar, theme, orientation } = options;
  const { default: writeXlsxFile } = await import("write-excel-file/universal");

  const sheetNames = calendar.months.map((m) => SHEET_NAME_FOR_MONTH(m.month));
  const weekCounts = calendar.months.map((m) => m.weeks.length);

  const sheets = calendar.months.map((month, i) => {
    const g = monthSheetGeometry(month.weeks.length, orientation);
    const columns = Array.from({ length: COLUMN_COUNT }, (_, c) => ({
      width: mmToExcelColumnWidth(c % 2 === 0 ? g.numberColumnMm : g.nameColumnMm),
    }));
    return {
      sheet: sheetNames[i],
      // write-excel-file の行・セルの型は厳密なため、既存の xlsx-simple-io.ts と同じくこの境界でだけ型を緩める
      data: monthRows(month, calendar, theme, orientation, options.showAdjacentDays ?? false).map((row) =>
        row.map((cell) => (cell ? { fontFamily: CALENDAR_EXCEL_FONT, ...cell } : cell)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) as any,
      columns,
      showGridLines: false,
      stickyRowsCount: 2,
      ...(orientation === "landscape" ? { orientation: "landscape" as const } : {}),
    };
  });

  try {
    return await writeXlsxFile(sheets, {
      ...CALENDAR_EXCEL_BASE_FONT,
      features: [printFeature(options, sheetNames, weekCounts)],
    }).toBlob();
  } catch {
    throw new Error("Excelファイルの生成に失敗しました");
  }
}

export type { CalendarDay };
