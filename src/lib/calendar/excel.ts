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
import { eventsCellText, type CalendarEventMap } from "./events";
import { groupMonths, sheetArrangement, sheetNameOf, type MonthsPerSheet } from "./layout";
import { holidayDisplayName, monthNote, type CalendarDay, type CalendarMonth, type FiscalCalendar } from "./model";
import type { CalendarTheme } from "./themes";

export type CalendarOrientation = "landscape" | "portrait";

export interface CalendarExcelOptions {
  calendar: FiscalCalendar;
  theme: CalendarTheme;
  orientation: CalendarOrientation;
  /** 前後の月の日付を薄く表示するか（既定は空欄） */
  showAdjacentDays?: boolean;
  /** 1シートに載せる月数（既定は1か月=12シート。2か月=6シート。横向きは左右、縦向きは上下に並べる） */
  monthsPerSheet?: MonthsPerSheet;
  /** 日付ごとの予定。その日の予定欄（日付の下のセル）に、全件を改行でつないで入れる */
  events?: CalendarEventMap;
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

/**
 * 2か月を1シートに並べるときの、列と行の寸法。
 * A4横は左右に並べ、月の間に細い余白の列を入れる。A4縦は上下に並べ、月の間に細い余白の行を入れる。
 */
const PAIR_GAP_MM = 4;
const PAIR_NUMBER_COLUMN_MM = 8;
const PAIR_TITLE_ROW_PT = 26;
const PAIR_HEADER_ROW_PT = 16;
const PAIR_NOTE_ROW_PT = 22;
/** 上下に並べるとき（A4縦）の、月の間の余白の行と、注記の行の高さ(pt)。幅が広いので注記は1行に収まる */
const STACK_GAP_ROW_PT = 10;
const STACK_NOTE_ROW_PT = 16;

export interface SheetGeometry {
  numberColumnMm: number;
  nameColumnMm: number;
  /** 2か月を左右に並べる（A4横）ときだけ、左右の月の間の余白の列の幅(mm)。それ以外は 0（余白の列なし） */
  gapColumnMm: number;
  /** 2か月を上下に並べる（A4縦）ときだけ、上下の月の間の余白の行の高さ(pt)。それ以外は 0（余白の行なし） */
  gapRowPt: number;
  memoRowPt: number;
  columnCount: number;
  rowCount: number;
  /** 1か月ぶんの列数（日付と祝日名の2列×7日） */
  monthColumnCount: number;
  noteRowPt: number;
}

/** シートの寸法。1か月は monthSheetGeometry と同じ。2か月は、2つの月で行をそろえるため、週数の多い方に合わせる */
export function sheetGeometry(maxWeekCount: number, monthsPerSheet: MonthsPerSheet, orientation: CalendarOrientation): SheetGeometry {
  if (monthsPerSheet === 1) {
    const g = monthSheetGeometry(maxWeekCount, orientation);
    return {
      numberColumnMm: g.numberColumnMm,
      nameColumnMm: g.nameColumnMm,
      gapColumnMm: 0,
      gapRowPt: 0,
      memoRowPt: g.memoRowPt,
      columnCount: COLUMN_COUNT,
      rowCount: g.rowCount,
      monthColumnCount: COLUMN_COUNT,
      noteRowPt: NOTE_ROW_PT,
    };
  }
  if (orientation === "portrait") {
    // 上下に並べる: 1か月と同じ幅の列を使い、2か月ぶんの行（週数の多い方に合わせる）と、間の余白の行を縦に積む
    const widthMm = A4_MM.width - PRINT_MARGIN_MM * 2;
    const heightPt = (A4_MM.height - PRINT_MARGIN_MM * 2) * MM_TO_PT * HEIGHT_SAFETY;
    const fixed = 2 * (PAIR_TITLE_ROW_PT + PAIR_HEADER_ROW_PT + STACK_NOTE_ROW_PT) + STACK_GAP_ROW_PT;
    const memo = Math.min(MEMO_MAX_PT.portrait, Math.floor((heightPt - fixed) / (2 * maxWeekCount) - DATE_ROW_PT));
    const monthRowCount = 3 + maxWeekCount * 2;
    return {
      numberColumnMm: PAIR_NUMBER_COLUMN_MM,
      nameColumnMm: widthMm / 7 - PAIR_NUMBER_COLUMN_MM,
      gapColumnMm: 0,
      gapRowPt: STACK_GAP_ROW_PT,
      memoRowPt: memo,
      columnCount: COLUMN_COUNT,
      rowCount: monthRowCount * 2 + 1,
      monthColumnCount: COLUMN_COUNT,
      noteRowPt: STACK_NOTE_ROW_PT,
    };
  }
  const pageWidthMm = A4_MM.height - PRINT_MARGIN_MM * 2;
  const pageHeightPt = (A4_MM.width - PRINT_MARGIN_MM * 2) * MM_TO_PT * HEIGHT_SAFETY;
  const dayMm = (pageWidthMm - PAIR_GAP_MM) / 2 / 7;
  const fixedPt = PAIR_TITLE_ROW_PT + PAIR_HEADER_ROW_PT + PAIR_NOTE_ROW_PT;
  const memoRowPt = Math.min(MEMO_MAX_PT.landscape, Math.floor((pageHeightPt - fixedPt) / maxWeekCount - DATE_ROW_PT));
  return {
    numberColumnMm: PAIR_NUMBER_COLUMN_MM,
    nameColumnMm: dayMm - PAIR_NUMBER_COLUMN_MM,
    gapColumnMm: PAIR_GAP_MM,
    gapRowPt: 0,
    memoRowPt,
    columnCount: COLUMN_COUNT * 2 + 1,
    rowCount: 3 + maxWeekCount * 2,
    monthColumnCount: COLUMN_COUNT,
    noteRowPt: PAIR_NOTE_ROW_PT,
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
export function printAreaOf(weekCount: number, orientation: CalendarOrientation, monthsPerSheet: MonthsPerSheet = 1): string {
  const g = sheetGeometry(weekCount, monthsPerSheet, orientation);
  return `A1:${excelColumnLetter(g.columnCount - 1)}${g.rowCount}`;
}

type CellInput = Record<string, unknown> | null;

interface MonthRowsOptions {
  memoRowPt: number;
  /** 2か月を並べるときの、小さめの文字・寸法 */
  compact: boolean;
  /** 注記の行の高さ(pt) */
  noteRowPt: number;
  events?: CalendarEventMap;
}

function monthRows(
  month: CalendarMonth,
  cal: FiscalCalendar,
  theme: CalendarTheme,
  orientation: CalendarOrientation,
  showAdjacentDays: boolean,
  options: MonthRowsOptions,
): CellInput[][] {
  const { memoRowPt, compact, noteRowPt, events } = options;
  const landscape = orientation === "landscape";
  const line = { borderStyle: "thin", borderColor: theme.border } as const;
  // 白黒（noFill）のテーマでは背景を塗らない（塗りつぶしを入れない）。それ以外は指定色で塗る
  const fill = (color: string) => (theme.noFill ? {} : { backgroundColor: color });
  const titleRowPt = compact ? PAIR_TITLE_ROW_PT : TITLE_ROW_PT;
  const headerRowPt = compact ? PAIR_HEADER_ROW_PT : HEADER_ROW_PT;
  // タイトル行の左（年月）と右（和暦・年度）の列数
  const leftSpan = compact ? 8 : 10;
  const rightSpan = COLUMN_COUNT - leftSpan;
  const rows: CellInput[][] = [];

  // タイトル行: 左に「2026年4月」、右に和暦と年度
  rows.push([
    {
      value: `${month.year}年${month.month}月`,
      columnSpan: leftSpan,
      height: titleRowPt,
      fontSize: compact ? 15 : landscape ? 20 : 18,
      fontWeight: "bold",
      textColor: theme.titleText,
      ...fill(theme.titleBg),
      align: "left",
      alignVertical: "center",
    },
    ...Array<null>(leftSpan - 1).fill(null),
    {
      value: `${month.eraLabel}　${cal.fiscalYear}年度`,
      columnSpan: rightSpan,
      height: titleRowPt,
      fontSize: compact ? 9 : landscape ? 11 : 10,
      textColor: theme.titleText,
      ...fill(theme.titleBg),
      align: "right",
      alignVertical: "center",
    },
    ...Array<null>(rightSpan - 1).fill(null),
  ]);

  // 曜日の見出し行
  const header: CellInput[] = [];
  cal.weekdayOrder.forEach((weekday, c) => {
    const text = weekday === 6 ? theme.headerSaturdayText : weekday === 0 ? theme.headerSundayText : theme.headerText;
    header.push(
      {
        value: cal.weekdayLabels[c],
        columnSpan: COLUMNS_PER_DAY,
        height: headerRowPt,
        fontSize: compact ? 9.5 : 11,
        fontWeight: "bold",
        textColor: text,
        ...fill(theme.headerBg),
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
              fontSize: compact ? 10 : landscape ? 12 : 11,
              fontWeight: day.inMonth ? "bold" : undefined,
              textColor: faded ? theme.noteText : theme.dayText[day.kind],
              ...fill(bg),
              align: "center",
              alignVertical: "center",
              ...line,
            }
          : { value: null, height: DATE_ROW_PT, ...fill(bg), ...line },
        {
          value: day.inMonth ? holidayDisplayName(day) || null : null,
          height: DATE_ROW_PT,
          fontSize: compact ? 6.5 : landscape ? 9 : 7.5,
          textColor: theme.holidayNameText,
          ...fill(bg),
          align: "left",
          alignVertical: "center",
          wrap: true,
          ...line,
        },
      );
      // その日の予定（前後の月の日には、その月の側に載るので入れない）。全件を残し、1件ずつ改行で区切る
      const dayEvents = day.inMonth ? events?.get(day.iso) : undefined;
      const hasEvents = !!dayEvents && dayEvents.length > 0;
      memoRow.push(
        {
          value: hasEvents ? eventsCellText(dayEvents) : null,
          columnSpan: COLUMNS_PER_DAY,
          height: memoRowPt,
          fontSize: compact ? 8 : 10,
          ...(hasEvents ? { textColor: theme.headerText } : {}),
          ...fill(memoBg),
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

  // 注記行（推定または法律どおりの未確定の祝日を含む月だけ。決まりは model.ts の monthNote）
  rows.push([
    {
      value: monthNote(month),
      columnSpan: COLUMN_COUNT,
      height: noteRowPt,
      fontSize: compact ? 7 : 8,
      textColor: theme.noteText,
      align: "left",
      alignVertical: "center",
      ...(compact ? { wrap: true } : {}),
    },
    ...Array<null>(COLUMN_COUNT - 1).fill(null),
  ]);
  return rows;
}

/**
 * 1シートぶんの行を作る。1か月はその月の行そのもの。
 * 2か月は、横向きなら左の月・余白の列・右の月を横に並べ、縦向きなら上の月・余白の行・下の月を縦に並べる（前の月が左／上）。
 * 週数が違う2つの月は、少ない方に空の週の行を足して、注記の行をそろえる。
 */
function sheetRows(
  months: readonly CalendarMonth[],
  cal: FiscalCalendar,
  theme: CalendarTheme,
  orientation: CalendarOrientation,
  showAdjacentDays: boolean,
  events: CalendarEventMap | undefined,
): { rows: CellInput[][]; geometry: SheetGeometry } {
  const monthsPerSheet = months.length as MonthsPerSheet;
  const maxWeeks = Math.max(...months.map((m) => m.weeks.length));
  const geometry = sheetGeometry(maxWeeks, monthsPerSheet, orientation);
  const blocks = months.map((m) =>
    monthRows(m, cal, theme, orientation, showAdjacentDays, {
      memoRowPt: geometry.memoRowPt,
      compact: monthsPerSheet === 2,
      noteRowPt: monthsPerSheet === 2 ? geometry.noteRowPt : NOTE_ROW_PT,
      events,
    }),
  );
  if (blocks.length === 1) return { rows: blocks[0], geometry };

  const stacked = sheetArrangement(orientation, monthsPerSheet) === "stacked";
  // 空の週の行。左右に並べるときは、もう一方の月のセルと同じ行になるので、中身はすべて空でよい。
  // 上下に並べるときは、行全体が空になる（write-excel-file は、空の行が続くとXMLを壊すことがある）ので、
  // 先頭のセルに行の高さだけを持たせて、行が書き出されるようにする。
  const emptyWeekRows = (count: number): CellInput[][] =>
    Array.from({ length: count * 2 }, (_, r) => {
      const row = Array<CellInput>(COLUMN_COUNT).fill(null);
      if (stacked) row[0] = { value: null, height: r % 2 === 0 ? DATE_ROW_PT : geometry.memoRowPt };
      return row;
    });
  const padded = blocks.map((rows, i) => {
    const missing = maxWeeks - months[i].weeks.length;
    if (missing === 0) return rows;
    // タイトル・見出し・週の行までと、最後の注記の行の間に、空の週を足す
    return [...rows.slice(0, rows.length - 1), ...emptyWeekRows(missing), rows[rows.length - 1]];
  });
  if (stacked) {
    // 上の月、余白の行（高さだけを持つ空の行）、下の月の順に積む
    const spacer: CellInput[] = [{ value: null, height: geometry.gapRowPt }, ...Array<CellInput>(COLUMN_COUNT - 1).fill(null)];
    return { rows: [...padded[0], spacer, ...padded[1]], geometry };
  }
  const combined = padded[0].map((leftRow, r) => [...leftRow, null, ...padded[1][r]]);
  return { rows: combined, geometry };
}

const colNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n: number) => {
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/**
 * 結合されたセルの「隠れたセル」を整える。
 *
 * 結合セルの罫線・背景色が欠けないよう、結合範囲のすべてのセルに先頭セルと同じ書式を持たせる。
 * write-excel-file は、結合範囲のセルを書式つきで書き出すことがあるため、すでにあるセルは重複して足さず、
 * 足りないセルだけを補う。そのうえで、行ごとにセルを「同じ参照が1つだけ・列の昇順」にそろえる。
 * （同じ参照のセルが2つ以上ある、または順序が違うXMLは、Microsoft Excelが「修復」の警告を出す原因になる）
 */
export function styleMergedCells(xml: string): string {
  const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/g)].filter((m) => m[2] === m[4]);
  const hiddenOf = new Map<number, { master: string; from: number; to: number }[]>();
  for (const m of merges) {
    const row = Number(m[2]);
    const list = hiddenOf.get(row) ?? [];
    list.push({ master: `${m[1]}${m[2]}`, from: colNumber(m[1]), to: colNumber(m[3]) });
    hiddenOf.set(row, list);
  }

  return xml.replace(/<row\b([^>]*?)>([\s\S]*?)<\/row>/g, (whole, rowAttrs: string, inner: string) => {
    const rowNo = Number(/\sr="(\d+)"/.exec(rowAttrs)?.[1]);
    const cells = new Map<number, string>();
    for (const cm of inner.matchAll(/<c\b[^>]*?\sr="([A-Z]+)(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const col = colNumber(cm[1]);
      // 同じ参照が複数あるときは、値のある（先に出た）セルを残す
      if (!cells.has(col)) cells.set(col, cm[0]);
    }
    for (const { master, from, to } of hiddenOf.get(rowNo) ?? []) {
      const masterCell = cells.get(from);
      const style = masterCell ? /\ss="(\d+)"/.exec(masterCell)?.[1] : undefined;
      if (style === undefined) continue;
      for (let n = from + 1; n <= to; n++) if (!cells.has(n)) cells.set(n, `<c r="${colLetters(n)}${rowNo}" s="${style}"/>`);
      void master;
    }
    const sorted = [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).join("");
    return `<row${rowAttrs}>${sorted}</row>`;
  });
}

/**
 * 先頭の行だけを固定したときの、ウィンドウ枠の指定を規定どおりにする。
 * write-excel-file は、横の分割がない（xSplit=0）のに activePane="bottomRight" と書く。行だけを固定するときの
 * 規定の値は bottomLeft（Excelは、分割と合わない activePane を「修復」の対象にすることがある）。
 */
export function fixFrozenPane(xml: string): string {
  return xml.replace(/<pane\b([^>]*?)\s*\/>/g, (whole, attrs: string) => {
    const xs = Number(/\sxSplit="(\d+)"/.exec(` ${attrs}`)?.[1] ?? 0);
    const ys = Number(/\sySplit="(\d+)"/.exec(` ${attrs}`)?.[1] ?? 0);
    if (xs > 0 || ys === 0) return whole;
    const cleaned = attrs.replace(/\s*xSplit="0"/, "").replace(/\s*activePane="[^"]*"/, "");
    return `<pane${cleaned} activePane="bottomLeft"/><selection pane="bottomLeft"/>`;
  });
}

/** 1シート分の印刷設定をシートのXMLへ書き込む */
export function applySheetPrintSettings(xml: string, theme: CalendarTheme, orientation: CalendarOrientation): string {
  const tab = theme.tabColor ? `<tabColor rgb="FF${theme.tabColor.slice(1).toUpperCase()}"/>` : "";
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

function printFeature(options: CalendarExcelOptions & { monthsPerSheet: MonthsPerSheet }, sheetNames: string[], weekCounts: number[]): Feature {
  return {
    files: {
      transform: {
        "xl/worksheets/sheet{id}.xml": {
          transform(xml: string) {
            return applySheetPrintSettings(fixFrozenPane(styleMergedCells(xml)), options.theme, options.orientation);
          },
        },
        "xl/workbook.xml": {
          transform(xml: string) {
            return applyPrintAreas(
              xml,
              sheetNames.map((sheetName, i) => ({
                sheetName,
                range: printAreaOf(weekCounts[i], options.orientation, options.monthsPerSheet),
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

/** 年度カレンダーのExcelファイル（1か月=12シート、または2か月=6シート。2か月は横向きなら左右、縦向きなら上下に並べる）を作る */
export async function buildCalendarExcel(options: CalendarExcelOptions): Promise<Blob> {
  const { calendar, theme } = options;
  const monthsPerSheet: MonthsPerSheet = options.monthsPerSheet ?? 1;
  const orientation: CalendarOrientation = options.orientation;
  const { default: writeXlsxFile } = await import("write-excel-file/universal");

  const groups = groupMonths(calendar, monthsPerSheet);
  const sheetNames = groups.map((g) => sheetNameOf(g));
  const maxWeeks = groups.map((g) => Math.max(...g.map((m) => m.weeks.length)));

  const sheets = groups.map((group, i) => {
    const { rows, geometry: g } = sheetRows(group, calendar, theme, orientation, options.showAdjacentDays ?? false, options.events);
    const monthColumns = Array.from({ length: COLUMN_COUNT }, (_, c) => ({
      width: mmToExcelColumnWidth(c % 2 === 0 ? g.numberColumnMm : g.nameColumnMm),
    }));
    // 左右に並べるとき（2か月・A4横）だけ、月の間に余白の列を入れる。上下に並べるとき（A4縦）は1か月と同じ列
    const columns =
      sheetArrangement(orientation, monthsPerSheet) === "side-by-side"
        ? [...monthColumns, { width: mmToExcelColumnWidth(g.gapColumnMm) }, ...monthColumns]
        : monthColumns;
    return {
      sheet: sheetNames[i],
      // write-excel-file の行・セルの型は厳密なため、既存の xlsx-simple-io.ts と同じくこの境界でだけ型を緩める
      data: rows.map((row) =>
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
      features: [printFeature({ ...options, orientation, monthsPerSheet }, sheetNames, maxWeeks)],
    }).toBlob();
  } catch {
    throw new Error("Excelファイルの生成に失敗しました");
  }
}

export type { CalendarDay };
