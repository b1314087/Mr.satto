/**
 * ラベルシートをExcelで作成する(Word出力の補助的な選択肢)。
 *
 * 余白・間隔は、その分の空白行・空白列をシートへ実際に挿入して表現する。
 * 行の高さはmm→pt(正確)だが、列幅はExcelの「文字数」単位への近似変換になるため、
 * 実際の見た目は環境によって多少前後する。用紙サイズ・印刷余白はExcelの印刷設定側で行う。
 * ページが複数になるときは、ページごとにシートを分ける。
 */
import { mmToPt } from "@/lib/print/paper-sizes";
import { writeXlsxSheets, mmToExcelColumnWidth } from "@/lib/excel/xlsx-simple-io";
import { LABEL_FONTS, buildAxisPlan, planLabelPages, validateStyle, type LabelSettings } from "@/lib/label/layout";
import { BrowserProcessor } from "../types";
import type { LabelOutput } from "./label-word";

export class ExcelLabelProcessor extends BrowserProcessor<LabelSettings, LabelOutput> {
  async process(settings: LabelSettings): Promise<LabelOutput> {
    const { geometry: g, style: s, content } = settings;
    const styleError = validateStyle(s);
    if (styleError) throw new Error(styleError);
    const plan = planLabelPages(g, content);

    const rowPlan = buildAxisPlan(g.rows, g.labelHeightMm, g.gapVMm, g.marginTopMm);
    const colPlan = buildAxisPlan(g.columns, g.labelWidthMm, g.gapHMm, g.marginLeftMm);
    const columns = colPlan.map((seg) => ({ width: mmToExcelColumnWidth(seg.mm) }));
    const font = LABEL_FONTS.find((f) => f.key === s.fontKey) ?? LABEL_FONTS[0];
    const align = s.hAlign;
    const alignVertical = s.vAlign === "middle" ? "center" : s.vAlign;

    const sheets = plan.pages.map((labels, pageIndex) => {
      let labelIndex = 0;
      const rows = rowPlan.map((rowSeg) => {
        const heightPt = mmToPt(rowSeg.mm);
        return colPlan.map((colSeg, colIdx) => {
          const isLabelCell = rowSeg.kind === "label" && colSeg.kind === "label";
          const cell: Record<string, unknown> = { value: isLabelCell ? (labels[labelIndex++] ?? "") || null : "" };
          if (colIdx === 0) cell.height = heightPt;
          if (isLabelCell) {
            cell.align = align;
            cell.alignVertical = alignVertical;
            cell.wrap = true;
            cell.fontSize = s.fontSizePt;
            cell.fontFamily = font.name;
            if (s.bold) cell.fontWeight = "bold";
            if (s.border) {
              cell.borderStyle = "thin";
              cell.borderColor = "#999999";
            }
          }
          return cell;
        });
      });
      return { name: plan.pages.length === 1 ? "ラベル" : `ラベル${pageIndex + 1}`, rows, columns };
    });

    const blob = await writeXlsxSheets(sheets);
    return { blob, pageCount: plan.pages.length, filledCount: plan.filledCount };
  }
}
