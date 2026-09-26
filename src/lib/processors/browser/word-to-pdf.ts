import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  degrees,
  setTextRenderingMode,
  TextRenderingMode,
  setLineWidth,
  setStrokingRgbColor,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { BrowserProcessor } from "../types";
import type { PdfProcessorOutput } from "../types";
import { loadJapaneseFontBytes } from "@/lib/pdf/japanese-font";
import { addLinkAnnotation } from "@/lib/pdf/pdf-link-annotation";

/**
 * Word（DOCX）→ PDF Processor（Phase 9）。
 *
 * 開発指示書■10の方針どおり、「Wordと見た目が完全一致すること」は保証しない。
 * 目標は、段落・見出し・太字/斜体/下線・箇条書き・番号付きリスト・改ページ・表・
 * 画像・リンクといった基本要素を、実際に開けるPDFへ実用的な精度で変換すること。
 *
 * 変換方式（■5・■11）:
 *   DOCX
 *    → mammoth（DOCX→HTMLの定番ライブラリ。BSD-2-Clauseライセンス・
 *      ブラウザ向けエントリを公式に持つ。新規追加した唯一の依存パッケージ）
 *    → HTML文字列
 *    → DOMParser（ブラウザ標準API）でDOM構造として解析
 *      ※ DOMParserが生成するDocumentはページに一切アタッチされないため、
 *        <script>は実行されず、<img>等の外部リソースも自動取得されない
 *        （■11・■12: 生成HTMLをそのままinnerHTML/dangerouslySetInnerHTMLで
　*        DOMへ挿入しない、危険なコンテンツを安全に扱う、という要件を満たす）。
 *        また、テキスト・タグ構造のみを読み取り、DOM自体を表示に使わないため
 *        独立したサニタイズライブラリは追加していない。
 *    → 内部ドキュメントモデル（段落/見出し/リスト/表/画像/改ページ）
 *    → pdf-lib + 既存の日本語TrueTypeフォント資産（Noto Sans JP）で
 *      A4 PDFへ描画・ページ分割
 *
 * フォントについて: 既存資産はNoto Sans JPのRegularウェイトのみのため
 * （■15: 新しいフォントファイルは追加しない）、太字はPDFのテキスト描画モードを
 * 一時的に「塗り+縁取り(FillAndOutline)」に切り替えて縁取りを太らせる疑似ボールド、
 * 斜体はpdf-libのxSkewでの疑似イタリックで近似する。
 * 太字を「同じ文字を僅かにずらして2回描画する」方式にすると、PDFのテキスト
 * レイヤーに同じ文字列が2回出現してしまい、コピー&ペーストや検索で太字部分が
 * 重複してしまう副作用があるため採用しなかった（drawText呼び出しは1回のまま、
 * テキスト描画モードのみ切り替える）。実際のBold/Italicフォントの字形とは
 * 異なる（■10のとおり完全一致は保証しない）が、視覚的に区別できることを
 * 優先した。
 */

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const BOTTOM_LIMIT = MARGIN;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 15;
const PARAGRAPH_GAP = 6;

/** 未検証のDOCXを信頼しないための安全策（■18・■34）。妥当なDOCXは通常これより
 *  はるかに小さいため、この上限自体がZIP爆弾的な入力への一次防御になる。 */
