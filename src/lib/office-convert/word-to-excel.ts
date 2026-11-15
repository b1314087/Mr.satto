import { strFromU8, unzipSync } from "fflate";
import { parseDocxFormatting, OBJECT_CHAR, type BodyFmt, type BorderFmt, type CellFmt, type ParaFmt, type RunFmt, type TableFmt } from "@/lib/word/docx-format";
import { checkOfficeFile } from "./file-check";
import { ptToColumnWidth, safeSheetName, writeXlsx, type XBorderSide, type XCell, type XFont, type XImage, type XSheet, type XStyle } from "./xlsx-writer";
import type { ConversionCheck } from "./excel-to-word";

/**
 * Word→Excel変換（ブラウザの中で行う。ファイルはサーバーへ送らない）。
 *
 * - Wordの表は、表ごとに1つのシートにして、Excelで編集できるセルにする（行・列・結合・空白のセル・書式・列の幅を引き継ぐ）。
 * - 表の前の短い見出しを、シート名にする（無ければ「表1」など）。
 * - 表以外の文章は「本文」のシートに、段落ごとに1行ずつ入れる（文章を表の形に作り替えない）。表のあった位置には目印を入れる。
 * - 画像は、可能な範囲でシートに置く（PNG・JPEG・GIF）。テキストボックスの文字は「本文」のシートに入れる。
 * 読み取りは、Word→PDF変換と同じ解析（src/lib/word/docx-format.ts）を使う。
 */

export interface WordTableSummary {
  index: number;
  sheetName: string;
  rows: number;
  cols: number;
  merges: number;
  /** 前の表とつなげた（ページをまたいで分かれていた同じ形の表） */
  joinedWithPrevious: number;
}

export interface WordDocumentInfo {
  tables: WordTableSummary[];
  paragraphCount: number;
  imageCount: number;
  textBoxCount: number;
}

export interface WordToExcelOutput {
  blob: Blob;
  tables: WordTableSummary[];
  checks: ConversionCheck[];
  warnings: string[];
  bodySheet: string | null;
}

const BODY_SHEET_NAME = "本文";
const DEFAULT_ROW_PT = 18.75;
const MAX_TABLE_CELLS = 300_000;

interface CellModel {
  text: string;
  value: string | number | Date;
  numFmt: string | null;
  runs: { text: string; fmt: RunFmt }[];
  cell: CellFmt;
  /** セルの中の画像（文書の参照） */
  images: { rId: string; widthPt: number; heightPt: number }[];
}

interface TableModel {
  table: TableFmt;
  /** 行 × 列（結合で隠れるセルは null） */
  grid: (CellModel | null)[][];
  cols: number;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  sheetName: string;
  heading: string | null;
  joined: number;
  bodyIndex: number;
  sourceNonEmpty: number;
}

const plainText = (runs: { text: string; fmt: RunFmt }[]) => runs.filter((r) => !r.fmt.hidden).map((r) => r.text).join("");

function paragraphText(p: ParaFmt): string {
  const text = plainText(p.runs).split(OBJECT_CHAR).join("").replace(/\t/g, " ");
  const label = p.numbering && p.numbering.label ? `${p.numbering.label}${p.numbering.suffix === "nothing" ? "" : " "}` : "";
  return label + text;
}

