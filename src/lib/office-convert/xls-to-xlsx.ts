import { strFromU8, unzipSync } from "fflate";
import { readXls, XlsError, type XlsFont, type XlsWorkbook, type XlsXf } from "./xls-reader";
import { safeSheetName, writeXlsx, type XCell, type XFont, type XSheet, type XStyle } from "./xlsx-writer";
import type { ConversionCheck } from "./excel-to-word";

/**
 * Excel旧形式（.xls）→ 新形式（.xlsx）の変換。
 *
 * .xls を読み（xls-reader.ts）、Word→Excel変換でも使っている .xlsx の書き出し（xlsx-writer.ts）で書く。
 * 拡張子を変えるだけではなく、セルの値・数式・書式・列の幅・行の高さ・結合・シートの表示を、1つずつ移し替える。
 * 書き出したファイルは、もう一度開いて、シート・セル・数式・結合の数が元と同じかを確かめる（変換後の確認）。
 * 処理はすべてブラウザの中で行い、ファイルはサーバーへ送らない。
 */

export const MAX_XLS_FILE_MB = 30;

export interface XlsToXlsxSheetReport {
  name: string;
  hidden: boolean;
  rows: number;
  cols: number;
  cells: number;
  formulas: number;
  merges: number;
}

export interface XlsToXlsxOutput {
  blob: Blob;
  sheets: XlsToXlsxSheetReport[];
  checks: ConversionCheck[];
  warnings: string[];
}

function toFont(f: XlsFont): XFont {
  return {
    name: f.name,
    sizePt: f.sizePt,
    bold: f.bold,
    italic: f.italic,
    strike: f.strike,
    underline: f.underline === "none" ? false : f.underline === "double" ? "double" : true,
    color: f.color,
    vertAlign: f.vertAlign,
  };
}

function toStyle(xf: XlsXf | undefined): XStyle | null {
  if (!xf) return null;
  const style: XStyle = { font: toFont(xf.font) };
  if (xf.numFmt.code) style.numFmt = xf.numFmt.code;
  else if (xf.numFmt.id) style.numFmtId = xf.numFmt.id;
  if (xf.hAlign !== "general") style.hAlign = xf.hAlign;
  if (xf.vAlign !== "bottom") style.vAlign = xf.vAlign;
  if (xf.wrap) style.wrap = true;
  if (xf.shrink) style.shrink = true;
  if (xf.indent) style.indent = xf.indent;
  if (xf.rotation) style.rotation = xf.rotation;
  if (xf.fill && xf.fill.pattern !== "none") {
    style.fill = xf.fill.fg ?? "FFFFFF";
    if (xf.fill.pattern !== "solid") {
      style.fillPattern = xf.fill.pattern;
      if (xf.fill.bg) style.fillBg = xf.fill.bg;
    }
  }
  const b = xf.border;
  if (b.left || b.right || b.top || b.bottom) {
    style.border = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
  }
  return style;
}

/** 読み取ったブックを、書き出しの形（XSheet）にする */
export function workbookToSheets(book: XlsWorkbook): { sheets: XSheet[]; reports: XlsToXlsxSheetReport[] } {
  const used = new Set<string>();
  const styleCache = new Map<number, XStyle | null>();
  const styleOf = (xf: number) => {
    if (!styleCache.has(xf)) styleCache.set(xf, toStyle(book.xfs[xf]));
    return styleCache.get(xf) ?? null;
  };
  const sheets: XSheet[] = [];
  const reports: XlsToXlsxSheetReport[] = [];
  book.sheets.forEach((s, i) => {
    const rows: (XCell | null)[][] = [];
    let cells = 0;
    let formulas = 0;
    for (const [r, rowMap] of s.cells) {
      const row: (XCell | null)[] = (rows[r] = []);
      for (const [c, cell] of rowMap) {
        const v = cell.value;
        const x: XCell = { v: null, style: styleOf(cell.xf) };
        if (v.t === "n") x.v = v.v;
        else if (v.t === "b") x.v = v.v;
        else if (v.t === "e") {
          x.v = v.v;
          x.error = true;
        } else if (v.t === "s") {
          x.v = v.v;
          if (v.rich) x.rich = v.rich.map((run) => ({ text: run.text, font: toFont(run.font) }));
        }
        if (cell.formula && !cell.formulaLost) {
          x.f = cell.formula;
          formulas++;
        }
        if (v.t !== "blank") cells++;
        row[c] = x;
      }
    }
    for (let r = 0; r <= s.maxRow; r++) if (!rows[r]) rows[r] = [];

    const colWidths: (number | null)[] = [];
    const hiddenCols = new Set<number>();
    for (const col of s.cols) {
      for (let c = col.first; c <= col.last && c < 256; c++) {
        colWidths[c] = Math.round(col.width * 100) / 100;
        if (col.hidden) hiddenCols.add(c);
      }
    }
    const rowHeights = new Map<number, { pt: number; custom: boolean; hidden?: boolean }>();
    for (const [r, info] of s.rows) rowHeights.set(r, { pt: info.heightPt, custom: info.custom, hidden: info.hidden });

    const name = safeSheetName(s.name, used, `Sheet${i + 1}`);
    sheets.push({
      name,
      rows,
      merges: s.merges,
      colWidths,
      rowHeights,
      images: [],
      hiddenCols,
      state: s.state,
      baseColWidth: s.defaultColWidth,
      defaultRowHeightPt: s.defaultRowHeightPt,
    });
    reports.push({ name, hidden: s.state !== "visible", rows: s.maxRow + 1, cols: s.maxCol + 1, cells, formulas, merges: s.merges.length });
  });
  return { sheets, reports };
}

