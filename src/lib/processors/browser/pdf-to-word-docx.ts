import type { DocumentBlock, ImageBlock, ListItemBlock, RunInfo, TableBlock } from "@/lib/pdf/paragraph-reconstruction";

/**
 * PDF→Wordの文書ブロック列から、Word文書(.docx)を組み立てる。
 *
 * DOCX生成には `docx` パッケージを利用する（MITライセンス。ブラウザ内で
 * Packer.toBlob() により生成でき、ファイルは外部へ送信されない）。
 *
 * ページの大きさ・余白は元のPDFに合わせ、表は列の幅を明示する
 * （幅を指定しないと、Word以外のソフト(LibreOffice等)で表が極端に細くなる）。
 * 箇条書き・番号リストはWordの自動番号として出力する。
 */

export interface DocxPageSetup {
  widthPt: number;
  heightPt: number;
  marginLeftPt: number;
  marginRightPt: number;
  marginTopPt: number;
  marginBottomPt: number;
}

export interface DocxBuildInput {
  blocks: DocumentBlock[];
  page?: DocxPageSetup;
  /** 毎ページ繰り返されていたヘッダー・フッターの文字 */
  headerText?: string;
  footerText?: string;
  /** 元のPDFにページ番号があった場合はフッターに自動のページ番号を入れる */
  pageNumber?: boolean;
}

const A4: DocxPageSetup = {
  widthPt: 595.3,
  heightPt: 841.9,
  marginLeftPt: 72,
  marginRightPt: 72,
  marginTopPt: 72,
  marginBottomPt: 72,
};

const pt2tw = (pt: number) => Math.round(pt * 20);

type OrderedStyle = "dot" | "paren" | "parens" | "circle";

function orderedStyleOf(marker: string): OrderedStyle {
  if (/^[①-⑳㉑-㉟]$/.test(marker)) return "circle";
  if (/^[(（]/.test(marker)) return "parens";
  if (/[)）]$/.test(marker)) return "paren";
  return "dot";
}

