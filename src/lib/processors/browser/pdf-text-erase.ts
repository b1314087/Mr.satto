import type * as PdfLibTypes from "pdf-lib";
import { ensurePdfLib, pdfLib } from "@/lib/pdf/pdf-lib-loader";
import { getPdfjs, withPdfDocument } from "@/lib/pdf/pdfjs-client";
import { loadPdfDoc } from "./pdf";
import { ContentParseError, parseContentStream, type ContentOperation } from "@/lib/pdf-text-edit/content-tokens";
import { computeTextRuns, type RunFontInfo, type SourceGlyph, type TextRun } from "@/lib/pdf-text-edit/text-runs";
import { splitSentences, type Sentence } from "@/lib/pdf-text-edit/sentences";
import { eraseGlyphs, TextEraseError, type EraseSelection } from "@/lib/pdf-text-edit/erase";
import { buildTextGuides, type GuideTextItem, type TextGuides } from "@/lib/pdf-text-edit/guides";

/**
 * PDF修正「文字を消す（文単位）」（2026-11-18）。ブラウザの中だけで処理する（ファイルは外部に送らない）。
 *
 * 1. analyzePageText：ページの文字を読み、文に分ける（画面で文を選ぶため）。
 * 2. eraseSentences：選んだ文の文字を、ページの描く命令から取り除いた新しいPDFを作る。
 *    残りの文字の位置は動かない。消したあと、新しいPDFを読み直して、文字が減ったことを確かめる（確かめられなければエラー）。
 *
 * 消せないもの：スキャンしたPDF（文字の情報がない）・縦書きのフォント・特別なフォント（Type3）・
 * フォームや注釈の中の文字・PDFを表示する部品と読み方が合わないページ。
 */

export { TextEraseError };

export interface PageTextAnalysis {
  sentences: Sentence[];
  /** そのページに、文字の情報があるか（スキャンしたPDFは、ない） */
  hasText: boolean;
  /** 文字を消せるページか（読み方が合わない・消せない文字だけのページは false） */
  erasable: boolean;
}

interface FullAnalysis extends PageTextAnalysis {
  ops: ContentOperation[];
  runs: TextRun[];
  content: Uint8Array;
}

/** ページの描く命令（複数に分かれていれば、つなげたもの）を取り出す */
function readPageContent(page: PdfLibTypes.PDFPage): { bytes: Uint8Array; refs: PdfLibTypes.PDFRef[] } {
  const lib = pdfLib();
  const contents = page.node.get(lib.PDFName.of("Contents"));
  const refs: PdfLibTypes.PDFRef[] = [];
  const streams: Uint8Array[] = [];
  const pushStream = (obj: unknown) => {
    const resolved = obj instanceof lib.PDFRef ? page.doc.context.lookup(obj) : obj;
    if (resolved instanceof lib.PDFRawStream) streams.push(lib.decodePDFRawStream(resolved).decode());
    else if (resolved instanceof lib.PDFFlateStream) streams.push(resolved.getUnencodedContents());
    else if (resolved instanceof lib.PDFStream) streams.push(resolved.getContents());
  };
  if (contents instanceof lib.PDFRef) refs.push(contents);
  const resolved = contents instanceof lib.PDFRef ? page.doc.context.lookup(contents) : contents;
  if (resolved instanceof lib.PDFArray) {
    for (let i = 0; i < resolved.size(); i++) {
      const item = resolved.get(i);
      if (item instanceof lib.PDFRef) refs.push(item);
      pushStream(item);
    }
  } else if (resolved) pushStream(resolved);
  // 命令がストリームの境目で切れないよう、改行をはさんでつなぐ
  const total = streams.reduce((s, b) => s + b.length + 1, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of streams) {
    out.set(b, p);
    p += b.length;
    out[p++] = 0x0a;
  }
  return { bytes: out, refs };
}

