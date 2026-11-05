/**
 * 差し込み印刷・レイアウト作成 Processor（ブラウザ内だけで処理する。ファイルは外部に送らない）。
 *
 * 背景（PDFの1ページ、または白紙）の上に、Excel・CSVの1行ごとに、決めた位置へ文字を差し込み、
 * 1件1ページのPDFを1つ作る。
 *
 * - 文字の配置は src/lib/mail-merge/layout.ts の layoutField（画面のプレビューと同じ計算）。ここでは結果を描くだけ。
 * - 背景のPDFは、ページを1回だけ埋め込み、全ページで使い回す（件数が多くてもPDFが大きくなりすぎない）。
 *   PDFの表示範囲（トリミング）と回転は、画面のプレビュー（pdf.js）と同じになるように合わせる。
 * - 日本語フォント（Noto Sans JP・必要なときだけ Noto Serif JP）は、既存のツールと同じ方法で埋め込む。
 */
import type { PDFDocument as PDFDocumentType, PDFFont, PDFPage, PDFEmbeddedPage } from "pdf-lib";
import { BrowserProcessor } from "../types";
import { loadJapaneseFontBytes, loadJapaneseSerifFontBytes } from "@/lib/pdf/japanese-font";
import { ensurePdfLib, fontkitLib, pdfLib } from "@/lib/pdf/pdf-lib-loader";
import {
  blankPageSizePt,
  fieldText,
  layoutField,
  type FieldSource,
  type FontId,
  type MergeData,
  type MergeField,
  type PaperSetting,
} from "@/lib/mail-merge/layout";
import { makeMeasure } from "@/lib/mail-merge/fonts";

/** 1回に作れる件数の上限（ブラウザのメモリを使いすぎないため） */
export const MAIL_MERGE_MAX_RECORDS = 3000;

export class MailMergeCanceled extends Error {
  constructor() {
    super("キャンセルしました");
  }
}

export interface MailMergeInput {
  paper: PaperSetting;
  /** 背景のPDF（paper.mode が "pdf" のとき） */
  template: Blob | null;
  /** 背景に使うページ（0から） */
  templatePageIndex: number;
  fields: MergeField[];
  sources: Record<string, FieldSource>;
  data: MergeData;
  onProgress?: (done: number, total: number) => void;
  signal?: { canceled: boolean };
}