const MAX_DOCX_SIZE_BYTES = 30 * 1024 * 1024;
/** 1枚あたりの画像デコード後サイズの上限（巨大画像によるメモリ逼迫を防ぐ） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PAGE_COUNT = 300;

const PAGE_BREAK_MARKER = "MRSATTO_PAGE_BREAK";

// ---------------------------------------------------------------------------
// 内部ドキュメントモデル
// ---------------------------------------------------------------------------
interface TextRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}
interface ListMeta {
  ordered: boolean;
  level: number;
  number?: number;
}
interface ParagraphBlock {
  kind: "paragraph";
  runs: TextRun[];
  heading: number; // 0 = 通常段落, 1-6 = 見出しレベル
  list?: ListMeta;
}
interface TableBlock {
  kind: "table";
  rows: TextRun[][][]; // rows[row][col] = そのセルのruns
}
interface ImageBlock {
  kind: "image";
  dataUri: string;
  altText: string;
}
interface PageBreakBlock {
  kind: "pagebreak";
}
type DocBlock = ParagraphBlock | TableBlock | ImageBlock | PageBreakBlock;

// ---------------------------------------------------------------------------
// mammothの内部ドキュメントツリーを変換前に走査し、
// 明示的な改ページ(w:br type="page")を、後段のHTML走査で検出できる
// 目印つき段落に置き換える（mammothは既定では手動改ページをHTML化しない）。
// mammothの公開オプション transformDocument（options-reader.jsに定義された
// 正式なオプション）を利用する、型がゆるいプラグイン的な拡張ポイントのため
// unknown型で慎重に扱う。
// ---------------------------------------------------------------------------
function markPageBreaks(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  let next: Record<string, unknown> = obj;
  if (Array.isArray(obj.children)) {
    next = { ...obj, children: obj.children.map(markPageBreaks) };
  }
  if (next.type === "break" && next.breakType === "page") {
    return {
      type: "paragraph",
      styleId: null,
      styleName: null,
      numbering: null,
      alignment: null,
      indent: { start: null, end: null, firstLine: null, hanging: null },
      children: [
        {
          type: "run",
          styleId: null,
          styleName: null,
          isBold: false,
          isUnderline: false,
          isItalic: false,
          isStrikethrough: false,
          isAllCaps: false,
          isSmallCaps: false,
          verticalAlignment: "baseline",
          font: null,
          fontSize: null,
          highlight: null,
          children: [{ type: "text", value: PAGE_BREAK_MARKER }],
        },
      ],
    };
  }
  return next;
}

/** インライン要素(strong/em/u/a/text)を再帰的に読み、TextRunの配列へ展開する */
function extractRuns(
  node: ChildNode,
  style: { bold: boolean; italic: boolean; underline: boolean; link?: string }
): TextRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (text === "") return [];
    return [{ text, ...style }];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return [{ text: "\n", ...style }];
  const nextStyle = { ...style };
  if (tag === "strong" || tag === "b") nextStyle.bold = true;
  if (tag === "em" || tag === "i") nextStyle.italic = true;
  if (tag === "u") nextStyle.underline = true;
  if (tag === "a") {
    const href = el.getAttribute("href");
    if (href && /^https?:\/\//i.test(href)) nextStyle.link = href;
  }
  const runs: TextRun[] = [];
  el.childNodes.forEach((child) => {
    runs.push(...extractRuns(child, nextStyle));
  });
  return runs;
}

function isPageBreakParagraph(runs: TextRun[]): boolean {
  const joined = runs.map((r) => r.text).join("");
  return joined.trim() === PAGE_BREAK_MARKER.trim() || joined.includes(PAGE_BREAK_MARKER);
}

/** <table>を内部モデルのTableBlockへ変換する。colspan/rowspanによる視覚的な
 *  結合は行わないが（■28: 完全一致は保証しない）、セルの文字は失わずそのまま
 *  出力する。 */
