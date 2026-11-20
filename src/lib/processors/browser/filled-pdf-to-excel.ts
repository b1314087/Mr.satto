import { BrowserProcessor } from "../types";
import { closePdfDocument, loadPdfDocument, getPositionedTextItems, type PdfjsPage, type PositionedTextItem } from "@/lib/pdf/pdfjs-client";
import { reconstructTable, groupIntoLines, computeColumnBreaksAcrossPages, type ReconstructedTable } from "@/lib/pdf/table-reconstruction";
import { toExcelWriteCell, type ExcelWriteCell } from "@/lib/pdf/cell-value";
import { getFormFieldItems } from "@/lib/pdf/form-fields";
import type { SheetData } from "write-excel-file/universal";
import { filterCharacterWords } from "@/lib/ocr/ocr-enhance";
import { recognizeImageWithWords, ocrWordsToPositionedTextItems, terminateOcrWorker, type OcrLanguageOption, type OcrWord } from "@/lib/ocr/tesseract-client";
import { prepareScanForTable } from "@/lib/ocr/remove-ruled-lines";
import { computeRuledColumnBreaks, mergeRuledBreaks, type VerticalRule } from "@/lib/pdf/ruling-lines";
import { getPageImageBoxes } from "@/lib/pdf/pdf-style-sampling";
import { classifyPage } from "./ocr";

/**
 * 記入済みPDF→Excel Processor（Phase 11 ツール①）。
 *
 * 既存の「PDF→Excel」（src/lib/processors/browser/pdf-to-excel.ts）は
 * PDFのテキストレイヤーから表を再構成するのみで、スキャンした画像PDF
 * （記入済みの申請書・帳票を紙からスキャンしたもの等）には対応していない
 * （同ファイルのコメント参照）。このProcessorはその欠けている経路を埋める：
 *
 *   ページに文字レイヤーがある   -> そのまま座標付きテキストを使う（速く正確）
 *   ページに文字レイヤーがない   -> ページを画像化し、OCR（tesseract.js、
 *                                   日本語データ組み込み済み）で単語ごとの
 *                                   bounding boxを取得し、PDFのテキストレイヤーと
 *                                   同じ PositionedTextItem 形状へ変換する
 *
 * どちらの経路でも、最終的な行・列への組み立ては
 * src/lib/pdf/table-reconstruction.ts の同じ決定的な座標ベースロジック
 * （y座標クラスタリング＋列間の空白コリドー検出）を使う。
 * 「なんとなくAIが項目を判断する」方式は使わない
 * （Phase 11 開発指示書 0章・14章：AI/LLMは一切使わない）。
 *
 * 複雑な帳票・手書き文字の癖等により、100%正確な項目化を保証するものではない
 * （OCR自体の精度に依存する。開発指示書の「完全に構造化できると言い切らない」
 * 方針を踏まえ、UI側でもその旨を案内する）。
 *
 * 工程4での精度の改善（AIは使わない。座標と表記のルールだけで行う）:
 * - 入力フォーム（AcroForm）の値を読む：入力欄・チェックボックス・ラジオボタン・選択欄に記入したPDFは、記入内容が
 *   文字情報に入らないため、注釈から値を取り出して表に入れる（src/lib/pdf/form-fields.ts。チェックは ☑／☐）。
 * - 値の型：全角数字・金額（¥・円・後ろの「-」）・マイナス（−・△・▲・括弧）・小数の桁・割合・和暦の日付を、
 *   確かな表記だけ数値・日付にし、表示形式で元の見た目を保つ（src/lib/pdf/cell-value.ts）。空欄は空欄のまま。
 * - 結合セル：表の推定で見つかった横方向の結合（列をまたぐ項目）を、Excelでも結合する。
 * - 複数ページの表：同じファイルの各ページが同じ列数の表のときは、全ページで列の区切りをそろえ、
 *   2ページ目以降に繰り返される見出しの行は省いて、1つの表として続ける。
 *
 * 複数ファイル対応（開発指示書5章）：「3ページまで」はファイル数ではなく
 * 選択した全ファイルの合計ページ数を指す（例: 2ページのPDF + 1ページのPDF = 3ページ）。
 * そのため入力は単一ファイルではなく配列とし、ページ数の判定は合計値に対して行う。
 * 複数ファイルを渡した場合、生成されるExcelは1つのシートに、ファイルごとの
 * 見出し行を挟みながら連結される。
 */