/** 表示を変えずに、数値・日付として入れられる文字か（先頭のゼロ・電話番号などは文字のまま） */
export function inferCellValue(text: string): { value: string | number | Date; numFmt: string | null } {
  const t = text.trim();
  if (t === "" || t !== text || /\n/.test(t) || t.length > 20) return { value: text, numFmt: null };
  let m = /^([+-]?)((?:\d{1,3}(?:,\d{3})+)|\d+)(\.\d+)?$/.exec(t);
  if (m) {
    const intPart = m[2];
    if (/^0\d/.test(intPart.replace(/,/g, ""))) return { value: text, numFmt: null };
    if (intPart.replace(/,/g, "").length > 15) return { value: text, numFmt: null };
    const n = Number(`${m[1]}${intPart.replace(/,/g, "")}${m[3] ?? ""}`);
    const decimals = m[3] ? m[3].length - 1 : 0;
    const comma = intPart.includes(",");
    if (!comma && decimals === 0) return { value: n, numFmt: null };
    return { value: n, numFmt: `${comma ? "#,##0" : "0"}${decimals > 0 ? "." + "0".repeat(decimals) : ""}` };
  }
  m = /^([+-]?\d+)(\.\d+)?%$/.exec(t);
  if (m) {
    const decimals = m[2] ? m[2].length - 1 : 0;
    return { value: Number(`${m[1]}${m[2] ?? ""}`) / 100, numFmt: `0${decimals > 0 ? "." + "0".repeat(decimals) : ""}%` };
  }
  m = /^[¥￥]((?:\d{1,3}(?:,\d{3})+)|[1-9]\d*|0)$/.exec(t);
  if (m) return { value: Number(m[1].replace(/,/g, "")), numFmt: `${t[0] === "￥" ? '"￥"' : "¥"}${m[1].includes(",") ? "#,##0" : "0"}` };
  m = /^((?:\d{1,3}(?:,\d{3})+)|[1-9]\d*|0)円$/.exec(t);
  if (m) return { value: Number(m[1].replace(/,/g, "")), numFmt: `${m[1].includes(",") ? "#,##0" : "0"}"円"` };
  m = /^(\d{4})([/\-.])(\d{1,2})\2(\d{1,2})$/.exec(t);
  if (m) {
    const d = validDate(+m[1], +m[3], +m[4]);
    if (d) {
      const sep = m[2] === "/" ? "/" : m[2] === "-" ? "-" : ".";
      const mm = m[3].length === 2 ? "mm" : "m";
      const dd = m[4].length === 2 ? "dd" : "d";
      return { value: d, numFmt: `yyyy${sep === "/" ? "/" : `\\${sep}`}${mm}${sep === "/" ? "/" : `\\${sep}`}${dd}` };
    }
  }
  m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(t);
  if (m) {
    const d = validDate(+m[1], +m[2], +m[3]);
    if (d) return { value: d, numFmt: 'yyyy"年"m"月"d"日"' };
  }
  return { value: text, numFmt: null };
}

function validDate(y: number, mo: number, d: number): Date | null {
  if (y < 1900 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

function fontOf(fmt: RunFmt | undefined): XFont {
  if (!fmt) return {};
  return {
    name: fmt.fontEastAsia ?? fmt.fontAscii ?? null,
    sizePt: fmt.sizePt,
    bold: fmt.bold,
    italic: fmt.italic,
    underline: fmt.underline,
    strike: fmt.strike,
    color: fmt.color,
    vertAlign: fmt.script === "super" ? "superscript" : fmt.script === "sub" ? "subscript" : null,
  };
}

const fontKey = (f: XFont) => JSON.stringify(f);

function borderSide(b: BorderFmt | null | undefined): XBorderSide | null {
  if (!b || b.widthPt <= 0) return null;
  const style = b.widthPt <= 0.3 ? "hair" : b.widthPt <= 1 ? "thin" : b.widthPt <= 1.6 ? "medium" : "thick";
  return { style, color: b.color };
}

/** 文字の幅のおおよそ（pt）。全角は文字の大きさ、半角はその0.55倍 */
function approxTextWidthPt(text: string, sizePt: number): number {
  let w = 0;
  for (const ch of text) w += /[\u0000-ÿ｡-ﾟ]/.test(ch) ? sizePt * 0.55 : sizePt;
  return w;
}

function buildTableModel(t: TableFmt, bodyIndex: number): TableModel {
  const cols = Math.max(t.gridPt.length, ...t.rows.map((r) => r.cells.reduce((n, c) => n + Math.max(1, c.gridSpan), 0)));
  const grid: (CellModel | null)[][] = t.rows.map(() => Array.from({ length: cols }, () => null));
  const merges: TableModel["merges"] = [];
  const open = new Map<number, TableModel["merges"][number]>();
  let sourceNonEmpty = 0;
  t.rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row.cells) {
      const span = Math.max(1, cell.gridSpan);
      if (c >= cols) break;
      if (cell.vMerge === "continue") {
        const m = open.get(c);
        if (m) m.r2 = r;
        // 続きのセルに文字が入っていることがある（まれ）：上のセルに足して、失わない
        const extra = cell.paragraphs.map(paragraphText).filter((x) => x.trim() !== "").join("\n");
        if (extra && m) {
          const anchor = grid[m.r1][m.c1];
          if (anchor) {
            anchor.text = anchor.text ? `${anchor.text}\n${extra}` : extra;
            anchor.value = anchor.text;
            anchor.numFmt = null;
          }
        }
        c += span;
        continue;
      }
      for (let k = 0; k < span; k++) open.delete(c + k);
      const runs: { text: string; fmt: RunFmt }[] = [];
      const images: CellModel["images"] = [];
      cell.paragraphs.forEach((p, i) => {
        if (i > 0) runs.push({ text: "\n", fmt: p.runs[0]?.fmt ?? cell.paragraphs[0]?.runs[0]?.fmt ?? ({} as RunFmt) });
        if (p.numbering?.label) runs.push({ text: `${p.numbering.label}${p.numbering.suffix === "nothing" ? "" : " "}`, fmt: p.runs[0]?.fmt ?? ({} as RunFmt) });
        for (const run of p.runs) {
          if (run.fmt.hidden) continue;
          const text = run.text.split(OBJECT_CHAR).join("").replace(/\t/g, " ");
          if (text) runs.push({ text, fmt: run.fmt });
        }
        for (const o of p.objects) if (o.rId) images.push({ rId: o.rId, widthPt: o.widthPt, heightPt: o.heightPt });
      });
      const text = runs.map((x) => x.text).join("");
      if (text.trim() !== "") sourceNonEmpty++;
      const { value, numFmt } = inferCellValue(text);
      grid[r][c] = { text, value, numFmt, runs, cell, images };
      if (span > 1 || cell.vMerge === "restart") {
        const m = { r1: r, c1: c, r2: r, c2: Math.min(cols - 1, c + span - 1) };
        merges.push(m);
        if (cell.vMerge === "restart") for (let k = 0; k < span; k++) open.set(c + k, m);
        if (cell.vMerge === "restart") open.set(c, m);
      }
      c += span;
    }
  });
  return { table: t, grid, cols, merges: merges.filter((m) => m.r2 > m.r1 || m.c2 > m.c1), sheetName: "", heading: null, joined: 0, bodyIndex, sourceNonEmpty };
}