export async function buildDocxBlob(input: DocxBuildInput): Promise<Blob> {
  const docx = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    LevelFormat,
    ImageRun,
    ExternalHyperlink,
    Header,
    Footer,
    PageNumber,
    PageOrientation,
    PageBreak,
    ShadingType,
    UnderlineType,
  } = docx;

  const page = input.page ?? A4;
  const contentWidthPt = Math.max(100, page.widthPt - page.marginLeftPt - page.marginRightPt);

  type Align = (typeof AlignmentType)[keyof typeof AlignmentType];
  const alignOf = (a?: "left" | "center" | "right"): Align | undefined =>
    a === "center" ? AlignmentType.CENTER : a === "right" ? AlignmentType.RIGHT : undefined;

  const fontOf = (r: { serif?: boolean; mono?: boolean }) =>
    r.mono
      ? { ascii: "Courier New", hAnsi: "Courier New", eastAsia: "MS Gothic" }
      : r.serif
        ? { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia: "Yu Mincho" }
        : { ascii: "Arial", hAnsi: "Arial", eastAsia: "Yu Gothic" };

  function makeRuns(runs: RunInfo[] | undefined, text: string, isHeading: boolean) {
    const source: RunInfo[] = runs && runs.length > 0 ? runs : [{ text }];
    return source.map((r) => {
      const base = {
        text: r.text,
        bold: r.bold ? true : undefined,
        italics: r.italic ? true : undefined,
        size: r.size ? Math.max(2, Math.round(r.size * 2)) : undefined,
        font: fontOf(r),
        shading: r.highlight ? { type: ShadingType.CLEAR, color: "auto", fill: r.highlight } : undefined,
      };
      if (r.link) {
        return new ExternalHyperlink({
          link: r.link,
          children: [
            new TextRun({ ...base, color: "0563C1", underline: { type: UnderlineType.SINGLE } }),
          ],
        });
      }
      return new TextRun({ ...base, color: r.color ?? (isHeading ? "000000" : undefined) });
    });
  }

  // 番号リスト: 連続する番号項目を1つのリスト（同じ「インスタンス」）として番号を振る
  let instance = 0;
  let prevOrderedRef: string | null = null;
  const instanceOf = (block: DocumentBlock, ref: string | null): number => {
    if (ref === null) {
      prevOrderedRef = null;
      return 0;
    }
    if (prevOrderedRef !== ref) instance++;
    prevOrderedRef = ref;
    return instance;
  };

  function buildTable(block: TableBlock) {
    const colCount = Math.max(1, ...block.rows.map((r) => r.length));
    let widthsPt: number[];
    if (block.colWidths && block.colWidths.length === colCount) {
      widthsPt = [...block.colWidths];
    } else {
      widthsPt = Array.from({ length: colCount }, () => contentWidthPt / colCount);
    }
    const total = widthsPt.reduce((a, b) => a + b, 0);
    if (total > contentWidthPt) widthsPt = widthsPt.map((w) => (w * contentWidthPt) / total);
    const dxa = widthsPt.map((w) => Math.max(360, pt2tw(w)));
    const tableWidth = dxa.reduce((a, b) => a + b, 0);

    const spans = new Map<string, number>();
    for (const s of block.spans ?? []) spans.set(`${s.row}:${s.col}`, s.span);
    const size = block.fontSize ? Math.max(2, Math.round(block.fontSize * 2)) : undefined;

    const rows = block.rows.map((row, r) => {
      const cells = [];
      for (let c = 0; c < colCount; c++) {
        const span = Math.max(1, Math.min(spans.get(`${r}:${c}`) ?? 1, colCount - c));
        const text = (span > 1 ? row.slice(c, c + span).filter(Boolean).join(" ") : (row[c] ?? "")).trim();
        const width = dxa.slice(c, c + span).reduce((a, b) => a + b, 0);
        const fill = block.fills?.[r]?.[c] ?? null;
        cells.push(
          new TableCell({
            width: { size: width, type: WidthType.DXA },
            columnSpan: span > 1 ? span : undefined,
            shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
            children: [
              new Paragraph({
                alignment: alignOf(block.aligns?.[r]?.[c]),
                children: [new TextRun({ text, size, font: fontOf({}) })],
              }),
            ],
          })
        );
        c += span - 1;
      }
      return new TableRow({ children: cells });
    });
    return new Table({
      width: { size: tableWidth, type: WidthType.DXA },
      columnWidths: dxa,
      rows,
    });
  }

  function buildImage(block: ImageBlock) {
    let w = block.width;
    let h = block.height;
    if (w > contentWidthPt) {
      h = (h * contentWidthPt) / w;
      w = contentWidthPt;
    }
    return new Paragraph({
      alignment: alignOf(block.align),
      spacing: { before: 60, after: 120 },
      children: [
        new ImageRun({
          type: "png",
          data: block.data,
          // ピクセル単位（96dpi換算）
          transformation: { width: Math.max(1, Math.round((w * 96) / 72)), height: Math.max(1, Math.round((h * 96) / 72)) },
          altText: { title: "画像", description: "PDFから取り出した画像", name: "image" },
        }),
      ],
    });
  }

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  for (const block of input.blocks) {
    let ref: string | null = null;
    if (block.type === "list" && block.ordered) ref = `ord-${orderedStyleOf(block.marker)}`;
    const inst = instanceOf(block, ref);

    if (block.type === "heading1" || block.type === "heading2") {
      children.push(
        new Paragraph({
          heading: block.type === "heading1" ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
          alignment: alignOf(block.align),
          children: makeRuns(block.runs, block.text, true),
        })
      );
    } else if (block.type === "table") {
      children.push(buildTable(block));
      // 表の直後に次の表・段落がくっつかないよう、小さな空行を入れる
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
    } else if (block.type === "image") {
      children.push(buildImage(block));
    } else if (block.type === "list") {
      const item: ListItemBlock = block;
      children.push(
        new Paragraph({
          numbering: item.ordered
            ? { reference: ref!, level: item.level, instance: inst }
            : { reference: "bullets", level: item.level },
          spacing: { after: 40 },
          children: makeRuns(item.runs, item.text, false),
        })
      );
    } else if (block.type === "paragraph" && block.pageBreak) {
      // 元のPDFで、ページの途中までしか文字が無いページの区切り（表紙・署名ページなど）を、改ページとして残す
      children.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (block.type === "paragraph") {
      children.push(
        new Paragraph({
          alignment: alignOf(block.align),
          indent:
            block.indent || block.firstLineIndent
              ? {
                  left: block.indent ? pt2tw(block.indent) : undefined,
                  firstLine: block.firstLineIndent ? pt2tw(block.firstLineIndent) : undefined,
                }
              : undefined,
          spacing: { after: 100 },
          children: makeRuns(block.runs, block.text, false),
        })
      );
    }
  }
  if (children.length === 0) children.push(new Paragraph({ children: [] }));

  const bulletChars = ["•", "◦", "▪", "•"];
  const orderedFormats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL];
  const levelIndent = (level: number) => ({ left: 540 + level * 540, hanging: 360 });
  const orderedConfig = (reference: string, textOf: (level: number) => string, format?: (typeof LevelFormat)[keyof typeof LevelFormat]) => ({
    reference,
    levels: [0, 1, 2, 3].map((level) => ({
      level,
      format: format ?? orderedFormats[level],
      text: textOf(level),
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: levelIndent(level) } },
    })),
  });

  const header = input.headerText
    ? new Header({ children: [new Paragraph({ children: [new TextRun({ text: input.headerText, size: 18, font: fontOf({}) })] })] })
    : undefined;
  const footerChildren = [];
  if (input.footerText) {
    footerChildren.push(new Paragraph({ children: [new TextRun({ text: input.footerText, size: 18, font: fontOf({}) })] }));
  }
  if (input.pageNumber) {
    footerChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], size: 18 })],
      })
    );
  }
  const footer = footerChildren.length > 0 ? new Footer({ children: footerChildren }) : undefined;

  const landscape = page.widthPt > page.heightPt;
  const doc = new Document({
    styles: {
      default: { document: { run: { font: fontOf({}), size: 21 } } },
      paragraphStyles: [
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: "000000", bold: false },
          paragraph: { spacing: { before: 200, after: 120 }, keepNext: true },
        },
        {
          id: "Heading2",
          name: "Heading 2",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { color: "000000", bold: false },
          paragraph: { spacing: { before: 160, after: 100 }, keepNext: true },
        },
      ],
    },
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: bulletChars[level],
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: levelIndent(level) } },
          })),
        },
        orderedConfig("ord-dot", (l) => `%${l + 1}.`),
        orderedConfig("ord-paren", (l) => `%${l + 1})`),
        orderedConfig("ord-parens", (l) => `(%${l + 1})`),
        orderedConfig("ord-circle", (l) => `%${l + 1}`, LevelFormat.DECIMAL_ENCLOSED_CIRCLE),
      ],
    },
    sections: [
      {
        properties: {
          page: {
            // docxは縦向きの値で指定し、向きは orientation で切り替える
            size: {
              width: pt2tw(Math.min(page.widthPt, page.heightPt)),
              height: pt2tw(Math.max(page.widthPt, page.heightPt)),
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: {
              left: pt2tw(page.marginLeftPt),
              right: pt2tw(page.marginRightPt),
              top: pt2tw(page.marginTopPt),
              bottom: pt2tw(page.marginBottomPt),
              header: 360,
              footer: 360,
            },
          },
        },
        headers: header ? { default: header } : undefined,
        footers: footer ? { default: footer } : undefined,
        children,
      },
    ],
  });
  return Packer.toBlob(doc);
}
