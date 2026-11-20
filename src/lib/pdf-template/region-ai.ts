import { closePdfDocument, loadPdfDocument, renderPageToCanvas } from "@/lib/pdf/pdfjs-client";
import { encodeCanvasForAi, type PreparedImage } from "@/lib/calendar/event-image";
import { FORM_MAX_IMAGE_PAGES } from "@/lib/ai/form-extract";
import { cropFieldCanvas } from "./field-extraction";
import type { PersonRecord } from "./person-extraction";
import type { Template, TemplateField } from "./types";

/**
 * 記入済みPDF→Excelの「指定した場所をAIで読み取る」（2026-11-20）。
 *
 * - AIに送るのは、利用者が囲んだ枠の中の画像だけ（ページ全体は送らない）。
 * - 1件（1人・1枚）につき、枠の画像を上から順に並べた1枚の画像を作る（枠のあいだは灰色の帯で区切る）。
 * - 文字のあるPDFで、PDFの中の文字から読めた欄と、チェック欄は送らない（AIを使わなくても正確に読めるため）。
 */

/** AIに送る1件分 */
export interface RegionAiItem {
  recordId: string;
  /** 画面に出す名前（ファイル名・ページ） */
  label: string;
  /** 送る枠の項目の番号（fieldIndex）。画像の上からの順 */
  fieldIndexes: number[];
  /** 送る枠の項目名（AIに渡す。画像の上からの順） */
  labels: string[];
  image: PreparedImage;
  /** 端末内の文字認識が読んだ文字（参考。今は送らない＝空） */
  hint: string;
}

/** 枠を画像にする倍率（A4で約216dpi。細い字・手書きも読める大きさ） */
const RENDER_SCALE = 3;
const RENDER_MAX_DIMENSION = 2600;
/** 並べた画像の幅の上限と、枠のあいだの帯の高さ（px） */
const STACK_MAX_WIDTH = 1400;
const SEPARATOR_PX = 16;

/** AIに送る欄か（PDFの中の文字で読めた欄・チェック欄は送らない） */
export function needsAi(method: PersonRecord["fields"][number]["method"]): boolean {
  return method !== "text-layer" && method !== "checkbox";
}

/** 1件分の、テンプレートの枠を探す */
function templateFieldOf(template: Template, record: PersonRecord, fieldIndex: number): TemplateField | undefined {
  const templatePageCount = Math.max(1, template.pages.length);
  const pageIndex = (record.sourcePageNumber - 1) % templatePageCount;
  return template.fields.find((f) => f.pageIndex === pageIndex && f.personIndex === record.personIndex && f.fieldIndex === fieldIndex);
}

/** record.id（p{ファイルの番号}-…）から、ファイルの番号を取り出す */
export function fileIndexOfRecord(record: PersonRecord): number {
  const m = /^p(\d+)-/.exec(record.id);
  return m ? Number(m[1]) : 0;
}

/** 枠の画像を、上から順に1枚に並べる（枠のあいだは灰色の帯） */
export function stackCrops(crops: HTMLCanvasElement[]): HTMLCanvasElement | null {
  if (crops.length === 0) return null;
  const width = Math.min(STACK_MAX_WIDTH, Math.max(...crops.map((c) => c.width)));
  const scaled = crops.map((c) => {
    const k = Math.min(1, width / c.width);
    return { c, w: Math.max(1, Math.round(c.width * k)), h: Math.max(1, Math.round(c.height * k)) };
  });
  const height = scaled.reduce((sum, s) => sum + s.h, 0) + SEPARATOR_PX * (crops.length - 1);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  scaled.forEach((s, i) => {
    if (i > 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.fillRect(0, y, width, SEPARATOR_PX);
      y += SEPARATOR_PX;
    }
    ctx.drawImage(s.c, 0, y, s.w, s.h);
    y += s.h;
  });
  return out;
}

/**
 * AIに送る1件ずつの画像を作る（この端末の中だけで行う。AIには送らない）。
 * AIに送る欄が1つもない件は、含めない。
 */
export async function buildRegionAiItems(opts: {
  records: PersonRecord[];
  template: Template;
  files: File[];
  onProgress?: (done: number, total: number) => void;
  signal?: { cancelled: boolean };
}): Promise<RegionAiItem[]> {
  const { records, template, files, onProgress, signal } = opts;
  // 空欄として除外された件も送る（OCRで読めなかっただけのことがあるため）
  const targets = records.filter((r) => r.fields.some((f) => needsAi(f.method)));
  const items: RegionAiItem[] = [];
  // ファイルごとに開き、ページごとに1回だけ画像にする
  const byFile = new Map<number, PersonRecord[]>();
  for (const r of targets) {
    const fi = fileIndexOfRecord(r);
    byFile.set(fi, [...(byFile.get(fi) ?? []), r]);
  }
  let done = 0;
  for (const [fileIndex, recs] of [...byFile.entries()].sort((a, b) => a[0] - b[0])) {
    const file = files[fileIndex];
    if (!file) continue;
    const pdf = await loadPdfDocument(file);
    try {
      const pageCache = new Map<number, { canvas: HTMLCanvasElement; scale: number; heightPt: number } | null>();
      for (const record of recs) {
        if (signal?.cancelled) return items;
        let rendered = pageCache.get(record.sourcePageNumber);
        if (rendered === undefined) {
          try {
            const page = await pdf.getPage(record.sourcePageNumber);
            const r = await renderPageToCanvas(page, RENDER_SCALE, RENDER_MAX_DIMENSION);
            rendered = { canvas: r.canvas, scale: r.scale, heightPt: page.getViewport({ scale: 1 }).height };
          } catch {
            rendered = null;
          }
          pageCache.set(record.sourcePageNumber, rendered);
        }
        done++;
        onProgress?.(done, targets.length);
        if (!rendered) continue;
        const fieldIndexes: number[] = [];
        const labels: string[] = [];
        const crops: HTMLCanvasElement[] = [];
        for (const fv of record.fields) {
          if (!needsAi(fv.method)) continue;
          const tf = templateFieldOf(template, record, fv.fieldIndex);
          if (!tf) continue;
          const crop = cropFieldCanvas(rendered.canvas, tf, rendered.heightPt, rendered.scale);
          if (!crop) continue;
          fieldIndexes.push(fv.fieldIndex);
          labels.push((fv.label || `項目${fv.fieldIndex}`).slice(0, 40));
          crops.push(crop);
        }
        const stacked = stackCrops(crops);
        if (!stacked) continue;
        const label = files.length > 1 ? `${record.sourceFileName} ${record.sourcePageNumber}ページ目` : `${record.sourcePageNumber}ページ目`;
        const image = await encodeCanvasForAi(stacked, label);
        if (!image) continue;
        items.push({ recordId: record.id, label, fieldIndexes, labels, image, hint: "" });
      }
    } finally {
      await closePdfDocument(pdf);
    }
  }
  return items;
}

/** 1回に送る件のまとまりに分ける（項目の並びが同じ件だけを、画像の上限の数ずつ） */
export function batchRegionItems<T extends { labels: string[] }>(items: T[], perBatch = FORM_MAX_IMAGE_PAGES): T[][] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const key = it.labels.join("\u0001");
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  const batches: T[][] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += perBatch) batches.push(group.slice(i, i + perBatch));
  }
  return batches;
}