/** 1回に処理できる合計ページ数の上限（プレミアムで読み取れるファイル数と同じ。src/lib/plans/tool-limits.ts） */
/**
 * 1回に読み取るページ数の上限（2026-11-20：プレミアムは無制限）。
 * 無料・スタンダードは、利用の確認（usage-status-actions.ts）で決まった maxTotalPages で別に制限する。
 */
const MAX_PAGES_HARD_LIMIT: number = Number.POSITIVE_INFINITY;
/**
 * OCR用にページを描画する倍率と、画像の最長辺の上限(px)。PDF→Excelと同じ値（A4で約180dpi）。
 * 細い文字・小さな数字の読み取りを安定させつつ、スマートフォンでのメモリ超過を防ぐ。
 */
const OCR_RENDER_SCALE = 2.5;
const MAX_OCR_DIMENSION = 2200;
/** これより信頼度の低い（0〜100）読み取りの文字は、Excelで色を付けて「確認が必要」と知らせる */
export const LOW_CONFIDENCE_THRESHOLD = 60;
/** 確認用のセルの色（薄い黄色） */
const LOW_CONFIDENCE_FILL = "#FFF2A8";

export type FilledPdfPageMethod = "text-layer" | "ocr" | "mixed";

export interface FilledPdfToExcelPageInfo {
  fileName: string;
  pageNumber: number;
  rowCount: number;
  columnCount: number;
  /** text-layer = PDFの文字情報、ocr = ページ全体をOCR、mixed = 文字情報＋画像の部分だけOCR */
  method: FilledPdfPageMethod;
  /** OCRを行ったページのみ0〜100。テキストレイヤー抽出のページはnull */
  confidence: number | null;
  /** 確認が必要な（信頼度の低い）セルの数 */
  lowConfidenceCells: number;
  /** 傾きを直した角度（度）。直していなければ 0 */
  deskewDegrees: number;
}

export interface LowConfidenceCell {
  fileName: string;
  pageNumber: number;
  /** Excelのシートの行番号（1始まり） */
  sheetRow: number;
  /** Excelの列番号（1始まり） */
  sheetCol: number;
  text: string;
  confidence: number;
}

export class FilledPdfCancelledError extends Error {
  constructor() {
    super("読み取りを中断しました。");
  }
}

export interface FilledPdfToExcelInput {
  /** 処理対象のPDFファイル群（1つでも複数でもよい） */
  files: File[];
  language: OcrLanguageOption;
  /**
   * この呼び出しで許可する最大ページ数（全ファイル合計。Free/Standardの
   * 1回あたり3ページ制限等、プラン・利用回数に基づく上限をUI側から渡す）。
   * 省略時は技術上限のみ適用する（Premiumプラン等、回数制限のない場合に使う）。
   */
  maxTotalPages?: number;
  /** 読み取るページ（1始まり）。ファイルが1つのときに使う。省略時はすべてのページ */
  pageNumbers?: number[];
  /** 中断の合図。中断されたら FilledPdfCancelledError を投げる */
  signal?: AbortSignal;
  onPageProgress?: (info: {
    fileName: string;
    currentPage: number;
    totalPagesInFile: number;
    fileIndex: number;
    fileCount: number;
    method: FilledPdfPageMethod;
    pageProgress: number;
  }) => void;
}

export interface FilledPdfToExcelOutput {
  blob: Blob;
  sizeBytes: number;
  /** 全ファイル合計の、読み取ったページ数 */
  pageCount: number;
  pages: FilledPdfToExcelPageInfo[];
  totalRowCount: number;
  usedOcr: boolean;
  /** 画面プレビュー用に先頭数行だけ保持する（全データを画面に保持しすぎないため） */
  previewRows: string[][];
  /** プレビューの中で、確認が必要なセル（"行,列"。0始まり） */
  previewLowCells: string[];
  /** 確認が必要なセル（すべて）。Excelの「読み取りの確認」シートにも書く */
  lowConfidenceCells: LowConfidenceCell[];
}