function extractTable(tableEl: Element): TableBlock {
  const rows: TextRun[][][] = [];
  const rowEls = Array.from(tableEl.querySelectorAll(":scope > tbody > tr, :scope > tr"));
  for (const rowEl of rowEls) {
    const cells: TextRun[][] = [];
    const cellEls = Array.from(rowEl.querySelectorAll(":scope > td, :scope > th"));
    for (const cellEl of cellEls) {
      const runs: TextRun[] = [];
      cellEl.childNodes.forEach((child) => {
        runs.push(...extractRuns(child, { bold: cellEl.tagName.toLowerCase() === "th", italic: false, underline: false }));
      });
      cells.push(runs);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return { kind: "table", rows };
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/** mammothが生成したHTML文字列を内部ドキュメントモデルへ変換する */
function htmlToBlocks(html: string): { blocks: DocBlock[]; warnings: string[] } {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: DocBlock[] = [];

  function walkListItems(listEl: Element, ordered: boolean, level: number) {
    let index = 0;
    Array.from(listEl.children).forEach((child) => {
      if (child.tagName.toLowerCase() !== "li") return;
      index += 1;
      const runs: TextRun[] = [];
      const nestedLists: Element[] = [];
      child.childNodes.forEach((grandchild) => {
        if (
          grandchild.nodeType === Node.ELEMENT_NODE &&
          ["ul", "ol"].includes((grandchild as Element).tagName.toLowerCase())
        ) {
          nestedLists.push(grandchild as Element);
        } else {
          runs.push(...extractRuns(grandchild, { bold: false, italic: false, underline: false }));
        }
      });
      if (runs.some((r) => r.text.trim() !== "")) {
        blocks.push({ kind: "paragraph", runs, heading: 0, list: { ordered, level, number: index } });
      }
      for (const nested of nestedLists) {
        walkListItems(nested, nested.tagName.toLowerCase() === "ol", level + 1);
      }
    });
  }

  function walkBlockLevel(el: Element) {
    Array.from(el.children).forEach((child) => {
      const tag = child.tagName.toLowerCase();
      if (tag in HEADING_LEVEL) {
        const runs: TextRun[] = [];
        child.childNodes.forEach((c) => runs.push(...extractRuns(c, { bold: false, italic: false, underline: false })));
        if (runs.length > 0) blocks.push({ kind: "paragraph", runs, heading: HEADING_LEVEL[tag] });
        return;
      }
      if (tag === "p") {
        const runs: TextRun[] = [];
        let hasImage = false;
        child.childNodes.forEach((c) => {
          if (c.nodeType === Node.ELEMENT_NODE && (c as Element).tagName.toLowerCase() === "img") {
            hasImage = true;
            const img = c as Element;
            const src = img.getAttribute("src") || "";
            if (src.startsWith("data:image/")) {
              blocks.push({ kind: "image", dataUri: src, altText: img.getAttribute("alt") || "" });
            } else {
              warnings.push("data URI形式でない画像を検出したため省略しました");
            }
          } else {
            runs.push(...extractRuns(c, { bold: false, italic: false, underline: false }));
          }
        });
        if (!hasImage) {
          if (isPageBreakParagraph(runs)) {
            blocks.push({ kind: "pagebreak" });
          } else {
            blocks.push({ kind: "paragraph", runs, heading: 0 });
          }
        }
        return;
      }
      if (tag === "ul" || tag === "ol") {
        walkListItems(child, tag === "ol", 0);
        return;
      }
      if (tag === "table") {
        blocks.push(extractTable(child));
        return;
      }
      if (tag === "img") {
        const src = child.getAttribute("src") || "";
        if (src.startsWith("data:image/")) {
          blocks.push({ kind: "image", dataUri: src, altText: child.getAttribute("alt") || "" });
        }
        return;
      }
      // blockquote / div等、上記に該当しない要素は中身をそのまま段落として再帰的に扱う
      walkBlockLevel(child);
    });
  }

  walkBlockLevel(doc.body);
  return { blocks, warnings };
}

// ---------------------------------------------------------------------------
// PDF描画
// ---------------------------------------------------------------------------
interface FlatChar {
  ch: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}
interface Segment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  link?: string;
}

function flattenRuns(runs: TextRun[]): FlatChar[] {
  const out: FlatChar[] = [];
  for (const run of runs) {
    for (const ch of Array.from(run.text)) {
      out.push({ ch, bold: run.bold, italic: run.italic, underline: run.underline, link: run.link });
    }
  }
  return out;
}

/** 日本語には単語区切りが無いため、既存のdocument-pdf.tsと同様に
 *  1文字単位で幅を計測して折り返す。 */
function wrapFlatChars(chars: FlatChar[], font: PDFFont, size: number, maxWidth: number): FlatChar[][] {
  const lines: FlatChar[][] = [];
  let current: FlatChar[] = [];
  let currentWidth = 0;
  for (const fc of chars) {
    if (fc.ch === "\n") {
      lines.push(current);
      current = [];
      currentWidth = 0;
      continue;
    }
    const w = font.widthOfTextAtSize(fc.ch === " " ? " " : fc.ch, size);
    if (current.length > 0 && currentWidth + w > maxWidth) {
      lines.push(current);
      current = [fc];
      currentWidth = w;
    } else {
      current.push(fc);
      currentWidth += w;
    }
  }
  lines.push(current);
  return lines.length > 0 ? lines : [[]];
}

function groupSegments(line: FlatChar[]): Segment[] {
  const segments: Segment[] = [];
  for (const fc of line) {
    const last = segments[segments.length - 1];
    if (last && last.bold === fc.bold && last.italic === fc.italic && last.underline === fc.underline && last.link === fc.link) {
      last.text += fc.ch;
    } else {
      segments.push({ text: fc.ch, bold: fc.bold, italic: fc.italic, underline: fc.underline, link: fc.link });
    }
  }
  return segments;
}

export interface WordToPdfInput {
  file: File;
}

export interface WordToPdfOutput extends PdfProcessorOutput {
  warnings: string[];
  paragraphCount: number;
  tableCount: number;
  imageCount: number;
}

export class WordToPdfProcessor extends BrowserProcessor<WordToPdfInput, WordToPdfOutput> {
  async process({ file }: WordToPdfInput): Promise<WordToPdfOutput> {
    if (file.size === 0) {
      throw new Error("空のファイルは処理できません。別のファイルを選択してください。");
    }
    if (file.size > MAX_DOCX_SIZE_BYTES) {
      throw new Error(
        `ファイルサイズの上限は${Math.floor(MAX_DOCX_SIZE_BYTES / 1024 / 1024)}MBです。より小さいファイルでお試しください。`
      );
    }
    const isDocx =
      file.name.toLowerCase().endsWith(".docx") ||
      file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (!isDocx) {
      throw new Error("Word文書(.docx)ファイルを選択してください。");
    }

    let arrayBuffer: ArrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch {
      throw new Error("ファイルの読み込みに失敗しました");
    }

    const mammoth = await import("mammoth");
    let html: string;
    const warnings: string[] = [];
    try {
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        {
          convertImage: mammoth.images.dataUri,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transformDocument: markPageBreaks as any,
        }
      );
      html = result.value;
      for (const message of result.messages) {
        if (message.type === "error") warnings.push(message.message);
      }
    } catch {
      throw new Error(
        "Word文書の解析に失敗しました。ファイルが破損しているか、対応していない形式の可能性があります。"
      );
    }

    const { blocks, warnings: parseWarnings } = htmlToBlocks(html);
    warnings.push(...parseWarnings);

    if (blocks.length === 0) {
      throw new Error("このWord文書から変換できる内容が見つかりませんでした。");
    }

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

    let page: PDFPage = doc.addPage([A4_WIDTH, A4_HEIGHT]);
    let cursorY = A4_HEIGHT - MARGIN;

    function newPage() {
      if (doc.getPageCount() >= MAX_PAGE_COUNT) {
        throw new Error(`変換できるページ数の上限は${MAX_PAGE_COUNT}ページです。`);
      }
      page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
      cursorY = A4_HEIGHT - MARGIN;
    }

    function ensureSpace(height: number) {
      if (cursorY - height < BOTTOM_LIMIT) newPage();
    }

    function drawSegment(seg: Segment, x: number, y: number, size: number): number {
      const color = seg.link ? rgb(0.1, 0.32, 0.75) : rgb(0.12, 0.12, 0.14);
      const chars = Array.from(seg.text);

      if (seg.bold) {
        page.pushOperators(
          setLineWidth(size * 0.028),
          setStrokingRgbColor(color.red, color.green, color.blue),
          setTextRenderingMode(TextRenderingMode.FillAndOutline)
        );
      }
      // 1文字ずつdrawTextを呼び出す（■word-to-pdf.ts内で発見した問題への対処）。
      // pdf-lib(内部でfontkitのfont.layout()を使用)にNoto Sans JPをsubset:false
      // で埋め込んだ状態で、英字に数字が直接続く文字列（例:"A1"。日本語+数字や
      // 数字のみの文字列では発生しない）を1回のdrawText呼び出しで描画すると、
      // 表示される見た目（グリフの形）は正しいまま、PDFのテキスト情報
      // (ToUnicode。コピー&ペースト・検索・スクリーンリーダーが参照する情報)
      // だけが無関係な文字に化けることを実機検証で発見した。1文字ずつ描画すると
      // 1回の呼び出し内で複数文字にまたがる変換が起きないため回避できる。
      let cx = x;
      for (const ch of chars) {
        page.drawText(ch, {
          x: cx,
          y,
          size,
          font,
          color,
          ...(seg.italic ? { xSkew: degrees(12) } : {}),
        });
        cx += font.widthOfTextAtSize(ch, size);
      }
      const width = cx - x;
      if (seg.bold) {
        page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
      }
      if (seg.underline || seg.link) {
        page.drawLine({
          start: { x, y: y - 1.5 },
          end: { x: x + width, y: y - 1.5 },
          thickness: 0.6,
          color,
        });
      }
      if (seg.link) {
        addLinkAnnotation(doc, page, seg.link, { x, y: y - 2, width, height: size + 2 });
      }
      return width;
    }

    function drawParagraph(block: ParagraphBlock) {
      const runs = block.runs.filter((r) => r.text !== "");
      const isHeading = block.heading > 0;
      const size = isHeading ? Math.max(20 - (block.heading - 1) * 2, 12) : BODY_SIZE;
      const lineHeight = isHeading ? size + 6 : LINE_HEIGHT;
      const effectiveRuns: TextRun[] = isHeading ? runs.map((r) => ({ ...r, bold: true })) : runs;

      const indent = block.list ? 16 + block.list.level * 16 : 0;
      const maxWidth = CONTENT_WIDTH - indent;
      if (maxWidth <= 10) return;

      const chars = flattenRuns(effectiveRuns);
      if (chars.length === 0) {
        cursorY -= lineHeight * 0.6;
        return;
      }
      const lines = wrapFlatChars(chars, font, size, maxWidth);

      lines.forEach((lineChars, lineIdx) => {
        ensureSpace(lineHeight);
        let x = MARGIN + indent;
        if (block.list && lineIdx === 0) {
          const prefix = block.list.ordered ? `${block.list.number ?? 1}. ` : "・";
          page.drawText(prefix, { x: MARGIN + block.list.level * 16, y: cursorY - size, size, font, color: rgb(0.12, 0.12, 0.14) });
        }
        const segments = groupSegments(lineChars);
        for (const seg of segments) {
          const w = drawSegment(seg, x, cursorY - size, size);
          x += w;
        }
        cursorY -= lineHeight;
      });
      cursorY -= isHeading ? 6 : PARAGRAPH_GAP;
    }

    function drawTable(block: TableBlock) {
      if (block.rows.length === 0) return;
      const colCount = Math.max(...block.rows.map((r) => r.length));
      if (colCount === 0) return;
      const colWidth = CONTENT_WIDTH / colCount;
      const cellPadding = 5;
      const cellFontSize = 9;

      for (const row of block.rows) {
        const wrappedCells: FlatChar[][][] = row.map((cellRuns) =>
          wrapFlatChars(flattenRuns(cellRuns), font, cellFontSize, colWidth - cellPadding * 2)
        );
        const rowLineCount = Math.max(1, ...wrappedCells.map((c) => c.length));
        const rowHeight = rowLineCount * (cellFontSize + 4) + cellPadding * 2;

        ensureSpace(rowHeight);
        const rowTop = cursorY;
        for (let col = 0; col < colCount; col++) {
          const x = MARGIN + col * colWidth;
          page.drawRectangle({
            x,
            y: rowTop - rowHeight,
            width: colWidth,
            height: rowHeight,
            borderColor: rgb(0.75, 0.75, 0.78),
            borderWidth: 0.6,
          });
          const lines = wrappedCells[col] || [[]];
          lines.forEach((lineChars, lineIdx) => {
            let cx = x + cellPadding;
            const cy = rowTop - cellPadding - (lineIdx + 1) * (cellFontSize + 4) + 3;
            const segments = groupSegments(lineChars);
            for (const seg of segments) {
              const w = drawSegment(seg, cx, cy, cellFontSize);
              cx += w;
            }
          });
        }
        cursorY = rowTop - rowHeight;
      }
      cursorY -= PARAGRAPH_GAP;
    }

    async function drawImage(block: ImageBlock) {
      const match = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(block.dataUri);
      if (!match) {
        warnings.push("画像データの形式を認識できなかったため省略しました");
        return;
      }
      const [, mimeType, base64] = match;
      let bytes: Uint8Array;
      try {
        const binary = atob(base64);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      } catch {
        warnings.push("画像データの読み込みに失敗したため省略しました");
        return;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        warnings.push(`画像サイズが大きすぎるため省略しました（${block.altText || "無題の画像"}）`);
        return;
      }

      let embedded;
      try {
        if (mimeType === "image/png") {
          embedded = await doc.embedPng(bytes);
        } else if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
          embedded = await doc.embedJpg(bytes);
        } else {
          warnings.push(`対応していない画像形式(${mimeType})のため省略しました`);
          return;
        }
      } catch {
        warnings.push("破損している可能性のある画像を省略しました");
        return;
      }

      const maxHeight = A4_HEIGHT - MARGIN * 2;
      let { width, height } = embedded.scaleToFit(CONTENT_WIDTH, maxHeight);
      if (width <= 0 || height <= 0) {
        width = CONTENT_WIDTH;
        height = CONTENT_WIDTH * 0.5;
      }
      ensureSpace(height);
      page.drawImage(embedded, { x: MARGIN, y: cursorY - height, width, height });
      cursorY -= height + PARAGRAPH_GAP;
    }

    let paragraphCount = 0;
    let tableCount = 0;
    let imageCount = 0;

    for (const block of blocks) {
      if (block.kind === "pagebreak") {
        newPage();
        continue;
      }
      if (block.kind === "paragraph") {
        if (block.runs.some((r) => r.text.trim() !== "")) paragraphCount++;
        drawParagraph(block);
        continue;
      }
      if (block.kind === "table") {
        tableCount++;
        drawTable(block);
        continue;
      }
      if (block.kind === "image") {
        imageCount++;
        await drawImage(block);
        continue;
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await doc.save();
    } catch {
      throw new Error("PDFの書き出しに失敗しました");
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    return {
      blob,
      url: URL.createObjectURL(blob),
      pageCount: doc.getPageCount(),
      sizeBytes: blob.size,
      warnings: Array.from(new Set(warnings)),
      paragraphCount,
      tableCount,
      imageCount,
    };
  }
}
