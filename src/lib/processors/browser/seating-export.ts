import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { csvRowsToBlob } from "@/lib/utils/csv";
import type { Participant } from "@/lib/seating/participants";
import type { SeatingPlan } from "@/lib/seating/arrange";

/**
 * 座席表の出力（PDF・Excel・CSV）。ブラウザ内だけで作る（名前は外部に送らない）。
 * - PDF: A4横。テーブルごとの枠に、席番号と名前を並べる。名前が長いときは文字を縮めて枠に収める。
 * - Excel: 「座席表」シート（テーブルを並べた表）と「一覧」シート（氏名・テーブル・席番号）。値だけで書式は付けない。
 * - CSV: 氏名・テーブル・席番号の一覧（UTF-8・BOM付き）。
 */

export interface SeatingExportInput {
  title: string;
  participants: Participant[];
  plan: SeatingPlan;
}

export interface SeatingListRow {
  name: string;
  table: number;
  seat: number;
}

/** 席に座っている人の一覧（テーブル・席の順） */
export function seatingList({ participants, plan }: Pick<SeatingExportInput, "participants" | "plan">): SeatingListRow[] {
  const nameById = new Map(participants.map((p) => [p.id, p.name]));
  const rows: SeatingListRow[] = [];
  plan.tables.forEach((row, t) =>
    row.forEach((id, s) => {
      if (id !== null) rows.push({ name: nameById.get(id) ?? "", table: t + 1, seat: s + 1 });
    })
  );
  return rows;
}