export interface MailMergeOutput {
  blob: Blob;
  pageCount: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

/** 背景のPDFの1ページを読み込む（表示範囲と回転も返す） */
async function embedTemplate(doc: PDFDocumentType, template: Blob, pageIndex: number) {
  const { PDFDocument } = pdfLib();
  let src;
  try {
    src = await PDFDocument.load(new Uint8Array(await template.arrayBuffer()), { updateMetadata: false });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? "";
    if (/Encrypt/i.test(name) || /encrypt/i.test(String((e as Error)?.message ?? ""))) {
      throw new Error("パスワードや編集の制限が付いたPDFは、背景に使えません。制限を解除したPDFを選んでください。");
    }
    throw new Error("背景のPDFを読み込めませんでした。PDFファイルが破損している可能性があります。");
  }
  const count = src.getPageCount();
  if (pageIndex < 0 || pageIndex >= count) throw new Error(`背景のPDFに${pageIndex + 1}ページ目がありません（全${count}ページ）。`);
  const srcPage = src.getPage(pageIndex);
  const crop = srcPage.getCropBox();
  const rotation = (((srcPage.getRotation().angle % 360) + 360) % 360) as number;
  let embedded: PDFEmbeddedPage;
  try {
    embedded = await doc.embedPage(srcPage, { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height });
  } catch {
    throw new Error("背景のPDFのページを読み込めませんでした。別のPDFでお試しください。");
  }
  const w = crop.width;
  const h = crop.height;
  const turned = rotation === 90 || rotation === 270;
  return { embedded, w, h, rotation, pageW: turned ? h : w, pageH: turned ? w : h };
}

/** 背景のページを、回転（PDFの /Rotate は時計回り）に合わせて描く */
function drawBackground(page: PDFPage, bg: Awaited<ReturnType<typeof embedTemplate>>) {
  const { degrees } = pdfLib();
  const { embedded, w, h, rotation } = bg;
  if (rotation === 90) page.drawPage(embedded, { x: 0, y: w, rotate: degrees(-90) });
  else if (rotation === 180) page.drawPage(embedded, { x: w, y: h, rotate: degrees(180) });
  else if (rotation === 270) page.drawPage(embedded, { x: h, y: 0, rotate: degrees(90) });
  else page.drawPage(embedded, { x: 0, y: 0 });
}

export class MailMergeProcessor extends BrowserProcessor<MailMergeInput, MailMergeOutput> {
  async process(input: MailMergeInput): Promise<MailMergeOutput> {
    const { paper, template, templatePageIndex, fields, sources, data, onProgress, signal } = input;
    const total = data.records.length;
    if (total === 0) throw new Error("差し込むデータがありません。Excel・CSVを読み込んでください。");
    if (total > MAIL_MERGE_MAX_RECORDS) throw new Error(`1回に作れるのは${MAIL_MERGE_MAX_RECORDS}件までです。データを分けて作成してください。`);
    if (fields.length === 0) throw new Error("差し込む項目がありません。プレビューを押して項目を追加してください。");

    await ensurePdfLib({ fontkit: true });
    const { PDFDocument, rgb } = pdfLib();
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkitLib());

    // 使うフォントだけを読み込む
    const used = new Set<FontId>(fields.map((f) => f.font));
    const fonts: Partial<Record<FontId, PDFFont>> = {};
    try {
      if (used.has("gothic")) fonts.gothic = await doc.embedFont(new Uint8Array(await loadJapaneseFontBytes()), { subset: false });
      if (used.has("mincho")) fonts.mincho = await doc.embedFont(new Uint8Array(await loadJapaneseSerifFontBytes()), { subset: false });
    } catch {
      throw new Error("日本語フォントを読み込めませんでした。通信の状態を確かめて、もう一度お試しください。");
    }
    const measure = makeMeasure(fonts);

    let size: { width: number; height: number };
    let bg: Awaited<ReturnType<typeof embedTemplate>> | null = null;
    if (paper.mode === "pdf") {
      if (!template) throw new Error("背景のPDFを選んでください。");
      bg = await embedTemplate(doc, template, templatePageIndex);
      size = { width: bg.pageW, height: bg.pageH };
    } else {
      size = blankPageSizePt(paper);
    }

    const colors = new Map<string, ReturnType<typeof rgb>>();
    const colorOf = (hex: string) => {
      let c = colors.get(hex);
      if (!c) {
        c = rgb(...hexToRgb(hex));
        colors.set(hex, c);
      }
      return c;
    };

    for (let i = 0; i < total; i++) {
      if (signal?.canceled) throw new MailMergeCanceled();
      const page = doc.addPage([size.width, size.height]);
      if (bg) drawBackground(page, bg);
      for (const field of fields) {
        const text = fieldText(field, sources[field.id], data, i).replace(/\t/g, " ");
        if (!text) continue;
        const layout = layoutField(field, text, size, measure);
        const font = fonts[field.font] ?? fonts.gothic!;
        for (const run of layout.runs) {
          page.drawText(run.text, { x: run.x, y: size.height - run.baseline, size: run.sizePt, font, color: colorOf(run.color) });
        }
      }
      if ((i + 1) % 50 === 0 || i + 1 === total) {
        onProgress?.(i + 1, total);
        await yieldToBrowser();
      }
    }
    if (signal?.canceled) throw new MailMergeCanceled();
    const bytes = await doc.save();
    return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), pageCount: total };
  }
}
