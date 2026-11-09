import type { PersonRecord } from "./person-extraction";
import { toExcelWriteCell } from "@/lib/pdf/cell-value";
import type { SheetData } from "write-excel-file/universal";

/**
 * テンプレートモードのExcel出力（開発指示書20〜22章）。
 *
 * 「1行＝1人」を基本形式とし、同じラベル名の項目は同じ列へまとめる
 * （人物ごとに項目構成が違っても、列を統合し欠けたセルは空欄にする）。
 * Excel生成自体は既存の自動抽出モードと同じ write-excel-file（Phase 1から
 * 使用している既存依存）を利用し、新しいライブラリは追加しない。
 */

/** 出力対象の人物一覧から、列（ラベル）の並び順を決める（初出順） */
export function buildColumnOrder(records: PersonRecord[]): string[] {
  const seen: string[] = [];
  const known = new Set<string>();
  for (const record of records) {
    for (const field of record.fields) {
      if (!known.has(field.label)) {
        known.add(field.label);
        seen.push(field.label);
      }
    }
  }
  return seen;
}

/** ヘッダー行 + 人物ごとの1行、を持つセルのグリッドを組み立てる */
export function buildSheetRows(records: PersonRecord[]): string[][] {
  const columns = buildColumnOrder(records);
  const rows: string[][] = [columns];
  for (const record of records) {
    const valueByLabel = new Map(record.fields.map((f) => [f.label, f.value] as const));
    rows.push(columns.map((label) => valueByLabel.get(label) ?? ""));
  }
  return rows;
}

/**
 * 出力対象（除外されていない人物）のPersonRecordからExcelファイル(Blob)を生成する。
 * 複数の記入済みPDFファイルをまとめて処理した場合も、1つのシートへ統合する
 * （開発指示書30章：複数PDF処理をまとめて1つのExcelへ）。
 */
export async function exportPersonsToExcel(records: PersonRecord[]): Promise<Blob> {
  const rows = buildSheetRows(records);
  // 工程4：見出しの行は文字のまま、値の行は、確かな表記だけ数値・日付にする（金額・マイナス・小数の桁・和暦など。
  // src/lib/pdf/cell-value.ts）。チェックの「TRUE」・空欄・文字は、そのまま
  const typed = rows.map((row, i) => (i === 0 ? row : row.map((v) => toExcelWriteCell(v))));
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  try {
    return await writeXlsxFile(typed as unknown as SheetData).toBlob();
  } catch {
    throw new Error("Excelファイルの生成に失敗しました");
  }
}