/** 「1-3, 5」のような指定を、ページ番号の一覧にする（範囲外・不正な指定は null） */
export function parsePageSelection(text: string, totalPages: number): number[] | null {
  const trimmed = text.replace(/[　\s]/g, "").replace(/[，、]/g, ",").replace(/[ー－〜~]/g, "-");
  if (!trimmed) return null;
  const out = new Set<number>();
  for (const part of trimmed.split(",")) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > totalPages) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

type ExcelCell = ExcelWriteCell | { value: string | number | Date; type?: unknown; format?: string; columnSpan: number };

/** 表の1行を、Excelの行にする（横方向の結合は columnSpan にし、結合で隠れるセルは null にする） */
export function tableRowToExcelRow(table: Pick<ReconstructedTable, "columnSpans">, rowIndex: number, row: string[]): ExcelCell[] {
  const cells: ExcelCell[] = row.map((text) => toExcelWriteCell(text));
  for (const span of table.columnSpans) {
    if (span.row !== rowIndex || span.span < 2) continue;
    const width = Math.min(span.span, cells.length - span.col);
    if (width < 2) continue;
    // 結合する範囲の、ほかのセルに文字があるときは結合しない（読み取った文字を消さない）
    if (row.slice(span.col + 1, span.col + width).some((t) => t.trim() !== "")) continue;
    const head = cells[span.col];
    const base = head === null || head === "" ? { value: "" } : typeof head === "object" ? head : { value: head };
    cells[span.col] = { ...base, columnSpan: width } as ExcelCell;
    for (let c = span.col + 1; c < span.col + width; c++) cells[c] = null;
  }
  return cells;
}

/** 見出しの行が同じか（前後の空白・全角半角の空白の違いは無視する） */
function sameRow(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b) return false;
  const norm = (r: readonly string[]) => r.map((t) => t.replace(/\s+/g, "")).join("\u0001");
  return norm(a) === norm(b) && a.some((t) => t.trim() !== "");
}

/** 1ページ分の、読み取った文字（表の組み立ての前） */
interface PageRead {
  pageNumber: number;
  items: PositionedTextItem[];
  method: FilledPdfPageMethod;
  confidence: number | null;
  /** OCRの、信頼度の低い単語（items と同じ座標） */
  lowWords: { text: string; x: number; y: number; confidence: number }[];
  /** 罫線から決めた列の区切り（OCRのページ） */
  ruled: ReturnType<typeof computeRuledColumnBreaks>;
  deskewDegrees: number;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new FilledPdfCancelledError();
}

/**
 * OCRの実行中に中断されたら、すぐに読み取りを止める（OCRの終わりを待たない）。
 * OCRのWorkerは後ろで終わらせ、次の読み取りでは新しく作り直す。
 */
async function recognizeWithAbort(canvas: HTMLCanvasElement, language: OcrLanguageOption, onProgress: (p: number) => void, signal?: AbortSignal) {
  throwIfAborted(signal);
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void terminateOcrWorker().catch(() => undefined);
      reject(new FilledPdfCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([recognizeImageWithWords(canvas, language, (p) => onProgress(p.progress), { pageSegMode: "6" }), aborted]);
    throwIfAborted(signal);
    return result;
  } catch (e) {
    if (signal?.aborted) throw new FilledPdfCancelledError();
    throw e;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // 中断の約束（aborted）が、使われずに失敗したままにならないようにする
    aborted.catch(() => undefined);
  }
}

async function renderPage(page: PdfjsPage): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const baseViewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const longest = Math.max(baseViewport.width, baseViewport.height);
  const scale = longest > MAX_OCR_DIMENSION ? OCR_RENDER_SCALE * (MAX_OCR_DIMENSION / longest) : OCR_RENDER_SCALE;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvasの初期化に失敗しました");
  // 透明な部分は白にする（OCRの読み取りを安定させる）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, scale };
}

