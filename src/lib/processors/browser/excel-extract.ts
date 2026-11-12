import { BrowserProcessor } from "../types";
import { editXlsxColumns, loadXlsxForColumnEdit, type XlsxFormulaReport } from "@/lib/excel/xlsx-column-edit";

/**
 * Excel行・列抽出（次期機能追加 2）。
 *
 * 選んだシートの中で、指定した文字を含むセルがある「行」または「列」だけを残し、Excelファイルとして書き出す。
 * - 検索は部分一致（セルの表示用の値に、指定した文字が含まれていれば一致）。日本語もそのまま検索できる。
 *   大文字・小文字は、既定では区別しない（「大文字・小文字を区別する」を選んだときだけ区別する）。
 *   検索する文字は1つ（複数の条件・正規表現などは扱わない）。
 * - 対象はシート全体（値の入っている範囲）。数式のセルは、計算結果の値で検索する。
 * - 書き出しは、既存の列・行の編集（src/lib/excel/xlsx-column-edit.ts の editXlsxColumns）をそのまま使い、
 *   選んだシートのXMLだけを書き換える。セルの値・書式・数式・列の幅などは保ったまま、残す行・列を詰めて並べる。
 *   ほかのシートは変更せずにそのまま残す（数式の参照も、位置に合わせて書き直す）。
 * - 「見出しを残す」を選ぶと、先頭の行（行の抽出のとき）・先頭の列（列の抽出のとき）を、一致しなくても残す。
 * 処理はすべてブラウザの中で行い、ファイルは送信しない。
 */

export type ExtractAxis = "rows" | "columns";

export interface ExtractMatchInput {
  /** シートの表示用の値（loadXlsxForColumnEdit の rows） */
  rows: string[][];
  query: string;
  axis: ExtractAxis;
  caseSensitive: boolean;
  /** 先頭の行（行の抽出）・先頭の列（列の抽出）を、一致しなくても残す */
  keepHeader: boolean;
}

export interface ExtractMatchResult {
  /** 残す行（行の抽出）または列（列の抽出）の元の番号（0始まり・元の順） */
  kept: number[];
  /** 文字を含んでいた行・列の数（見出しとして残した分は含めない） */
  matchedCount: number;
  /** 文字を含んでいたセルの位置（`行,列`。0始まり。プレビューの色付け用） */
  matchedCells: Set<string>;
}

/** セルの値に検索する文字が含まれるか（部分一致） */
export function cellMatches(value: string, query: string, caseSensitive: boolean): boolean {
  if (query === "") return false;
  return caseSensitive ? value.includes(query) : value.toLowerCase().includes(query.toLowerCase());
}

/** 残す行・列を求める（プレビューと書き出しで共通） */
export function findExtractTargets({ rows, query, axis, caseSensitive, keepHeader }: ExtractMatchInput): ExtractMatchResult {
  const matchedCells = new Set<string>();
  const matchedLines = new Set<number>();
  if (query !== "") {
    rows.forEach((row, r) =>
      row.forEach((value, c) => {
        if (!cellMatches(value, query, caseSensitive)) return;
        matchedCells.add(`${r},${c}`);
        matchedLines.add(axis === "rows" ? r : c);
      })
    );
  }
  const total = axis === "rows" ? rows.length : (rows[0]?.length ?? 0);
  const kept: number[] = [];
  for (let i = 0; i < total; i++) {
    if (matchedLines.has(i) || (keepHeader && i === 0 && matchedLines.size > 0)) kept.push(i);
  }
  return { kept, matchedCount: matchedLines.size, matchedCells };
}

export interface ExcelExtractInput {
  file: File;
  /** 抽出するシートの番号（0始まり） */
  sheetIndex: number;
  query: string;
  axis: ExtractAxis;
  caseSensitive: boolean;
  keepHeader: boolean;
}

export interface ExcelExtractOutput {
  blob: Blob;
  sheetName: string;
  /** 文字を含んでいた行・列の数 */
  matchedCount: number;
  /** 出力した行・列の数（見出しを含む） */
  rowCount: number;
  columnCount: number;
  notices: string[];
  formulas: XlsxFormulaReport | null;
}

export class ExcelExtractProcessor extends BrowserProcessor<ExcelExtractInput, ExcelExtractOutput> {
  async process({ file, sheetIndex, query, axis, caseSensitive, keepHeader }: ExcelExtractInput): Promise<ExcelExtractOutput> {
    if (query === "") throw new Error("検索する文字を入力してください。");
    const sheets = await loadXlsxForColumnEdit(file);
    const sheet = sheets[sheetIndex];
    if (!sheet) throw new Error("抽出するシートが見つかりませんでした。ファイルを選び直してください。");
    if (sheet.rows.length === 0 || (sheet.rows[0]?.length ?? 0) === 0) {
      throw new Error(`シート「${sheet.name}」には値の入ったセルがありません。`);
    }
    const { kept, matchedCount } = findExtractTargets({ rows: sheet.rows, query, axis, caseSensitive, keepHeader });
    if (matchedCount === 0) {
      throw new Error(`シート「${sheet.name}」に「${query}」を含むセルが見つかりませんでした。`);
    }
    const allColumns = Array.from({ length: sheet.rows[0].length }, (_, i) => i);
    let result: Awaited<ReturnType<typeof editXlsxColumns>>;
    try {
      result = await editXlsxColumns({
        file,
        sheetIndex,
        hasHeader: false,
        columnOrder: axis === "columns" ? kept : allColumns,
        rowOrder: axis === "rows" ? kept.map((r) => r + 1) : undefined,
      });
    } catch (e) {
      // 共通の書き換え処理のメッセージは「列の編集」向けの言い方のため、このツールの言い方に直す
      const message = e instanceof Error ? e.message : "Excelファイルを書き出せませんでした。";
      throw new Error(message.replace(/列の編集|列の削除・並び替えや行の範囲の指定/g, "行・列の抽出"));
    }
    return {
      blob: result.blob,
      sheetName: sheet.name,
      matchedCount,
      rowCount: result.rowCount,
      columnCount: result.columnCount,
      notices: result.notices,
      formulas: result.formulas,
    };
  }
}