/** 書き出した .xlsx をもう一度開いて、シート・セル・数式・結合の数を数える */
export function inspectXlsx(bytes: Uint8Array): { sheets: { name: string; values: number; formulas: number; merges: number }[] } | null {
  try {
    const files = unzipSync(bytes);
    const workbook = strFromU8(files["xl/workbook.xml"]);
    const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    return {
      sheets: names.map((name, i) => {
        const xml = strFromU8(files[`xl/worksheets/sheet${i + 1}.xml`] ?? new Uint8Array());
        return {
          name,
          values: (xml.match(/<v>/g) ?? []).length,
          formulas: (xml.match(/<f>/g) ?? []).length,
          merges: (xml.match(/<mergeCell /g) ?? []).length,
        };
      }),
    };
  } catch {
    return null;
  }
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function convertXlsToXlsx(bytes: Uint8Array): XlsToXlsxOutput {
  const book = readXls(bytes);
  const { sheets, reports } = workbookToSheets(book);
  const defaultFont = book.xfs[0]?.font;
  const out = writeXlsx(sheets, { date1904: book.date1904, defaultFont: defaultFont ? toFont(defaultFont) : undefined });

  // 変換後の確認：書き出したファイルを開き直して数える
  const inspected = inspectXlsx(out);
  const checks: ConversionCheck[] = [];
  const expectedValues = reports.reduce((n, r) => n + r.cells, 0);
  const expectedFormulas = reports.reduce((n, r) => n + r.formulas, 0);
  const expectedMerges = reports.reduce((n, r) => n + r.merges, 0);
  if (!inspected) {
    checks.push({ label: "書き出したファイルを開き直せること", ok: false });
  } else {
    checks.push({ label: "書き出したファイルを開き直せること", ok: true });
    const sameSheets = inspected.sheets.length === sheets.length && inspected.sheets.every((s, i) => unescapeXml(s.name) === sheets[i].name);
    checks.push({ label: `シートの数（${sheets.length}枚）と名前`, ok: sameSheets });
    const values = inspected.sheets.reduce((n, s) => n + s.values, 0);
    checks.push({ label: `値のあるセル（${expectedValues.toLocaleString()}個）`, ok: values === expectedValues, detail: values === expectedValues ? undefined : `書き出し後 ${values.toLocaleString()}個` });
    const formulas = inspected.sheets.reduce((n, s) => n + s.formulas, 0);
    checks.push({ label: `数式（${expectedFormulas.toLocaleString()}個）`, ok: formulas === expectedFormulas });
    const merges = inspected.sheets.reduce((n, s) => n + s.merges, 0);
    checks.push({ label: `セルの結合（${expectedMerges.toLocaleString()}か所）`, ok: merges === expectedMerges });
  }

  const warnings: string[] = [];
  if (book.formulasLost > 0) {
    warnings.push(
      `数式${book.formulasLost.toLocaleString()}個は、文字に戻せない形（ほかのブックの参照・配列の数式・一部の関数など）のため、保存されていた計算結果の値にしました（セルの値は元と同じです）。`
    );
  }
  for (const s of book.skippedSheets) warnings.push(`「${s.name}」は${s.kind}のため、変換していません。`);
  const sum = (k: keyof XlsWorkbook["sheets"][number]["unsupported"]) => book.sheets.reduce((n, s) => n + s.unsupported[k], 0);
  const lost: string[] = [];
  if (sum("images")) lost.push(`画像${sum("images")}個`);
  if (sum("charts")) lost.push(`グラフ${sum("charts")}個`);
  if (sum("shapes")) lost.push(`図形・テキストボックスなど${sum("shapes")}個`);
  if (sum("comments")) lost.push(`コメント${sum("comments")}個`);
  if (sum("hyperlinks")) lost.push(`ハイパーリンク${sum("hyperlinks")}個（文字は残ります）`);
  if (sum("dataValidations")) lost.push("入力規則（プルダウンなど）");
  if (sum("conditionalFormats")) lost.push("条件付き書式");
  if (lost.length) warnings.push(`次のものは引き継げませんでした：${lost.join("・")}。必要な場合は、Excelで元のファイルから設定し直してください。`);
  if (book.hasMacros) warnings.push("マクロ（VBA）は引き継げません（.xlsx形式はマクロを保存できません）。");
  warnings.push("印刷の設定（用紙・余白・印刷範囲）、ウィンドウ枠の固定、シートの保護は引き継いでいません。");

  return { blob: new Blob([out as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), sheets: reports, checks, warnings };
}

export async function convertXlsFile(file: File): Promise<XlsToXlsxOutput> {
  const ext = file.name.toLowerCase().split(".").pop();
  if (file.size === 0) throw new XlsError("空のファイルは変換できません。");
  if (file.size > MAX_XLS_FILE_MB * 1024 * 1024) throw new XlsError(`ファイルが大きすぎます（上限${MAX_XLS_FILE_MB}MB）。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new XlsError("このファイルは、すでに新しい形式（.xlsx）です。変換の必要はありません。");
  }
  if (ext !== "xls") throw new XlsError("Excel旧形式のファイル（.xls）を選択してください。");
  return convertXlsToXlsx(bytes);
}