/** ページ全体をOCRする（スキャンしたページ）。傾き・罫線を直してから読み、罫線の位置を列の区切りにする */
async function readScannedPage(
  page: PdfjsPage,
  language: OcrLanguageOption,
  onProgress: (p: number) => void,
  signal?: AbortSignal
): Promise<Omit<PageRead, "pageNumber">> {
  let rendered: { canvas: HTMLCanvasElement; scale: number };
  try {
    rendered = await renderPage(page);
  } catch {
    throw new Error("ページの画像化に失敗しました");
  }
  const prepared = prepareScanForTable(rendered.canvas);
  const raw = await recognizeWithAbort(prepared.canvas, language, onProgress, signal);
  // 2026-11-20：図形・線（|、□、○ など）だけの読み取りは捨て、文字・数字だけを残す
  const result = { ...raw, words: filterCharacterWords(raw.words) };
  // OCRの座標（画像のピクセル）を、PDFの文字と同じくらいの大きさ（ポイント）にそろえる（表の組み立ての基準値を同じにするため）
  const k = 1 / rendered.scale;
  const items = ocrWordsToPositionedTextItems(result.words).map((it) => ({ ...it, x: it.x * k, y: it.y * k, width: it.width * k, height: it.height * k, fontHeight: it.fontHeight * k }));
  const rules: VerticalRule[] = prepared.verticalRules.map((r) => ({ x: r.x * k, y0: -r.y1 * k, y1: -r.y0 * k }));
  const lowWords = result.words
    .filter((w: OcrWord) => w.confidence < LOW_CONFIDENCE_THRESHOLD)
    .map((w: OcrWord) => ({ text: w.text, x: ((w.x0 + w.x1) / 2) * k, y: -((w.y0 + w.y1) / 2) * k, confidence: Math.round(w.confidence) }));
  return { items, method: "ocr", confidence: result.confidence, lowWords, ruled: computeRuledColumnBreaks(rules, items), deskewDegrees: Math.round(prepared.skewDegrees * 10) / 10 };
}

