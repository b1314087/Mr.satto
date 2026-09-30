/**
 * Excelラベル作成 Processor（Mr.Satto 次工程・印刷帳票4ツール追加フェーズ）。
 *
 * ラベル幅・高さ・行数・列数・上下左右余白・ラベル間隔（すべてmm指定）から、
 * 同じ文字内容を繰り返し配置したラベルシートを1枚のExcelとして書き出す。
 *
 * 余白・間隔は、write-excel-file（延いてはExcel自体）が公開していない
 * 「mm単位の印刷余白」機能の代わりに、その分の空白行・空白列をシートへ
 * 実際に挿入することで表現する（無理に高度なExcel機能まで対応しない、という
 * 開発指示書の方針に沿った単純な実装）。行の高さはmm→pt（write-excel-fileの
 * heightは"points"）でそのまま正確に変換できるが、列幅はExcelの伝統的な
 * 「文字数」単位への近似変換（mmToExcelColumnWidth）となるため、実際の見た目は
 * 環境によって多少前後する。
 */
import { mmToPt } from "@/lib/print/paper-sizes";
import { writeXlsxSheets, mmToExcelColumnWidth } from "@/lib/excel/xlsx-simple-io";
import { BrowserProcessor } from "../types";

export interface ExcelLabelInput {
  labelWidthMm: number;
  labelHeightMm: number;
  rows: number;
  columns: number;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  gapHMm: number;
  gapVMm: number;
  text: string;
}

export interface ExcelLabelOutput {
  blob: Blob;
}

const MAX_LABELS = 500;

type AxisSegment = { kind: "margin" | "gap" | "label"; mm: number };

function buildAxisPlan(count: number, labelMm: number, gapMm: number, marginStartMm: number, marginEndMm: number): AxisSegment[] {
  const plan: AxisSegment[] = [{ kind: "margin", mm: marginStartMm }];
  for (let i = 0; i < count; i++) {
    if (i > 0) plan.push({ kind: "gap", mm: gapMm });
    plan.push({ kind: "label", mm: labelMm });
  }
  plan.push({ kind: "margin", mm: marginEndMm });
  return plan;
}

export function validateExcelLabelInput(input: ExcelLabelInput): string | null {
  if (!(input.labelWidthMm > 0) || !(input.labelHeightMm > 0)) {
    return "ラベルの幅・高さは0より大きい値を指定してください";
  }
  if (!Number.isInteger(input.rows) || input.rows < 1 || !Number.isInteger(input.columns) || input.columns < 1) {
    return "行数・列数は1以上の整数で指定してください";
  }
  if (input.rows * input.columns > MAX_LABELS) {
    return `ラベル数が多すぎます（最大${MAX_LABELS}枚まで）。行数・列数を見直してください`;
  }
  const margins = [input.marginTopMm, input.marginBottomMm, input.marginLeftMm, input.marginRightMm, input.gapHMm, input.gapVMm];
  if (margins.some((v) => v < 0)) {
    return "余白・間隔にマイナスの値は指定できません";
  }
  return null;
}

export class ExcelLabelProcessor extends BrowserProcessor<ExcelLabelInput, ExcelLabelOutput> {
  async process(input: ExcelLabelInput): Promise<ExcelLabelOutput> {
    const validationError = validateExcelLabelInput(input);
    if (validationError) throw new Error(validationError);

    const rowPlan = buildAxisPlan(input.rows, input.labelHeightMm, input.gapVMm, input.marginTopMm, input.marginBottomMm);
    const colPlan = buildAxisPlan(input.columns, input.labelWidthMm, input.gapHMm, input.marginLeftMm, input.marginRightMm);

    const columns = colPlan.map((seg) => ({ width: mmToExcelColumnWidth(seg.mm) }));

    const sheetRows: unknown[][] = rowPlan.map((rowSeg) => {
      const heightPt = mmToPt(rowSeg.mm);
      return colPlan.map((colSeg, colIdx) => {
        const isLabelCell = rowSeg.kind === "label" && colSeg.kind === "label";
        const cell: Record<string, unknown> = {
          value: isLabelCell ? input.text : "",
        };
        if (colIdx === 0) cell.height = heightPt;
        if (isLabelCell) {
          cell.align = "center";
          cell.alignVertical = "center";
          cell.wrap = true;
          cell.borderStyle = "thin";
          cell.borderColor = "#999999";
        }
        return cell;
      });
    });

    const blob = await writeXlsxSheets([{ name: "ラベル", rows: sheetRows, columns }]);
    return { blob };
  }
}
