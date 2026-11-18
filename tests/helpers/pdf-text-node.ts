import path from "node:path";
import * as lib from "pdf-lib";
import { parseContentStream } from "@/lib/pdf-text-edit/content-tokens";
import { computeTextRuns, type RunFontInfo, type SourceGlyph } from "@/lib/pdf-text-edit/text-runs";
import { splitSentences } from "@/lib/pdf-text-edit/sentences";
import { eraseGlyphs } from "@/lib/pdf-text-edit/erase";

/**
 * テスト用：ブラウザを使わずに（Node の pdf.js で）、ページの文字を読み、文に分け、文を消す。
 * 画面で使う src/lib/processors/browser/pdf-text-erase.ts と同じ部品（読み取り・文の分け方・消し方）を通す。
 */
export async function readPageContent(doc: lib.PDFDocument, pageIndex: number): Promise<Uint8Array> {
  const page = doc.getPage(pageIndex);
  const c = page.node.get(lib.PDFName.of("Contents"));
  const resolved = c instanceof lib.PDFRef ? doc.context.lookup(c) : c;
  const streams: Uint8Array[] = [];
  const push = (o: unknown) => {
    const r = o instanceof lib.PDFRef ? doc.context.lookup(o) : o;
    if (r instanceof lib.PDFRawStream) streams.push(lib.decodePDFRawStream(r).decode());
    else if (r instanceof lib.PDFFlateStream) streams.push(r.getUnencodedContents());
  };
  if (resolved instanceof lib.PDFArray) for (let i = 0; i < resolved.size(); i++) push(resolved.get(i));
  else push(resolved);
  const content = new Uint8Array(streams.reduce((s, b) => s + b.length + 1, 0));
  let p = 0;
  for (const b of streams) {
    content.set(b, p);
    p += b.length;
    content[p++] = 10;
  }
  return content;
}

export async function analyzeNode(bytes: Uint8Array, pageNumber = 1) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await lib.PDFDocument.load(bytes);
  const content = await readPageContent(doc, pageNumber - 1);
  const ops = parseContentStream(content);
  const root = path.resolve("node_modules/pdfjs-dist");
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: root + "/standard_fonts/", cMapUrl: root + "/cmaps/", cMapPacked: true }).promise;
  try {
    const pg = await pdf.getPage(pageNumber);
    const list = await pg.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE });
    const showTextGlyphs: (SourceGlyph | number)[][] = [];
    const setFontIds: string[] = [];
    let depth = 0;
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i];
      if (fn === pdfjs.OPS.paintFormXObjectBegin) depth++;
      else if (fn === pdfjs.OPS.paintFormXObjectEnd) depth--;
      else if (depth === 0 && fn === pdfjs.OPS.showText) showTextGlyphs.push(list.argsArray[i][0]);
      else if (depth === 0 && fn === pdfjs.OPS.setFont) setFontIds.push(list.argsArray[i][0]);
    }
    const fonts: Record<string, RunFontInfo> = {};
    for (const id of new Set(setFontIds)) {
      const f = pg.commonObjs.get(id) as { vertical?: boolean; ascent?: number; descent?: number; isType3Font?: boolean };
      fonts[id] = { vertical: !!f.vertical, unusualMatrix: !!f.isType3Font, ascent: f.ascent ?? 0.88, descent: f.descent ?? -0.12 };
    }
    const vp = pg.getViewport({ scale: 1 });
    const res = computeTextRuns({
      ops,
      showTextGlyphs,
      setFontIds,
      fonts,
      toDisplay: (x, y) => {
        const [px, py] = vp.convertToViewportPoint(x, y);
        return [px, vp.height - py];
      },
    });
    return { ...res, ops, content, sentences: splitSentences(res.runs), doc };
  } finally {
    await pdf.destroy();
  }
}

/** 文（先頭の文字で選ぶ）を消した、新しいPDFのバイトを返す */
export async function eraseSentencesNode(bytes: Uint8Array, startsWith: string[], pageNumber = 1): Promise<Uint8Array> {
  const a = await analyzeNode(bytes, pageNumber);
  const sel = new Map<number, Set<number>>();
  for (const prefix of startsWith) {
    const s = a.sentences.find((x) => x.text.startsWith(prefix));
    if (!s) throw new Error(`文が見つかりません: ${prefix} / ${a.sentences.map((x) => x.text).join(" | ")}`);
    for (const r of s.refs) {
      if (!sel.has(r.opIndex)) sel.set(r.opIndex, new Set());
      sel.get(r.opIndex)!.add(r.glyphIndex);
    }
  }
  const next = eraseGlyphs(a.content, a.ops, a.runs, sel);
  a.doc.getPage(pageNumber - 1).node.set(lib.PDFName.of("Contents"), a.doc.context.register(a.doc.context.flateStream(next)));
  return a.doc.save();
}

/** 見えている文字の、位置（左端・基準線）の一覧（「文字＠x,y」） */
export function glyphPositions(a: Awaited<ReturnType<typeof analyzeNode>>): string[] {
  return a.runs.flatMap((r) => r.glyphs.filter((g) => g.unicode.trim() !== "").map((g) => `${g.unicode}@${g.baseX.toFixed(2)},${g.baseY.toFixed(2)}`));
}
