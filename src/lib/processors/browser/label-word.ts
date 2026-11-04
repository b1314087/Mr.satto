/**
 * ラベルシートをWord(.docx)で作成する。
 *
 * ラベル用紙の印刷では「mm単位の正確な大きさ」が大事なため、Wordの表を使う。
 *   - 用紙サイズ・上と左の余白は、Wordのページ設定そのもの(余白＝ラベルの開始位置)
 *   - 列の幅・行の高さはmmから変換した固定値(行の高さは「固定」。文字が多くても枠は広がらない)
 *   - ラベルどうしの間隔は、幅(高さ)を持つ空の列・行として挿入する
 * Excelの列幅は「文字数」という単位への近似になりずれやすいが、Wordの表はmm相当の値で
 * 指定できるため、ラベル用紙の寸法に合わせやすい。
 */
import {
  LABEL_FONTS,
  buildAxisPlan,
  mmToTwips,
  paperSizeMm,
  planLabelPages,
  validateStyle,
  type LabelSettings,
} from "@/lib/label/layout";
import { BrowserProcessor } from "../types";

export interface LabelOutput {
  blob: Blob;
  pageCount: number;
  filledCount: number;
}

export class LabelWordProcessor extends BrowserProcessor<LabelSettings, LabelOutput> {
  async process(settings: LabelSettings): Promise<LabelOutput> {
    const { geometry: g, style: s, content } = settings;
    const styleError = validateStyle(s);
    if (styleError) throw new Error(styleError);
    const plan = planLabelPages(g, content);

    const {
      Document,
      Footer,
      Header,
      Packer,
      Paragraph,
      Table,
      TableRow,
      TableCell,
      TextRun,
      AlignmentType,
      BorderStyle,
      HeightRule,
      LineRuleType,
      PageOrientation,
      TableLayoutType,
      VerticalAlign,
      WidthType,
    } = await import("docx");

    const font = LABEL_FONTS.find((f) => f.key === s.fontKey) ?? LABEL_FONTS[0];
    const fontAttrs = { ascii: font.name, hAnsi: font.name, eastAsia: font.name, cs: font.name };
    const halfPt = Math.max(1, Math.round(s.fontSizePt * 2));
    const align =
      s.hAlign === "left" ? AlignmentType.LEFT : s.hAlign === "right" ? AlignmentType.RIGHT : AlignmentType.CENTER;
    const vAlign =
      s.vAlign === "top" ? VerticalAlign.TOP : s.vAlign === "bottom" ? VerticalAlign.BOTTOM : VerticalAlign.CENTER;
    const pad = mmToTwips(s.paddingMm);

    const rowPlan = buildAxisPlan(g.rows, g.labelHeightMm, g.gapVMm, 0);
    const colPlan = buildAxisPlan(g.columns, g.labelWidthMm, g.gapHMm, 0);
    const colWidths = colPlan.map((seg) => mmToTwips(seg.mm));
    const rowHeights = rowPlan.map((seg) => mmToTwips(seg.mm));
    const tableWidth = colWidths.reduce((a, b) => a + b, 0);
    const paper = paperSizeMm(g.paper, g.landscape);
    const pageW = mmToTwips(paper.widthMm);
    const pageH = mmToTwips(paper.heightMm);
    const marginTop = mmToTwips(g.marginTopMm);
    const marginLeft = mmToTwips(g.marginLeftMm);

    // 表のあとに必ず必要な空段落(1pt)と、ごく小さいフッター(1pt)が、ページの下に収まるよう、
    // 余りが足りないときは最終行を少しだけ詰める（足りないと、Wordでは最後の行が次のページへ送られ、ラベルがずれる）
    const tableHeight = rowHeights.reduce((a, b) => a + b, 0);
    const slack = pageH - marginTop - tableHeight;
    const NEEDED_SLACK = 60;
    if (slack < NEEDED_SLACK && rowHeights.length > 0) {
      rowHeights[rowHeights.length - 1] = Math.max(20, rowHeights[rowHeights.length - 1] - (NEEDED_SLACK - slack));
    }

    // ヘッダー・フッターは、ごく小さい（1pt）空の段落だけにする。
    // 何も指定しないと、Wordは空のヘッダー・フッターにも標準の文字の高さ（約5〜6mm）を確保するため、
    // 上の余白が小さいラベル用紙では表の開始位置が下へずれ、下に余裕のないラベル用紙では最後の行が次のページへ送られる
    // （「縦6行にしたのに、Wordでは1ページ5行になり、ずれる」の原因）。
    const tinyParagraph = () =>
      new Paragraph({
        spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
        run: { size: 2 },
        children: [],
      });

    const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } as const;
    const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
    const lineBorder = { style: BorderStyle.SINGLE, size: 4, color: "999999" } as const;
    const lineBorders = { top: lineBorder, bottom: lineBorder, left: lineBorder, right: lineBorder };
    const lineSpacing = Math.round(240 * (s.lineSpacingPct / 100));

