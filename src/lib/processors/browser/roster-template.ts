/**
 * 名簿テンプレート作成 Processor（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * CSV/Excelから読み込んだ表データのうち、使用する列だけを選び、
 * 見出しラベル・行高さ・列幅（すべてmm指定）を設定して、
 * 印刷向けの名簿シートをExcel・PDFのどちらでも書き出せるようにする。
 *
 * Excel出力は xlsx-simple-io.ts の writeXlsxSheets（列幅指定つき）を、
 * PDF出力は document-pdf.ts と同じ pdf-lib + 日本語フォント埋め込みの
 * パターンをそのまま踏襲する。「テンプレート化・自動配置」は、
 * ここで設定した列構成をもとに全データ行を機械的に敷き詰めて配置する、
 * という意味で実装する（保存・再利用可能な永続テンプレート機能ではない。
 * ブラウザのみで完結し外部保存は行わない、という指示書の方針のため）。
 */
import { PDFDocument, type PDFFont, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { wrapTextByWidth, createTextDrawer } from "@/lib/pdf/text-draw";
import { mmToPt, resolvePaperSizePt } from "@/lib/print/paper-sizes";
import { writeXlsxSheets, mmToExcelColumnWidth } from "@/lib/excel/xlsx-simple-io";
import { sanitizeFileName } from "@/lib/utils/format";

export interface RosterColumnSetting {
  sourceHeader: string;
  label: string;
  widthMm: number;
}

export interface RosterTemplateInput {
  headers: string[];
  rows: string[][];
  columns: RosterColumnSetting[];
  rowHeightMm: number;
  headerHeightMm: number;
  format: "excel" | "pdf";
}

export interface RosterTemplateOutput {
  blob: Blob;
  url?: string;
  pageCount?: number;
}

const PAGE_MARGIN_MM = 15;
const MAX_ROWS = 3000;

export function validateRosterTemplateInput(input: RosterTemplateInput): string | null {
  if (input.columns.length === 0) {
    return "使用する列を1つ以上選択してください";
  }
  if (!(input.rowHeightMm > 0) || !(input.headerHeightMm > 0)) {
    return "行の高さ・見出しの高さは0より大きい値を指定してください";
  }
  if (input.columns.some((c) => !(c.widthMm > 0))) {
    return "すべての列の幅は0より大きい値を指定してください";
  }
  if (input.rows.length === 0) {
    return "データ行がありません";
  }
  if (input.rows.length > MAX_ROWS) {
    return `データ行が多すぎます（最大${MAX_ROWS}行まで）`;
  }
  if (input.format === "pdf") {
    const pageSize = resolvePaperSizePt("A4", "portrait");
    const contentWidthPt = pageSize.width - mmToPt(PAGE_MARGIN_MM) * 2;
    const totalWidthPt = input.columns.reduce((sum, c) => sum + mmToPt(c.widthMm), 0);
    if (totalWidthPt > contentWidthPt) {
      return "列の幅の合計がA4の印刷可能幅を超えています。列幅を小さくするか、列数を減らしてください";
    }
  }
  return null;
}

function getColumnIndex(headers: string[], sourceHeader: string): number {
  return headers.indexOf(sourceHeader);
}

async function buildExcel(input: RosterTemplateInput): Promise<Blob> {
  const colIndexes = input.columns.map((c) => getColumnIndex(input.headers, c.sourceHeader));
  const columns = input.columns.map((c) => ({ width: mmToExcelColumnWidth(c.widthMm) }));

  const headerRow = input.columns.map((c, i) => ({
    value: c.label,
    fontWeight: "bold" as const,
    backgroundColor: "#EEF1F6",
    align: "center" as const,
    alignVertical: "center" as const,
    borderStyle: "thin" as const,
    borderColor: "#999999",
    ...(i === 0 ? { height: mmToPt(input.headerHeightMm) } : {}),
  }));

  const bodyRows = input.rows.map((row) =>
    input.columns.map((_, i) => {
      const idx = colIndexes[i];
      const value = idx >= 0 ? (row[idx] ?? "") : "";
      return {
        value,
        align: "left" as const,
        alignVertical: "center" as const,
        wrap: true,
        borderStyle: "thin" as const,
        borderColor: "#cccccc",
        ...(i === 0 ? { height: mmToPt(input.rowHeightMm) } : {}),
      };
    })
  );

  return writeXlsxSheets([{ name: "名簿", rows: [headerRow, ...bodyRows], columns }]);
}

async function buildPdf(input: RosterTemplateInput): Promise<{ blob: Blob; pageCount: number }> {
  let fontBytes: ArrayBuffer;
  try {
    fontBytes = await loadJapaneseFontBytes();
  } catch {
    throw new Error("日本語フォントの読み込みに失敗しました。通信環境をご確認の上、もう一度お試しください。");
  }

  let doc: PDFDocument;
  let font: PDFFont;
  try {
    doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(new Uint8Array(fontBytes), { subset: false });
  } catch {
    throw new Error("PDFの生成に失敗しました（フォントの埋め込みでエラーが発生しました）");
  }

  const pageSize = resolvePaperSizePt("A4", "portrait");
  const marginPt = mmToPt(PAGE_MARGIN_MM);
  const headerHeightPt = mmToPt(input.headerHeightMm);
  const rowHeightPt = mmToPt(input.rowHeightMm);
  const colWidthsPt = input.columns.map((c) => mmToPt(c.widthMm));
  const colXs: number[] = [];
  let xAcc = marginPt;
  for (const w of colWidthsPt) {
    colXs.push(xAcc);
    xAcc += w;
  }
  const colIndexes = input.columns.map((c) => getColumnIndex(input.headers, c.sourceHeader));

  function drawHeaderRow(page: import("pdf-lib").PDFPage, topY: number) {
    const { drawText, drawLine } = createTextDrawer(page, font);
    page.drawRectangle({
      x: marginPt,
      y: topY - headerHeightPt,
      width: xAcc - marginPt,
      height: headerHeightPt,
      color: rgb(0.93, 0.94, 0.96),
    });
    input.columns.forEach((c, i) => {
      const cx = colXs[i];
      const cw = colWidthsPt[i];
      const lines = wrapTextByWidth(c.label, font, 9, cw - 6);
      const startY = topY - headerHeightPt / 2 + (lines.length - 1) * 5.5;
      lines.forEach((line, li) => drawText(line, cx + cw / 2, startY - li * 11, 9, { align: "center" }));
    });
    for (let i = 0; i <= input.columns.length; i++) {
      const x = i === input.columns.length ? xAcc : colXs[i];
      drawLine(x, topY, x, topY - headerHeightPt, [0.6, 0.6, 0.62], 0.75);
    }
    drawLine(marginPt, topY, xAcc, topY, [0.6, 0.6, 0.62], 0.75);
    drawLine(marginPt, topY - headerHeightPt, xAcc, topY - headerHeightPt, [0.6, 0.6, 0.62], 0.75);
  }

  let page = doc.addPage([pageSize.width, pageSize.height]);
  let cursorY = pageSize.height - marginPt;
  drawHeaderRow(page, cursorY);
  cursorY -= headerHeightPt;

  for (const row of input.rows) {
    if (cursorY - rowHeightPt < marginPt) {
      page = doc.addPage([pageSize.width, pageSize.height]);
      cursorY = pageSize.height - marginPt;
      drawHeaderRow(page, cursorY);
      cursorY -= headerHeightPt;
    }
    const { drawText, drawLine } = createTextDrawer(page, font);
    input.columns.forEach((_, i) => {
      const idx = colIndexes[i];
      const value = idx >= 0 ? (row[idx] ?? "") : "";
      const cx = colXs[i];
      const cw = colWidthsPt[i];
      const lines = wrapTextByWidth(value, font, 9, cw - 6).slice(0, 3);
      const startY = cursorY - rowHeightPt / 2 + ((lines.length - 1) * 11) / 2;
      lines.forEach((line, li) => drawText(line, cx + 4, startY - li * 11, 9));
    });
    for (let i = 0; i <= input.columns.length; i++) {
      const x = i === input.columns.length ? xAcc : colXs[i];
      drawLine(x, cursorY, x, cursorY - rowHeightPt, [0.8, 0.8, 0.82], 0.5);
    }
    drawLine(marginPt, cursorY - rowHeightPt, xAcc, cursorY - rowHeightPt, [0.8, 0.8, 0.82], 0.5);
    cursorY -= rowHeightPt;
  }

  let bytes: Uint8Array;
  try {
    bytes = await doc.save();
  } catch {
    throw new Error("PDFの書き出しに失敗しました");
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  return { blob, pageCount: doc.getPageCount() };
}

export class RosterTemplateProcessor extends BrowserProcessor<RosterTemplateInput, RosterTemplateOutput> {
  async process(input: RosterTemplateInput): Promise<RosterTemplateOutput> {
    const validationError = validateRosterTemplateInput(input);
    if (validationError) throw new Error(validationError);

    if (input.format === "excel") {
      const blob = await buildExcel(input);
      return { blob };
    }
    const { blob, pageCount } = await buildPdf(input);
    return { blob, url: URL.createObjectURL(blob), pageCount };
  }
}

export function buildRosterFileName(format: "excel" | "pdf"): string {
  return sanitizeFileName(`名簿テンプレート.${format === "excel" ? "xlsx" : "pdf"}`);
}