async function analyze(pdfBytes: ArrayBuffer, pageNumber: number): Promise<FullAnalysis> {
  await ensurePdfLib();
  const doc = await loadPdfDoc(new File([pdfBytes.slice(0)], "input.pdf", { type: "application/pdf" }), { updateMetadata: false });
  const { bytes: content } = readPageContent(doc.getPage(pageNumber - 1));
  let ops: ContentOperation[];
  try {
    ops = parseContentStream(content);
  } catch (e) {
    if (e instanceof ContentParseError) ops = [];
    else throw e;
  }
  const pdfjsLib = await getPdfjs();
  return withPdfDocument(new File([pdfBytes.slice(0)], "input.pdf", { type: "application/pdf" }), async (pdf) => {
    const page = await pdf.getPage(pageNumber);
    // 注釈（フォームの入力欄など）の中の文字は、ページの描く命令に入っていないので、読まない
    const list = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
    const OPS = pdfjsLib.OPS;
    const showTextGlyphs: (SourceGlyph | number)[][] = [];
    const setFontIds: string[] = [];
    let depth = 0;
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i];
      if (fn === OPS.paintFormXObjectBegin || fn === OPS.beginAnnotation) depth++;
      else if (fn === OPS.paintFormXObjectEnd || fn === OPS.endAnnotation) depth--;
      else if (depth === 0 && fn === OPS.showText) showTextGlyphs.push((list.argsArray[i]?.[0] ?? []) as (SourceGlyph | number)[]);
      else if (depth === 0 && fn === OPS.setFont) setFontIds.push(String(list.argsArray[i]?.[0] ?? ""));
    }
    const fonts: Record<string, RunFontInfo> = {};
    for (const id of new Set(setFontIds)) {
      type PdfjsFontLike = { vertical?: boolean; fontMatrix?: number[]; ascent?: number; descent?: number; isType3Font?: boolean };
      let font: PdfjsFontLike | null = null;
      try {
        font = page.commonObjs.has(id) ? (page.commonObjs.get(id) as PdfjsFontLike) : null;
      } catch {
        font = null;
      }
      const m = font?.fontMatrix;
      const standardMatrix = !m || (Math.abs(m[0] - 0.001) < 1e-9 && Math.abs(m[3] - 0.001) < 1e-9 && !m[1] && !m[2]);
      fonts[id] = {
        vertical: Boolean(font?.vertical),
        unusualMatrix: !font || Boolean(font.isType3Font) || !standardMatrix,
        ascent: typeof font?.ascent === "number" && font.ascent > 0 ? font.ascent : 0.88,
        descent: typeof font?.descent === "number" && font.descent < 0 ? font.descent : -0.12,
      };
    }
    const viewport = page.getViewport({ scale: 1 });
    const toDisplay = (x: number, y: number): [number, number] => {
      const [px, py] = viewport.convertToViewportPoint(x, y);
      return [px, viewport.height - py];
    };
    const { runs, aligned } = computeTextRuns({ ops, showTextGlyphs, setFontIds, fonts, toDisplay });
    const sentences = splitSentences(runs);
    const hasText = runs.some((r) => r.glyphs.some((g) => g.unicode.trim() !== "")) || showTextGlyphs.some((g) => g.length > 0);
    page.cleanup();
    return { ops, runs, content, sentences, hasText, erasable: aligned && sentences.some((s) => s.erasable) };
  });
}

/** ページの文字を読み、文に分ける */
export async function analyzePageText(pdfBytes: ArrayBuffer, pageNumber: number): Promise<PageTextAnalysis> {
  const { sentences, hasText, erasable } = await analyze(pdfBytes, pageNumber);
  return { sentences, hasText, erasable };
}

function pageTextOf(a: FullAnalysis): string {
  return a.runs.map((r) => r.glyphs.map((g) => g.unicode).join("")).join("");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return count;
    count++;
    from = i + needle.length;
  }
}

/**
 * 選んだ文（sentenceIds は analyzePageText の文の id）の文字を消した、新しいPDFのバイトを返す。
 * 元のPDF（pdfBytes）は書き換えない。
 */