function sameGrid(a: TableFmt, b: TableFmt): boolean {
  return a.gridPt.length > 0 && a.gridPt.length === b.gridPt.length && a.gridPt.every((w, i) => Math.abs(w - b.gridPt[i]) < 2);
}

const rowText = (t: TableModel, r: number) => t.grid[r]?.map((c) => c?.text ?? "").join("\u0001") ?? "";

interface ParsedDocument {
  tables: TableModel[];
  body: BodyFmt[];
  /** 表の位置（body の添字）→ 表の番号 */
  tableAt: Map<number, number>;
  rels: Record<string, { target: string; external: boolean }>;
  textBoxes: { bodyIndex: number; text: string }[];
  floatingShapes: number;
  hasHeaderFooter: boolean;
  bodyImageRefs: number;
}

function parseDocument(bytes: Uint8Array): ParsedDocument {
  const fmt = parseDocxFormatting(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const tables: TableModel[] = [];
  const tableAt = new Map<number, number>();
  let lastTableBodyIndex = -2;
  fmt.body.forEach((b, i) => {
    if (b.tag !== "tbl" || !b.table) return;
    const model = buildTableModel(b.table, i);
    const prev = tables[tables.length - 1];
    // 間に空の段落しか無く、列の形が同じ表は、ページをまたいで分かれた1つの表としてつなげる
    const onlyEmptyBetween = prev && fmt.body.slice(lastTableBodyIndex + 1, i).every((x) => x.tag === "p" && paragraphText(x.para).trim() === "" && x.para.objects.length === 0);
    if (prev && onlyEmptyBetween && sameGrid(prev.table, b.table)) {
      // 2つ目の表の先頭の行が、1つ目の見出しの行と同じなら（手で繰り返した見出し）、重ねない
      const dropFirst = model.grid.length > 0 && rowText(model, 0) === rowText(prev, 0) && rowText(prev, 0).replace(/\u0001/g, "").trim() !== "";
      const offset = prev.grid.length;
      const start = dropFirst ? 1 : 0;
      for (let r = start; r < model.grid.length; r++) prev.grid.push(model.grid[r]);
      for (const m of model.merges) {
        if (dropFirst && m.r1 === 0) continue;
        prev.merges.push({ r1: m.r1 - start + offset, c1: m.c1, r2: m.r2 - start + offset, c2: m.c2 });
      }
      prev.sourceNonEmpty += model.sourceNonEmpty - (dropFirst ? model.grid[0].filter((c) => c && c.text.trim() !== "").length : 0);
      prev.table = { ...prev.table, rows: [...prev.table.rows, ...b.table.rows.slice(start)] };
      prev.joined++;
      tableAt.set(i, tables.length - 1);
    } else {
      tables.push(model);
      tableAt.set(i, tables.length - 1);
    }
    lastTableBodyIndex = i;
  });
  const textBoxes = fmt.floats
    .filter((f) => f.kind !== "image")
    .map((f) => ({ bodyIndex: f.bodyIndex, text: f.paragraphs.map(paragraphText).filter((x) => x.trim() !== "").join("\n") }))
    .filter((t) => t.text !== "");
  const floatingShapes = fmt.floats.filter((f) => f.kind !== "image" && f.paragraphs.every((p) => paragraphText(p).trim() === "")).length;
  const hasHeaderFooter = Object.keys(fmt.headers).length > 0 || Object.keys(fmt.footers).length > 0;
  return { tables, body: fmt.body, tableAt, rels: fmt.rels, textBoxes, floatingShapes, hasHeaderFooter, bodyImageRefs: fmt.bodyImages.length };
}

/** 見出しらしい段落（表の直前の、短い1行） */
function headingBefore(body: BodyFmt[], index: number): string | null {
  for (let i = index - 1; i >= 0 && i >= index - 3; i--) {
    const b = body[i];
    if (b.tag !== "p") return null;
    const text = paragraphText(b.para).trim();
    if (text === "") continue;
    if (text.length > 40 || /[。．]$/.test(text)) return null;
    return text;
  }
  return null;
}

/** シートの名前を決めて、表の一覧を返す（画面の確認用。変換と同じ決め方） */
function nameTables(doc: ParsedDocument): void {
  const used = new Set<string>();
  const hasBody = doc.body.some((b) => b.tag === "p" && paragraphText(b.para).trim() !== "") || doc.textBoxes.length > 0;
  if (hasBody) used.add(BODY_SHEET_NAME.toLowerCase());
  doc.tables.forEach((t, i) => {
    t.heading = headingBefore(doc.body, t.bodyIndex);
    t.sheetName = safeSheetName(t.heading ?? "", used, `表${i + 1}`);
  });
}

export async function readWordDocumentInfo(file: File): Promise<WordDocumentInfo> {
  const bytes = await checkOfficeFile(file, "word");
  let doc: ParsedDocument;
  try {
    doc = parseDocument(bytes);
  } catch {
    throw new Error(`${file.name} の内容を読み取れませんでした。ファイルが壊れている可能性があります。`);
  }
  nameTables(doc);
  return {
    tables: doc.tables.map((t, i) => ({ index: i + 1, sheetName: t.sheetName, rows: t.grid.length, cols: t.cols, merges: t.merges.length, joinedWithPrevious: t.joined })),
    paragraphCount: doc.body.filter((b) => b.tag === "p" && paragraphText(b.para).trim() !== "").length,
    imageCount: doc.bodyImageRefs,
    textBoxCount: doc.textBoxes.length,
  };
}

/**
 * 表以外の文章（段落・テキストボックスの文字）を、文書の順に返す（空の段落は除く）。
 * Word→Excelの「AIで表にする」補助（プレミアム）で、AIへ送る内容を画面に出すために使う。ファイルはサーバーへ送らない。
 */
export async function readWordBodyParagraphs(file: File): Promise<string[]> {
  const bytes = await checkOfficeFile(file, "word");
  let doc: ParsedDocument;
  try {
    doc = parseDocument(bytes);
  } catch {
    throw new Error(`${file.name} の内容を読み取れませんでした。ファイルが壊れている可能性があります。`);
  }
  const out: { index: number; text: string }[] = [];
  doc.body.forEach((b, i) => {
    if (b.tag !== "p") return;
    const text = paragraphText(b.para).trim();
    if (text !== "") out.push({ index: i, text });
  });
  for (const t of doc.textBoxes) out.push({ index: t.bodyIndex + 0.5, text: t.text.trim() });
  return out.sort((a, b) => a.index - b.index).map((x) => x.text);
}

function imageMime(path: string): XImage["mime"] | null {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  return null;
}

export class WordToExcelProcessor {
  async process({ file, onProgress }: { file: File; onProgress?: (label: string) => void }): Promise<WordToExcelOutput> {
    const bytes = await checkOfficeFile(file, "word");
    onProgress?.("Word文書を読み込んでいます…");
    let doc: ParsedDocument;
    try {
      doc = parseDocument(bytes);
    } catch {
      throw new Error(`${file.name} の内容を読み取れませんでした。ファイルが壊れている可能性があります。`);
    }
    nameTables(doc);
    const totalCells = doc.tables.reduce((n, t) => n + t.grid.length * t.cols, 0);
    if (totalCells > MAX_TABLE_CELLS) {
      throw new Error(`表のセルが多すぎるため、ブラウザの中では安全に変換できません（${totalCells.toLocaleString()}セル。上限${MAX_TABLE_CELLS.toLocaleString()}セル）。`);
    }
    const warnings: string[] = [];
    const media = unzipSync(bytes, { filter: (f) => f.name.startsWith("word/media/") });
    const imageBytes = (rId: string): { bytes: Uint8Array; mime: XImage["mime"] } | null | "unsupported" => {
      const rel = doc.rels[rId];
      if (!rel || rel.external) return null;
      // 解析（docx-format.ts）は、参照先を「word/media/…」の形にそろえて返す
      const t = rel.target.replace(/^\//, "").replace(/^\.\//, "");
      const path = t.startsWith("word/") ? t : `word/${t}`;
      const data = media[path];
      if (!data) return null;
      const mime = imageMime(path);
      return mime ? { bytes: data, mime } : "unsupported";
    };
    let unsupportedImages = 0;
    let missingImages = 0;

    onProgress?.("Excelのシートを作っています…");
    const sheets: XSheet[] = [];
    // 表のシート
    for (const t of doc.tables) {
      sheets.push(tableSheet(t, imageBytes, () => unsupportedImages++, () => missingImages++));
    }
    // 本文のシート
    const hasBody = doc.body.some((b) => b.tag === "p" && paragraphText(b.para).trim() !== "") || doc.textBoxes.length > 0;
    let bodySheet: string | null = null;
    if (hasBody) {
      bodySheet = BODY_SHEET_NAME;
      sheets.push(bodySheetOf(doc, imageBytes, () => unsupportedImages++, () => missingImages++));
    }
    if (sheets.length === 0) throw new Error("この文書には、表も文章も見つかりませんでした。");
    if (doc.tables.length === 0) warnings.push("この文書には表が無いため、文章を「本文」のシートに段落ごとに入れました。");
    if (unsupportedImages > 0) warnings.push(`PNG・JPEG・GIF以外の画像（EMF・WMF・SVGなど${unsupportedImages}個）は、Excelに入れていません。`);
    if (missingImages > 0) warnings.push(`文書の外にある画像（リンクの画像など${missingImages}個）は入れていません。`);
    if (doc.floatingShapes > 0) warnings.push(`文字の無い図形（${doc.floatingShapes}個）は入れていません。`);
    if (doc.textBoxes.length > 0) warnings.push(`テキストボックスの文字（${doc.textBoxes.length}個）は、「本文」のシートの、置かれていた段落の位置に入れました。`);
    if (doc.hasHeaderFooter) warnings.push("ヘッダー・フッターの文字は、Excelに入れていません。");
    const joined = doc.tables.reduce((n, t) => n + t.joined, 0);
    if (joined > 0) warnings.push(`ページの境目などで分かれていた同じ形の表（${joined}か所）は、1つの表としてつなげました。`);

    // 本文のシートを最後に置く（表のシートを先に）
    const blobBytes = writeXlsx(sheets);
    const blob = new Blob([blobBytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    onProgress?.("できあがったExcelファイルを確かめています…");
    const checks = await verify(blob, blobBytes, doc, sheets, bodySheet);
    return {
      blob,
      tables: doc.tables.map((t, i) => ({ index: i + 1, sheetName: t.sheetName, rows: t.grid.length, cols: t.cols, merges: t.merges.length, joinedWithPrevious: t.joined })),
      checks,
      warnings,
      bodySheet,
    };
  }
}

function tableSheet(t: TableModel, imageBytes: (rId: string) => { bytes: Uint8Array; mime: XImage["mime"] } | null | "unsupported", onUnsupported: () => void, onMissing: () => void): XSheet {
  const tf = t.table;
  const widthsPt = Array.from({ length: t.cols }, (_, c) => tf.gridPt[c] ?? 80);
  const rows: (XCell | null)[][] = [];
  const rowHeights = new Map<number, { pt: number; custom: boolean }>();
  const images: XImage[] = [];
  const lastRow = t.grid.length - 1;
  // 結合の範囲（左上のセル → 範囲）
  const mergeAt = new Map(t.merges.map((m) => [`${m.r1}:${m.c1}`, m]));
  const covered = new Set<string>();
  for (const m of t.merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);

  t.grid.forEach((gridRow, r) => {
    const out: (XCell | null)[] = [];
    let rowNeedPt = 0;
    const rowFmt = tf.rows[r];
    gridRow.forEach((cm, c) => {
      const m = mergeAt.get(`${r}:${c}`);
      const lastC = m ? m.c2 : c;
      const lastR = m ? m.r2 : r;
      // 罫線：セルに直接の指定があればそれ、無ければ表の外枠・内側の罫線
      const cellB = cm?.cell.borders ?? {};
      const border: XStyle["border"] = {
        top: cellB.top !== undefined ? borderSide(cellB.top) : borderSide(r === 0 ? tf.borders.top : tf.borders.insideH),
        bottom: cellB.bottom !== undefined ? borderSide(cellB.bottom) : borderSide(lastR === lastRow ? tf.borders.bottom : tf.borders.insideH),
        left: cellB.left !== undefined ? borderSide(cellB.left) : borderSide(c === 0 ? tf.borders.left : tf.borders.insideV),
        right: cellB.right !== undefined ? borderSide(cellB.right) : borderSide(lastC === t.cols - 1 ? tf.borders.right : tf.borders.insideV),
      };
      if (!cm) {
        // 結合で隠れるセルにも、外枠の罫線を付ける（Excelは結合の外枠を、それぞれのセルの罫線で描く）
        out.push(covered.has(`${r}:${c}`) || border.top || border.bottom || border.left || border.right ? { v: null, style: { border } } : null);
        return;
      }
      const visibleRuns = cm.runs.filter((x) => x.text !== "");
      const mainFmt = visibleRuns.find((x) => x.text.trim() !== "")?.fmt ?? cm.cell.paragraphs[0]?.runs[0]?.fmt;
      const mainFont = fontOf(mainFmt);
      const fonts = visibleRuns.filter((x) => x.text !== "\n").map((x) => fontOf(x.fmt));
      const mixed = fonts.some((f) => fontKey(f) !== fontKey(fonts[0] ?? {}));
      const highlight = visibleRuns.length > 0 && visibleRuns.every((x) => x.fmt.highlight && x.fmt.highlight === visibleRuns[0].fmt.highlight) ? visibleRuns[0].fmt.highlight : null;
      const para = cm.cell.paragraphs[0];
      const hAlign = para?.align === "center" ? "center" : para?.align === "right" ? "right" : para?.align === "justify" ? "justify" : para?.align === "left" ? "left" : null;
      const isText = typeof cm.value === "string";
      const colWidthPt = widthsPt.slice(c, lastC + 1).reduce((s, w) => s + w, 0);
      const size = mainFont.sizePt ?? 10.5;
      const lines = cm.text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(approxTextWidthPt(line, size) / Math.max(10, colWidthPt - 6))), 0);
      const wrap = isText && (lines > 1 || cm.text.includes("\n"));
      if (!m || m.r2 === m.r1) rowNeedPt = Math.max(rowNeedPt, lines * size * 1.35 + 3);
      out.push({
        v: cm.value,
        rich: isText && mixed ? visibleRuns.map((x) => ({ text: x.text, font: fontOf(x.fmt) })) : null,
        style: {
          font: mainFont,
          fill: cm.cell.fill ?? highlight,
          border,
          hAlign,
          vAlign: cm.cell.vAlign === "center" ? "center" : cm.cell.vAlign === "bottom" ? "bottom" : "top",
          wrap,
          numFmt: cm.numFmt ?? (isText && /^\d/.test(cm.text.trim()) ? "@" : null),
        },
      });
      for (const img of cm.images) {
        const data = imageBytes(img.rId);
        if (data === "unsupported") onUnsupported();
        else if (!data) onMissing();
        else images.push({ ...data, row: r, col: c, widthPx: Math.max(8, Math.round((img.widthPt * 96) / 72)), heightPx: Math.max(8, Math.round((img.heightPt * 96) / 72)) });
      }
      if (cm.images.length > 0) rowNeedPt = Math.max(rowNeedPt, ...cm.images.map((i) => i.heightPt + 4));
    });
    rows.push(out);
    const exact = rowFmt?.heightRule === "exact" && rowFmt.heightPt;
    const pt = exact ? rowFmt.heightPt! : Math.max(rowFmt?.heightPt ?? 0, rowNeedPt);
    if (exact || pt > DEFAULT_ROW_PT + 0.5) rowHeights.set(r, { pt: Math.min(409, pt), custom: Boolean(exact) });
  });
  return {
    name: t.sheetName,
    rows,
    merges: t.merges,
    colWidths: widthsPt.map((w) => ptToColumnWidth(w)),
    rowHeights,
    images,
  };
}

function bodySheetOf(doc: ParsedDocument, imageBytes: (rId: string) => { bytes: Uint8Array; mime: XImage["mime"] } | null | "unsupported", onUnsupported: () => void, onMissing: () => void): XSheet {
  const rows: (XCell | null)[][] = [];
  const rowHeights = new Map<number, { pt: number; custom: boolean }>();
  const images: XImage[] = [];
  const COL_PT = 520;
  const textBoxesAt = new Map<number, string[]>();
  for (const tb of doc.textBoxes) textBoxesAt.set(tb.bodyIndex, [...(textBoxesAt.get(tb.bodyIndex) ?? []), tb.text]);
  let lastEmpty = true;
  const shownTables = new Set<number>();
  doc.body.forEach((b, i) => {
    if (b.tag === "tbl") {
      const ti = doc.tableAt.get(i);
      if (ti === undefined || shownTables.has(ti)) return;
      shownTables.add(ti);
      const t = doc.tables[ti];
      rows.push([{ v: `［表${ti + 1}（${t.grid.length}行×${t.cols}列）→ シート「${t.sheetName}」］`, style: { font: { italic: true, color: "808080" } } }]);
      lastEmpty = false;
      return;
    }
    const p = b.para;
    const text = paragraphText(p);
    if (text.trim() === "" && p.objects.length === 0 && !textBoxesAt.has(i)) {
      if (!lastEmpty) rows.push([null]);
      lastEmpty = true;
      return;
    }
    if (text.trim() !== "") {
      const runs = p.runs.filter((x) => !x.fmt.hidden && x.text.split(OBJECT_CHAR).join("") !== "");
      const fonts = runs.map((x) => fontOf(x.fmt));
      const mixed = fonts.some((f) => fontKey(f) !== fontKey(fonts[0] ?? {}));
      const isHeading = /heading|見出し|title|表題/i.test(p.styleId ?? "");
      const main = fontOf(runs.find((x) => x.text.trim() !== "")?.fmt);
      const size = main.sizePt ?? 10.5;
      const label = p.numbering?.label ? `${p.numbering.label}${p.numbering.suffix === "nothing" ? "" : " "}` : "";
      const r = rows.length;
      rows.push([
        {
          v: text,
          rich: mixed ? [...(label ? [{ text: label, font: main }] : []), ...runs.map((x) => ({ text: x.text.split(OBJECT_CHAR).join("").replace(/\t/g, " "), font: fontOf(x.fmt) }))] : null,
          style: {
            font: { ...main, bold: main.bold || isHeading },
            hAlign: p.align === "center" ? "center" : p.align === "right" ? "right" : null,
            vAlign: "top",
            wrap: true,
            fill: p.fill,
            indent: p.leftPt && p.leftPt > 0 ? Math.min(15, Math.round(p.leftPt / 10.5)) : 0,
          },
        },
      ]);
      const lines = Math.max(1, Math.ceil(approxTextWidthPt(text, size) / COL_PT));
      const pt = lines * size * 1.4 + 3;
      if (pt > DEFAULT_ROW_PT + 0.5) rowHeights.set(r, { pt: Math.min(409, pt), custom: false });
    }
    // 段落の中の画像
    for (const o of p.objects) {
      if (!o.rId) continue;
      const data = imageBytes(o.rId);
      if (data === "unsupported") {
        onUnsupported();
        continue;
      }
      if (!data) {
        onMissing();
        continue;
      }
      const maxW = 640;
      let w = Math.max(8, Math.round((o.widthPt * 96) / 72));
      let h = Math.max(8, Math.round((o.heightPt * 96) / 72));
      if (w > maxW) {
        h = Math.round((h * maxW) / w);
        w = maxW;
      }
      const r = rows.length;
      images.push({ ...data, row: r, col: 0, widthPx: w, heightPx: h });
      // 画像の高さの分だけ行を空けて、次の文章と重ならないようにする
      const heightPt = (h * 72) / 96;
      const n = Math.max(1, Math.ceil(heightPt / DEFAULT_ROW_PT));
      for (let k = 0; k < n; k++) rows.push([null]);
    }
    for (const tb of textBoxesAt.get(i) ?? []) {
      const r = rows.length;
      rows.push([{ v: tb, style: { wrap: true, vAlign: "top", border: { top: { style: "thin", color: "808080" }, bottom: { style: "thin", color: "808080" }, left: { style: "thin", color: "808080" }, right: { style: "thin", color: "808080" } } } }]);
      const lines = tb.split("\n").length;
      if (lines > 1) rowHeights.set(r, { pt: Math.min(409, lines * 10.5 * 1.4 + 3), custom: false });
    }
    lastEmpty = false;
  });
  return { name: BODY_SHEET_NAME, rows, merges: [], colWidths: [ptToColumnWidth(COL_PT)], rowHeights, images };
}

type ReadXlsx = (file: File | Blob) => Promise<{ sheet: string; data: unknown[][] }[]>;

async function verify(blob: Blob, bytes: Uint8Array, doc: ParsedDocument, sheets: XSheet[], bodySheet: string | null): Promise<ConversionCheck[]> {
  const checks: ConversionCheck[] = [];
  const files = unzipSync(bytes, { filter: (f) => f.name === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) || f.name.startsWith("xl/media/") });
  const names = [...strFromU8(files["xl/workbook.xml"]).matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'));
  const expectedNames = [...doc.tables.map((t) => t.sheetName), ...(bodySheet ? [bodySheet] : [])];
  checks.push({ label: "表の数とシートの順番", ok: names.length === expectedNames.length && names.every((n, i) => n === expectedNames[i]), detail: `表${doc.tables.length}個 → シート${names.length}枚` });

  let values: { sheet: string; data: unknown[][] }[] = [];
  try {
    const { default: readXlsxFile } = (await import("read-excel-file/universal")) as unknown as { default: ReadXlsx };
    values = await readXlsxFile(blob);
  } catch {
    checks.push({ label: "できあがったExcelファイルを開けるか", ok: false, detail: "読み込めませんでした" });
    return checks;
  }
  checks.push({ label: "できあがったExcelファイルを開けるか", ok: true });

  let sizeOk = true;
  let mismatched = 0;
  let expectedNonEmpty = 0;
  let writtenNonEmpty = 0;
  doc.tables.forEach((t, ti) => {
    const data = values[ti]?.data ?? [];
    expectedNonEmpty += t.sourceNonEmpty;
    // 行数・列数（read-excel-file は末尾の空の行・列を省く。書き出したセルの範囲と比べる）
    const sheetXml = strFromU8(files[`xl/worksheets/sheet${ti + 1}.xml`] ?? new Uint8Array());
    const rowNums = [...sheetXml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
    const lastWrittenRow = rowNums.length ? Math.max(...rowNums) : 0;
    const lastSourceRow = t.grid.reduce((n, row, r) => (row.some((c) => c && c.text !== "") || row.some((c) => c === null) ? r + 1 : n), 0);
    if (lastWrittenRow < lastSourceRow) sizeOk = false;
    t.grid.forEach((row, r) =>
      row.forEach((cm, c) => {
        if (!cm || cm.text.trim() === "") return;
        const got = data[r]?.[c];
        if (got !== null && got !== undefined && String(got) !== "") writtenNonEmpty++;
        const ok =
          typeof cm.value === "number"
            ? typeof got === "number" && Math.abs(got - cm.value) < 1e-9
            : cm.value instanceof Date
              ? got instanceof Date && got.getTime() === cm.value.getTime()
              : String(got ?? "") === cm.text;
        if (!ok) mismatched++;
      })
    );
  });
  checks.push({ label: "表の行数・列数", ok: sizeOk, detail: doc.tables.map((t) => `${t.sheetName}：${t.grid.length}行×${t.cols}列`).join("、") || "表なし" });
  checks.push({
    label: "セルの文字（欠け・数値や日付の変換の誤り）",
    ok: mismatched === 0 && writtenNonEmpty >= expectedNonEmpty,
    detail: mismatched === 0 ? `文字のあるセル${expectedNonEmpty.toLocaleString()}個` : `${mismatched}個のセルが元の文字と違います`,
  });
  const mergesWritten = sheets.slice(0, doc.tables.length).reduce((n, _s, i) => n + [...strFromU8(files[`xl/worksheets/sheet${i + 1}.xml`] ?? new Uint8Array()).matchAll(/<mergeCell ref=/g)].length, 0);
  const mergesExpected = doc.tables.reduce((n, t) => n + t.merges.length, 0);
  checks.push({ label: "結合したセル", ok: mergesWritten === mergesExpected, detail: `元${mergesExpected}か所 → Excel${mergesWritten}か所` });
  const imagesExpected = sheets.reduce((n, s) => n + s.images.length, 0);
  const imagesWritten = Object.keys(files).filter((f) => f.startsWith("xl/media/")).length;
  checks.push({ label: "画像", ok: imagesWritten === imagesExpected, detail: imagesExpected === 0 ? "画像なし" : `${imagesWritten}個` });
  return checks;
}
