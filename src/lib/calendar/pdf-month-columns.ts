/**
 * 「月ごとの列に、日・曜日・予定が縦に並ぶ」形式の行事予定表（学校の年間行事予定表など）のPDFを、予定に読み取る。
 *
 *   1月            2月            3月
 *   1 金 「元日」   1 月 自宅学習   1 月
 *   2 土 …         2 火 …         2 火
 *
 * 年は書かれていないので、「日付の曜日が、書かれている曜日と合う年」を、対象年度の前後から選んで決める
 * （例: 1月1日が金曜日なのは2027年）。曜日が合う年がなければ、年を決めずに「読めない行」として残す（推測で決めない）。
 * AIは使わず、PDFの文字情報（座標つき）だけで、ブラウザの中で処理する。文字情報のない（スキャンの）PDFは対象外。
 *
 * このファイルの前半（parseMonthColumns / resolveMonthColumnEntries）は座標つきの文字だけを扱う純粋な処理で、
 * 後半（extractMonthColumnEntries）だけがPDF.jsを使う。
 */
import { getHoliday, weekdayOfIso } from "./holidays";

/** parseMonthColumns が必要とする、座標つきの文字の最小の形（PositionedTextItem と互換） */
export interface MonthColumnItem {
  str: string;
  x: number;
  y: number;
  width: number;
  fontHeight: number;
}

export interface MonthColumnEntry {
  page: number;
  month: number;
  day: number;
  /** 0=日曜 … 6=土曜（書かれていた曜日） */
  weekday: number;
  /** その日の予定の文字。予定のない日は読み取り対象にしない */
  text: string;
}

export interface MonthColumnParse {
  entries: MonthColumnEntry[];
  /** 「日 曜日」の行として認識した行数（予定のない日も含む）。形式の判定に使う */
  dayRowCount: number;
}

const WEEKDAY_CHARS = "日月火水木金土";
/** 「日 曜日」の行が、これ以上見つかったら、月ごとの列の形式とみなす */
export const MIN_DAY_ROWS = 20;
/** 同じ行の文字として扱う縦位置の許容(pt)。行の間隔(約12pt)よりずっと小さくする */
const ROW_TOLERANCE = 4;
/** 同じ予定の文字としてつなぐ、文字の間のすき間の上限(pt)。これより離れていれば、別の予定にする */
const JOIN_GAP = 8;
const MAX_TEXT = 200;

const norm = (s: string) => s.normalize("NFKC").trim();

interface DayRow {
  x: number;
  y: number;
  day: number;
  weekday: number;
  /** 曜日の文字の右端（予定の文字は、これより右にある） */
  textStart: number;
}

function findDayRows(items: MonthColumnItem[]): DayRow[] {
  const days = items.filter((i) => /^\d{1,2}$/.test(norm(i.str)) && Number(norm(i.str)) >= 1 && Number(norm(i.str)) <= 31);
  const weekdays = items.filter((i) => norm(i.str).length === 1 && WEEKDAY_CHARS.includes(norm(i.str)));
  const rows: DayRow[] = [];
  for (const d of days) {
    let best: MonthColumnItem | null = null;
    for (const w of weekdays) {
      const dx = w.x - d.x;
      if (Math.abs(w.y - d.y) <= 2 && dx > 0 && dx <= 16 && (!best || w.x < best.x)) best = w;
    }
    if (best) rows.push({ x: d.x, y: d.y, day: Number(norm(d.str)), weekday: WEEKDAY_CHARS.indexOf(norm(best.str)), textStart: best.x + best.width - 1 });
  }
  return rows;
}

/** 1ページ分の座標つきの文字から、月ごとの列の予定を取り出す */
export function parseMonthColumns(items: MonthColumnItem[], page = 1): MonthColumnParse {
  const rows = findDayRows(items);
  if (rows.length === 0) return { entries: [], dayRowCount: 0 };

  // 列（月ごとのまとまり）: 日の数字の左端の位置が近い行を、同じ列とする
  const byX = [...rows].sort((a, b) => a.x - b.x);
  const bands: { minX: number; rows: DayRow[] }[] = [];
  for (const r of byX) {
    const last = bands[bands.length - 1];
    if (last && r.x - last.rows[last.rows.length - 1].x <= 30) last.rows.push(r);
    else bands.push({ minX: r.x, rows: [r] });
  }
  const usable = bands.filter((b) => b.rows.length >= 5);
  const headers = items
    .map((i) => ({ i, m: /^(\d{1,2})月/.exec(norm(i.str)) }))
    .filter((h): h is { i: MonthColumnItem; m: RegExpExecArray } => !!h.m && Number(h.m[1]) >= 1 && Number(h.m[1]) <= 12);

  const entries: MonthColumnEntry[] = [];
  let dayRowCount = 0;
  usable.forEach((band, bi) => {
    const start = band.minX - 8;
    const end = usable[bi + 1] ? usable[bi + 1].minX - 8 : Infinity;
    const topY = Math.max(...band.rows.map((r) => r.y));
    // 月の見出し: この列の上にある「N月」のうち、いちばん近いもの
    const header = headers
      .filter((h) => h.i.x >= start && h.i.x < end && h.i.y > topY)
      .sort((a, b) => a.i.y - b.i.y)[0];
    if (!header) return;
    const month = Number(header.m[1]);
    const bandRows = [...band.rows].sort((a, b) => b.y - a.y);
    dayRowCount += bandRows.length;
    for (const row of bandRows) {
      const cells = items
        .filter((i) => i.x >= row.textStart && i.x < end && Math.abs(i.y - row.y) <= ROW_TOLERANCE && norm(i.str) !== "")
        .sort((a, b) => a.x - b.x);
      // すき間の小さい文字は同じ予定として、大きく離れていれば別の予定にする
      const groups: string[] = [];
      let prev: MonthColumnItem | null = null;
      for (const c of cells) {
        // 表示する文字は、PDFに書かれたまま（「Ⅲ」「①」などを、別の文字に置き換えない）。判定にだけ正規化した文字を使う
        const text = c.str.trim();
        if (prev && c.x - (prev.x + prev.width) <= JOIN_GAP) groups[groups.length - 1] += ` ${text}`;
        else groups.push(text);
        prev = c;
      }
      for (const g of groups) {
        const text = g.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
        // 記号だけ（「◎」など）は、予定として扱わない
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        entries.push({ page, month, day: row.day, weekday: row.weekday, text });
      }
    }
  });
  return { entries, dayRowCount };
}