export async function eraseSentences(pdfBytes: ArrayBuffer, pageNumber: number, sentenceIds: number[]): Promise<Uint8Array> {
  const before = await analyze(pdfBytes, pageNumber);
  const chosen = before.sentences.filter((s) => sentenceIds.includes(s.id));
  if (chosen.length === 0) throw new TextEraseError("消す文が選ばれていません");
  if (chosen.some((s) => !s.erasable)) throw new TextEraseError("選んだ文の中に、消せない文字があります");

  const selection: EraseSelection = new Map();
  let erasedVisible = 0;
  const runByOp = new Map(before.runs.map((r) => [r.opIndex, r]));
  for (const s of chosen) {
    for (const ref of s.refs) {
      if (!selection.has(ref.opIndex)) selection.set(ref.opIndex, new Set());
      selection.get(ref.opIndex)!.add(ref.glyphIndex);
      const g = runByOp.get(ref.opIndex)?.glyphs[ref.glyphIndex];
      if (g && g.unicode.trim() !== "") erasedVisible++;
    }
  }
  const newContent = eraseGlyphs(before.content, before.ops, before.runs, selection);

  // 新しい描く命令に差し替える（古い命令は、ほかのページが使っていなければ、ファイルから取り除く）
  await ensurePdfLib();
  const lib = pdfLib();
  const doc = await loadPdfDoc(new File([pdfBytes.slice(0)], "input.pdf", { type: "application/pdf" }), { updateMetadata: false });
  const page = doc.getPage(pageNumber - 1);
  const { refs: oldRefs } = readPageContent(page);
  const stream = doc.context.flateStream(newContent);
  const newRef = doc.context.register(stream);
  page.node.set(lib.PDFName.of("Contents"), newRef);
  const stillUsed = new Set<string>();
  doc.getPages().forEach((p, i) => {
    if (i === pageNumber - 1) return;
    for (const r of readPageContent(p).refs) stillUsed.add(r.toString());
  });
  for (const r of oldRefs) if (!stillUsed.has(r.toString())) doc.context.delete(r);
  const out = await doc.save({ useObjectStreams: false });

  // 確かめる：読み直して、消した文字の数だけ減っていること・消した文が（同じ文が他になければ）残っていないこと
  const after = await analyze(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, pageNumber);
  const visibleCount = (a: FullAnalysis) => a.runs.reduce((n, r) => n + r.glyphs.filter((g) => g.unicode.trim() !== "").length, 0);
  if (visibleCount(before) - visibleCount(after) !== erasedVisible) {
    throw new TextEraseError("文字を消したあとの確認に失敗したため、変更しませんでした。");
  }
  const beforeText = pageTextOf(before).replace(/\s+/g, "");
  const afterText = pageTextOf(after).replace(/\s+/g, "");
  for (const s of chosen) {
    const t = s.text.replace(/\s+/g, "");
    if (t && countOccurrences(afterText, t) >= countOccurrences(beforeText, t)) {
      throw new TextEraseError("文字を消したあとの確認に失敗したため、変更しませんでした。");
    }
  }
  return out;
}

/**
 * もともと書かれている文字の、書き始めの位置と基準線の高さ（位置合わせの目印。2026-11-18）。
 * 文字を消す機能と違い、読み方が合わないページでも使えるよう、pdf.js の文字の取り出し（getTextContent）だけで作る。
 */
export async function loadTextGuides(pdfBytes: ArrayBuffer, pageNumber: number): Promise<TextGuides> {
  return withPdfDocument(new File([pdfBytes.slice(0)], "input.pdf", { type: "application/pdf" }), async (pdf) => {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    // 回転したページは、目印を出さない（画面の向きと文字の向きが合わないため）
    if (viewport.rotation % 360 !== 0) {
      page.cleanup();
      return { xs: [], ys: [] };
    }
    const content = await page.getTextContent();
    const items: GuideTextItem[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const [a, b, c, d, e, f] = item.transform as number[];
      // 横書きの文字だけ（回転・縦書きの文字は、目印にしない）
      if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || a <= 0 || d <= 0) continue;
      const [px0, py] = viewport.convertToViewportPoint(e, f);
      const [px1] = viewport.convertToViewportPoint(e + item.width, f);
      const size = Math.hypot(c, d);
      items.push({ x0: Math.min(px0, px1), x1: Math.max(px0, px1), baseY: viewport.height - py, size });
    }
    page.cleanup();
    return buildTextGuides(items);
  });
}