/** 文字情報と画像が混在するページ：画像の部分だけをOCRし、文字情報と重ならない文字を足す */
async function readMixedPage(
  page: PdfjsPage,
  textItems: PositionedTextItem[],
  regions: { x0: number; y0: number; x1: number; y1: number }[],
  language: OcrLanguageOption,
  onProgress: (p: number) => void,
  signal?: AbortSignal
): Promise<{ items: PositionedTextItem[]; confidence: number | null; lowWords: PageRead["lowWords"] }> {
  const rendered = await renderPage(page);
  const viewport = page.getViewport({ scale: rendered.scale });
  const added: PositionedTextItem[] = [];
  const lowWords: PageRead["lowWords"] = [];
  const confidences: number[] = [];
  for (let i = 0; i < regions.length; i++) {
    const b = regions[i];
    const pts = [viewport.convertToViewportPoint(b.x0, b.y0), viewport.convertToViewportPoint(b.x1, b.y1)];
    const sx = Math.max(0, Math.floor(Math.min(pts[0][0], pts[1][0])));
    const sy = Math.max(0, Math.floor(Math.min(pts[0][1], pts[1][1])));
    const sw = Math.min(rendered.canvas.width - sx, Math.ceil(Math.abs(pts[1][0] - pts[0][0])));
    const sh = Math.min(rendered.canvas.height - sy, Math.ceil(Math.abs(pts[1][1] - pts[0][1])));
    if (sw < 16 || sh < 16) continue;
    const crop = document.createElement("canvas");
    crop.width = sw;
    crop.height = sh;
    crop.getContext("2d")?.drawImage(rendered.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    // 画像の中の表も、罫線を消してから読む（罫線を文字と読み違えないため）。傾きを直したときは位置が少しずれるが、行・列の判定には影響しない程度
    const prepared = prepareScanForTable(crop);
    const raw = await recognizeWithAbort(prepared.canvas, language, (p) => onProgress((i + p) / regions.length), signal);
    const result = { ...raw, words: filterCharacterWords(raw.words) };
    if (result.words.length) confidences.push(result.confidence);
    for (const w of result.words) {
      // 画像の中の位置を、PDFのページ座標に直す
      const [x0, y0] = viewport.convertToPdfPoint(sx + w.x0, sy + w.y1);
      const [x1, y1] = viewport.convertToPdfPoint(sx + w.x1, sy + w.y0);
      const item: PositionedTextItem = {
        str: w.text,
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
        fontHeight: Math.abs(y1 - y0),
        hasEOL: false,
      };
      // すでに文字情報がある場所の文字は足さない（同じ文字を二重にしない）
      const overlaps = textItems.some((t) => item.x < t.x + t.width && item.x + item.width > t.x && item.y < t.y + t.height && item.y + item.height > t.y);
      if (overlaps) continue;
      added.push(item);
      if (w.confidence < LOW_CONFIDENCE_THRESHOLD) lowWords.push({ text: w.text, x: item.x + item.width / 2, y: item.y + item.height / 2, confidence: Math.round(w.confidence) });
    }
  }
  const confidence = confidences.length ? confidences.reduce((a, c) => a + c, 0) / confidences.length : null;
  return { items: [...textItems, ...added], confidence, lowWords };
}

/** 信頼度の低い単語が入ったセル（表の行・列。0始まり）を探す */
function lowCellsOf(table: ReconstructedTable, lowWords: PageRead["lowWords"]): Map<string, { text: string; confidence: number }> {
  const out = new Map<string, { text: string; confidence: number }>();
  for (const w of lowWords) {
    // いちばん近い行（行の高さの中心）を選び、その行で単語の文字を含むセルを探す
    let best = -1;
    let bestDist = Infinity;
    table.rowYs.forEach((y, r) => {
      const d = Math.abs(y - w.y);
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    });
    if (best < 0) continue;
    const row = table.rows[best] ?? [];
    let col = row.findIndex((cell) => cell.replace(/\s/g, "").includes(w.text.replace(/\s/g, "")));
    if (col < 0) {
      // 文字で見つからないときは、列の境目の位置で決める
      col = table.colBoundariesX.findIndex((x, i) => w.x >= x && w.x < (table.colBoundariesX[i + 1] ?? Infinity));
      if (col < 0) col = 0;
    }
    const key = `${best},${Math.min(col, Math.max(0, row.length - 1))}`;
    const prev = out.get(key);
    if (!prev || w.confidence < prev.confidence) out.set(key, { text: row[col] ?? w.text, confidence: w.confidence });
  }
  return out;
}

export class FilledPdfToExcelProcessor extends BrowserProcessor<FilledPdfToExcelInput, FilledPdfToExcelOutput> {
  async process({ files, language, maxTotalPages, pageNumbers, signal, onPageProgress }: FilledPdfToExcelInput): Promise<FilledPdfToExcelOutput> {
    if (files.length === 0) {
      throw new Error("PDFファイルを選択してください");
    }
    if (files.some((f) => f.size === 0)) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }

    // 先に全ファイルを読み込み、合計ページ数を確定させてから上限判定する
    // （「3ページ」はファイル数ではなく全ファイル合計ページ数のため）。
    const pdfDocs: { file: File; pdf: Awaited<ReturnType<typeof loadPdfDocument>>; pages: number[] }[] = [];
    try {
      for (const file of files) {
        let pdf;
        try {
          pdf = await loadPdfDocument(file);
        } catch {
          throw new Error(`${file.name} の読み込みに失敗しました`);
        }
        const all = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
        // ページの指定は、ファイルが1つのときだけ使う
        const pages = files.length === 1 && pageNumbers?.length ? pageNumbers.filter((n) => n >= 1 && n <= pdf.numPages) : all;
        // 先に一覧へ入れてから確かめる（途中で止まっても、開いたPDFを全部閉じられるように）
        pdfDocs.push({ file, pdf, pages });
        if (pdf.numPages === 0) {
          throw new Error(`${file.name} にはページがありません`);
        }
      }

      const totalPages = pdfDocs.reduce((sum, d) => sum + d.pages.length, 0);
      const effectiveLimit = Math.min(maxTotalPages ?? MAX_PAGES_HARD_LIMIT, MAX_PAGES_HARD_LIMIT);
      if (totalPages > effectiveLimit) {
        throw new Error(
          `処理できるページ数の上限は合計${effectiveLimit}ページです（選択したページの合計は${totalPages}ページです）。読み取るページを指定するか、ファイルを分けてお試しください。`
        );
      }

      const sheetRows: ExcelCell[][] = [];
      const pages: FilledPdfToExcelPageInfo[] = [];
      const previewRows: string[][] = [];
      const previewLowCells: string[] = [];
      const lowConfidenceCells: LowConfidenceCell[] = [];
      let totalRowCount = 0;
      let usedOcr = false;
      const PREVIEW_ROW_LIMIT = 20;

      for (let fileIndex = 0; fileIndex < pdfDocs.length; fileIndex++) {
        const { file, pdf, pages: targetPages } = pdfDocs[fileIndex];

        if (pdfDocs.length > 1) {
          if (sheetRows.length > 0) sheetRows.push([""]);
          sheetRows.push([`--- ${file.name} ---`]);
        }

        // まず、すべてのページの文字（文字情報・入力欄の値、なければOCR）を集める
        const pageItems: PageRead[] = [];
        for (const pageNumber of targetPages) {
          throwIfAborted(signal);
          let page: PdfjsPage;
          try {
            page = await pdf.getPage(pageNumber);
          } catch {
            throw new Error(`${file.name} の${pageNumber}ページ目の読み込みに失敗しました`);
          }
          const progress = (method: FilledPdfPageMethod, p: number) =>
            onPageProgress?.({ fileName: file.name, currentPage: pageNumber, totalPagesInFile: pdf.numPages, fileIndex, fileCount: pdfDocs.length, method, pageProgress: p });

          // 工程4：入力フォームの値（入力欄・チェックボックス・選択欄）も、文字情報と一緒に使う
          const textItems = [...(await getPositionedTextItems(page)), ...(await getFormFieldItems(page))];
          // ページの種類：文字情報だけ／スキャン（画像だけ）／文字と画像の混在（OCRツールと同じ判定）
          const layerChars = textItems.reduce((n, it) => n + it.str.replace(/\s/g, "").length, 0);
          const [vx0, vy0, vx1, vy1] = page.view;
          let boxes: Awaited<ReturnType<typeof getPageImageBoxes>> = [];
          try {
            boxes = await getPageImageBoxes(page);
          } catch {
            boxes = [];
          }
          const kind = classifyPage(layerChars, boxes, { x0: vx0, y0: vy0, width: vx1 - vx0, height: vy1 - vy0 });

          if (kind.kind === "text-layer") {
            pageItems.push({ pageNumber, items: textItems, method: "text-layer", confidence: null, lowWords: [], ruled: null, deskewDegrees: 0 });
            progress("text-layer", 1);
            continue;
          }
          usedOcr = true;
          if (kind.kind === "ocr") {
            try {
              const read = await readScannedPage(page, language, (p) => progress("ocr", p), signal);
              pageItems.push({ pageNumber, ...read });
            } catch (e) {
              if (e instanceof FilledPdfCancelledError) throw e;
              throw new Error(`${file.name} の${pageNumber}ページ目を読み取れませんでした`);
            }
            continue;
          }
          const mixed = await readMixedPage(page, textItems, kind.regions, language, (p) => progress("mixed", p), signal);
          pageItems.push({ pageNumber, items: mixed.items, method: "mixed", confidence: mixed.confidence, lowWords: mixed.lowWords, ruled: null, deskewDegrees: 0 });
        }

        // 複数ページの表：文字情報のページがどれも同じ列数の表なら、全ページで列の区切りをそろえる
        const independent = pageItems.map((p) => {
          if (p.ruled) return reconstructTable(p.items, mergeRuledBreaks([], p.ruled), p.ruled.breaks);
          return reconstructTable(p.items);
        });
        const textPages = pageItems.filter((p) => p.method === "text-layer");
        const textTables = independent.filter((_, i) => pageItems[i].method === "text-layer" && independent[i].rows.length > 0);
        let sharedBreaks: number[] | undefined;
        if (textPages.length >= 2 && textTables.length === textPages.length && textTables.every((t) => t.columnCount === textTables[0].columnCount && t.columnCount >= 2)) {
          const breaks = computeColumnBreaksAcrossPages(textPages.map((p) => groupIntoLines(p.items)));
          if (breaks.length + 1 === textTables[0].columnCount) sharedBreaks = breaks;
        }

        let previousHeader: string[] | undefined;
        for (let i = 0; i < pageItems.length; i++) {
          const { pageNumber, items, method, confidence, lowWords, deskewDegrees } = pageItems[i];
          const table = sharedBreaks && method === "text-layer" ? reconstructTable(items, sharedBreaks) : independent[i];
          if (table.rows.length === 0) {
            pages.push({ fileName: file.name, pageNumber, rowCount: 0, columnCount: 0, method, confidence, lowConfidenceCells: 0, deskewDegrees });
            continue;
          }
          const low = lowCellsOf(table, lowWords);

          // 2ページ目以降で、前のページと同じ見出しの行が繰り返されているときは、続きの表として見出しを省く
          const continued = !!sharedBreaks && sameRow(table.rows[0], previousHeader);
          const startRow = continued ? 1 : 0;
          if (sheetRows.length > 0 && !continued) {
            sheetRows.push(new Array(Math.max(table.columnCount, 1)).fill(""));
          }
          let pageLow = 0;
          for (let r = startRow; r < table.rows.length; r++) {
            const row = table.rows[r];
            const cells = tableRowToExcelRow(table, r, row);
            // 確認が必要な（信頼度の低い）セルに色を付ける
            row.forEach((_, c) => {
              const hit = low.get(`${r},${c}`);
              if (!hit) return;
              pageLow++;
              const cell = cells[c];
              const base = cell === null || cell === "" ? { value: "" } : typeof cell === "object" ? cell : { value: cell };
              cells[c] = { ...base, backgroundColor: LOW_CONFIDENCE_FILL } as unknown as ExcelCell;
              lowConfidenceCells.push({ fileName: file.name, pageNumber, sheetRow: sheetRows.length + 1, sheetCol: c + 1, text: row[c] || hit.text, confidence: hit.confidence });
              if (previewRows.length < PREVIEW_ROW_LIMIT) previewLowCells.push(`${previewRows.length},${c}`);
            });
            sheetRows.push(cells);
            if (previewRows.length < PREVIEW_ROW_LIMIT) previewRows.push(row);
          }
          if (!continued) previousHeader = table.rows[0];

          const rowCount = table.rows.length - startRow;
          pages.push({ fileName: file.name, pageNumber, rowCount, columnCount: table.columnCount, method, confidence, lowConfidenceCells: pageLow, deskewDegrees });
          totalRowCount += rowCount;
        }
      }

      if (sheetRows.length === 0) {
        throw new Error(
          "項目として認識できる内容が見つかりませんでした。文字がはっきり読み取れるスキャン画像かご確認ください。"
        );
      }

      const { default: writeXlsxFile } = await import("write-excel-file/universal");
      let blob: Blob;
      try {
        if (lowConfidenceCells.length > 0) {
          // 確認が必要なセルの一覧を、別のシートにまとめる（元のPDFと見比べやすいように、ページ・セルの位置・読み取った文字を並べる）
          const header = ["ファイル", "ページ", "セル", "読み取った文字", "信頼度（0〜100）"].map((value) => ({ value, fontWeight: "bold" as const }));
          const review = [
            header,
            ...lowConfidenceCells.map((c) => [c.fileName, c.pageNumber, `${columnLetter(c.sheetCol)}${c.sheetRow}`, c.text, c.confidence]),
          ];
          blob = await writeXlsxFile([
            { data: sheetRows as unknown as SheetData, sheet: "読み取り結果" },
            { data: review as unknown as SheetData, sheet: "読み取りの確認" },
          ]).toBlob();
        } else {
          blob = await writeXlsxFile(sheetRows as unknown as SheetData).toBlob();
        }
      } catch {
        throw new Error("Excelファイルの生成に失敗しました");
      }

      return {
        blob,
        sizeBytes: blob.size,
        pageCount: totalPages,
        pages,
        totalRowCount,
        usedOcr,
        previewRows,
        previewLowCells,
        lowConfidenceCells,
      };
    } finally {
      await Promise.all(pdfDocs.map((d) => closePdfDocument(d.pdf)));
    }
  }
}

function columnLetter(n: number): string {
  let s = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}