export interface MonthColumnResolved {
  /** 日付（YYYY-MM-DD。年を決められなかった行は「M/D」）と予定名 */
  rows: string[][];
  resolved: number;
  /** 曜日が合う年がなく、年を決められなかった予定の数 */
  unresolved: number;
  /** 祝日の名前だけ（「元日」など）の予定。カレンダーにすでに祝日が出るため、読み取らなかった数 */
  skippedHolidayLabels: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 年を、曜日から決める。対象年度に入る年を優先し、なければ前後の年から選ぶ */
export function resolveMonthColumnEntries(entries: MonthColumnEntry[], range: { start: string; end: string }): MonthColumnResolved {
  const startYear = Number(range.start.slice(0, 4));
  const endYear = Number(range.end.slice(0, 4));
  const years: number[] = [];
  for (let y = startYear - 1; y <= endYear + 1; y++) years.push(y);

  const dated: { iso: string; text: string }[] = [];
  const unresolvedRows: string[][] = [];
  let skipped = 0;
  for (const e of entries) {
    const candidates = years
      .map((y) => `${y}-${pad2(e.month)}-${pad2(e.day)}`)
      .filter((iso) => {
        const t = new Date(`${iso}T00:00:00Z`);
        // 2月30日のような、存在しない日付は除く（Dateが繰り上げた場合は、月がずれる）
        return !Number.isNaN(t.getTime()) && t.getUTCMonth() + 1 === e.month && weekdayOfIso(iso) === e.weekday;
      });
    const iso = candidates.find((c) => c >= range.start && c <= range.end) ?? candidates[0];
    if (!iso) {
      unresolvedRows.push([`${e.month}/${e.day}`, e.text]);
      continue;
    }
    // 祝日の名前（「建国記念の日」など）は、カレンダーにすでに出る。名前だけの予定は読み取らず、
    // 他の予定と同じ文字の先頭にあるときは、その名前だけを除く
    const holiday = getHoliday(iso)?.name;
    let text = e.text;
    if (holiday && text.startsWith(`「${holiday}」`)) {
      text = text.slice(holiday.length + 2).trim();
      if (text === "") {
        skipped++;
        continue;
      }
    }
    dated.push({ iso, text });
  }
  dated.sort((a, b) => (a.iso === b.iso ? 0 : a.iso < b.iso ? -1 : 1));
  return {
    rows: [...dated.map((d) => [d.iso, d.text]), ...unresolvedRows],
    resolved: dated.length,
    unresolved: unresolvedRows.length,
    skippedHolidayLabels: skipped,
  };
}

/** PDFの文字情報から、月ごとの列の予定を取り出す（ブラウザの中だけ。文字情報のないページは読まない） */
export async function extractMonthColumnEntries(
  file: File,
  onProgress?: (currentPage: number, totalPages: number) => void,
): Promise<MonthColumnParse & { pageCount: number; pagesRead: number }> {
  const { loadPdfDocument, getPositionedTextItems } = await import("@/lib/pdf/pdfjs-client");
  const pdf = await loadPdfDocument(file);
  const total = Math.min(pdf.numPages, 30);
  const entries: MonthColumnEntry[] = [];
  let dayRowCount = 0;
  for (let n = 1; n <= total; n++) {
    onProgress?.(n, total);
    const page = await pdf.getPage(n);
    const parsed = parseMonthColumns(await getPositionedTextItems(page), n);
    entries.push(...parsed.entries);
    dayRowCount += parsed.dayRowCount;
  }
  return { entries, dayRowCount, pageCount: pdf.numPages, pagesRead: total };
}
