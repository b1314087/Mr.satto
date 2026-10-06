import { ExcelToCsvProcessor, type ExcelSheet } from "@/lib/processors/browser/csv-excel";
import { readCsvFile } from "@/lib/utils/csv";

/**
 * プレビュー用に、Excel(.xlsx)またはCSVの内容を行列(文字列)として読み込む。
 * 複数シートのExcelは全シートを返す(画面でシートを切り替えて確認できる)。
 */
export async function readSpreadsheetForPreview(file: File): Promise<ExcelSheet[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv") || file.type === "text/csv") {
    return [{ name: "CSV", rows: await readCsvFile(file) }];
  }
  const { sheets } = await new ExcelToCsvProcessor().process({ file });
  return sheets;
}