/** CSVをExcelで開いたときに、数式として実行されないようにする（=, +, -, @ で始まる文字の前に ' を付ける） */
function csvSafe(text: string): string {
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function seatingToCsvBlob(input: SeatingExportInput): Blob {
  const rows = [["氏名", "テーブル", "席番号"], ...seatingList(input).map((r) => [csvSafe(r.name), String(r.table), String(r.seat)])];
  return csvRowsToBlob(rows);
}

/** Excelの「座席表」シートの行（テーブルを横に最大 perBand 個ずつ並べる） */
export function seatingGridRows(input: SeatingExportInput, perBand = 4): (string | number | null)[][] {
  const nameById = new Map(input.participants.map((p) => [p.id, p.name]));
  const rows: (string | number | null)[][] = [];
  for (let start = 0; start < input.plan.tables.length; start += perBand) {
    const band = input.plan.tables.slice(start, start + perBand);
    const height = Math.max(...band.map((t) => t.length));
    const header: (string | number | null)[] = [];
    band.forEach((_, i) => header.push(`テーブル${start + i + 1}`, null, null));
    rows.push(header);
    for (let s = 0; s < height; s++) {
      const line: (string | number | null)[] = [];
      band.forEach((table) => {
        if (s < table.length) {
          const id = table[s];
          line.push(s + 1, id === null ? "（空席）" : (nameById.get(id) ?? ""), null);
        } else {
          line.push(null, null, null);
        }
      });
      rows.push(line);
    }
    rows.push([]);
  }
  return rows;
}

export async function seatingToXlsxBlob(input: SeatingExportInput, perBand = 4): Promise<Blob> {
  const perTableColumns: { width: number }[] = [];
  for (let i = 0; i < perBand; i++) perTableColumns.push({ width: 6 }, { width: 22 }, { width: 3 });
  const list = seatingList(input);
  return writeXlsxSheets([
    { name: "座席表", rows: seatingGridRows(input, perBand), columns: perTableColumns },
    {
      name: "一覧",
      rows: [["氏名", "テーブル", "席番号"], ...list.map((r) => [r.name, r.table, r.seat])],
      columns: [{ width: 24 }, { width: 10 }, { width: 10 }],
    },
  ]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
const PAGE_W = 841.89; // A4横
const PAGE_H = 595.28;
const MARGIN = 36;
const TITLE_SIZE = 18;
const HEADER_H = 24;
const GAP = 14;
const MAX_ROW_H = 17;
const MIN_ROW_H = 10;

const INK: [number, number, number] = [0.13, 0.13, 0.15];
const MUTED: [number, number, number] = [0.55, 0.55, 0.58];
const LINE: [number, number, number] = [0.55, 0.55, 0.6];
const HEADER_BG: [number, number, number] = [0.9, 0.93, 0.98];

/** 1ページに並べるテーブルの列数 */
export function seatingPdfColumns(tableCount: number): number {
  if (tableCount <= 2) return Math.max(1, tableCount);
  if (tableCount <= 6) return 3;
  return 4;
}

function fitText(text: string, font: PDFFont, size: number, maxWidth: number): number {
  const width = font.widthOfTextAtSize(text, size);
  if (width <= maxWidth) return size;
  return Math.max(5, (size * maxWidth) / width);
}

export async function seatingToPdfBlob(input: SeatingExportInput): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // 日本語フォントは、一部の文字が欠けないよう、サブセットにしない（帳票のPDFと同じ方針）
  const font = await doc.embedFont(await loadJapaneseFontBytes(), { subset: false });
  const nameById = new Map(input.participants.map((p) => [p.id, p.name]));
  const tables = input.plan.tables;
  const cols = seatingPdfColumns(tables.length);
  const boxW = (PAGE_W - MARGIN * 2 - GAP * (cols - 1)) / cols;
  const maxSeats = Math.max(...tables.map((t) => t.length));
  const bodyTop = PAGE_H - MARGIN - TITLE_SIZE - 14;
  const bodyHeight = bodyTop - MARGIN - 10;

  // 席の行の高さ。席数が多いテーブルがあっても、1ページに収まるよう、縮める
  const rowH = Math.min(MAX_ROW_H, Math.max(MIN_ROW_H, (bodyHeight - HEADER_H) / maxSeats));
  const fontSize = Math.min(11, rowH * 0.68);

  // テーブルを列ごとの行（band）にして、ページに収まる分ずつ並べる
  const bands: number[][] = [];
  for (let i = 0; i < tables.length; i += cols) bands.push(Array.from({ length: Math.min(cols, tables.length - i) }, (_, k) => i + k));
  const bandHeight = (band: number[]) => HEADER_H + Math.max(...band.map((t) => tables[t].length)) * rowH;

  const pages: number[][][] = [];
  let current: number[][] = [];
  let used = 0;
  for (const band of bands) {
    const h = bandHeight(band);
    if (current.length > 0 && used + h > bodyHeight) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(band);
    used += h + GAP;
  }
  if (current.length > 0) pages.push(current);

  pages.forEach((pageBands, pageIndex) => {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const title = input.title.trim() === "" ? "座席表" : input.title.trim();
    const titleSize = fitText(title, font, TITLE_SIZE, PAGE_W - MARGIN * 2 - 60);
    page.drawText(title, { x: MARGIN, y: PAGE_H - MARGIN - TITLE_SIZE + 4, size: titleSize, font, color: rgb(...INK) });
    page.drawText(`${pageIndex + 1} / ${pages.length}`, { x: PAGE_W - MARGIN - 40, y: MARGIN - 18, size: 9, font, color: rgb(...MUTED) });

    let top = bodyTop;
    for (const band of pageBands) {
      const h = bandHeight(band);
      band.forEach((tableIndex, k) => {
        const x = MARGIN + k * (boxW + GAP);
        const row = tables[tableIndex];
        const boxH = HEADER_H + row.length * rowH;
        page.drawRectangle({ x, y: top - boxH, width: boxW, height: boxH, borderColor: rgb(...LINE), borderWidth: 0.8 });
        page.drawRectangle({ x, y: top - HEADER_H, width: boxW, height: HEADER_H, color: rgb(...HEADER_BG), borderColor: rgb(...LINE), borderWidth: 0.8 });
        const label = `テーブル ${tableIndex + 1}`;
        page.drawText(label, { x: x + 8, y: top - HEADER_H + 7, size: 12, font, color: rgb(...INK) });
        const filled = row.filter((id) => id !== null).length;
        const count = `${filled}/${row.length}人`;
        page.drawText(count, { x: x + boxW - 8 - font.widthOfTextAtSize(count, 9), y: top - HEADER_H + 8, size: 9, font, color: rgb(...MUTED) });
        row.forEach((id, s) => {
          const rowTop = top - HEADER_H - s * rowH;
          const baseline = rowTop - rowH + (rowH - fontSize) / 2 + fontSize * 0.18;
          page.drawText(String(s + 1), { x: x + 8, y: baseline, size: fontSize, font, color: rgb(...MUTED) });
          const text = id === null ? "（空席）" : (nameById.get(id) ?? "");
          const maxW = boxW - 36;
          const size = fitText(text, font, fontSize, maxW);
          page.drawText(text, { x: x + 28, y: baseline, size, font, color: rgb(...(id === null ? MUTED : INK)) });
          if (s > 0) {
            page.drawLine({ start: { x, y: rowTop }, end: { x: x + boxW, y: rowTop }, thickness: 0.3, color: rgb(0.85, 0.85, 0.87) });
          }
        });
      });
      top -= h + GAP;
    }
  });

  const bytes = await doc.save();
  return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), pageCount: pages.length };
}