    const makeParagraphs = (text: string) => {
      const lines = text === "" ? [""] : text.split("\n");
      return lines.map(
        (line) =>
          new Paragraph({
            alignment: align,
            spacing: { before: 0, after: 0, line: lineSpacing, lineRule: LineRuleType.AUTO },
            run: { size: halfPt, font: fontAttrs },
            children: line === "" ? [] : [new TextRun({ text: line, size: halfPt, bold: s.bold, font: fontAttrs })],
          })
      );
    };

    const spacerCell = (width: number) =>
      new TableCell({
        width: { size: width, type: WidthType.DXA },
        borders: noBorders,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        children: [new Paragraph({ spacing: { before: 0, after: 0 }, run: { size: 2 }, children: [] })],
      });

    const sections = plan.pages.map((labels) => {
      let labelIndex = 0;
      const rows = rowPlan.map((rowSeg, ri) => {
        const cells = colPlan.map((colSeg, ci) => {
          if (rowSeg.kind !== "label" || colSeg.kind !== "label") return spacerCell(colWidths[ci]);
          const text = labels[labelIndex++] ?? "";
          return new TableCell({
            width: { size: colWidths[ci], type: WidthType.DXA },
            verticalAlign: vAlign,
            borders: s.border ? lineBorders : noBorders,
            margins: { top: pad, bottom: pad, left: pad, right: pad },
            children: makeParagraphs(text),
          });
        });
        return new TableRow({
          height: { value: rowHeights[ri], rule: HeightRule.EXACT },
          cantSplit: true,
          children: cells,
        });
      });

      const table = new Table({
        rows,
        width: { size: tableWidth, type: WidthType.DXA },
        columnWidths: colWidths,
        layout: TableLayoutType.FIXED,
        margins: { marginUnitType: WidthType.DXA, top: 0, bottom: 0, left: 0, right: 0 },
        borders: {
          top: noBorder,
          bottom: noBorder,
          left: noBorder,
          right: noBorder,
          insideHorizontal: noBorder,
          insideVertical: noBorder,
        },
      });

      return {
        properties: {
          page: {
            // docxは縦向きの寸法を渡し、向きを横にするときは内部で縦横を入れ替える
            size: g.landscape
              ? { width: mmToTwips(paperSizeMm(g.paper, false).widthMm), height: mmToTwips(paperSizeMm(g.paper, false).heightMm), orientation: PageOrientation.LANDSCAPE }
              : { width: pageW, height: pageH },
            margin: { top: marginTop, left: marginLeft, right: 0, bottom: 0, header: 0, footer: 0, gutter: 0 },
          },
        },
        headers: { default: new Header({ children: [tinyParagraph()] }) },
        footers: { default: new Footer({ children: [tinyParagraph()] }) },
        children: [
          table,
          new Paragraph({
            spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
            run: { size: 2 },
            children: [],
          }),
        ],
      };
    });

    const doc = new Document({
      creator: "Mr.Satto",
      title: "ラベルシート",
      sections,
    });
    const blob = await Packer.toBlob(doc);
    return { blob, pageCount: plan.pages.length, filledCount: plan.filledCount };
  }
}
