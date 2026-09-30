/**
 * 次工程・軽量便利ツール一括追加のExcel系5ツール（Tool 4〜8）が共通で使う
 * 簡易読み書きユーティリティ。
 *
 * 既存の csv-excel.ts（CSV⇄Excel）と同じ read-excel-file / write-excel-file の
 * /universal サブパスを再利用する（新規依存を追加しない・既存ライブラリを
 * 最優先する、という指示書8章の方針）。
 *
 * read-excel-file はセルの値（string/number/boolean/Date/null）は取得できるが、
 * 背景色・罫線・フォントといった書式情報までは取得できない。そのため、
 * 「セルの基本書式（文字・数値・日付の種類）は維持するが、色や罫線等の
 * 高度な書式までは維持しない」という、指示書が明示的に許容する範囲
 * （8章「無理に高度なExcel機能まで対応しない」）で実装する。
 */
export type XlsxCellValue = string | number | boolean | Date | null;

export interface XlsxSheet {
  name: string;
  rows: XlsxCellValue[][];
}

export async function readXlsxSheets(file: File): Promise<XlsxSheet[]> {
  const { default: readXlsxFile } = await import("read-excel-file/universal");
  let sheetsData: { sheet: string; data: unknown[][] }[];
  try {
    sheetsData = await readXlsxFile(file);
  } catch {
    throw new Error(
      `${file.name} の読み込みに失敗しました。Excelファイルが破損しているか、対応していない形式の可能性があります。`
    );
  }
  if (!sheetsData || sheetsData.length === 0) {
    throw new Error("このExcelファイルには読み取れるシートがありません");
  }
  return sheetsData.map((s) => ({
    name: s.sheet,
    rows: s.data.map((row) => row.map((v) => (v === undefined ? null : (v as XlsxCellValue)))),
  }));
}

/**
 * write-excel-file/universal の Row/Cell 型をそのまま再利用できるよう、
 * 出力側は unknown[][] を受け取ってそのまま渡す（Tool 7 の結合セルのように
 * CellObject（columnSpan/align等）を混在させたい場合にも対応できるようにするため）。
 *
 * columns（列幅指定, mmToExcelColumnWidth等で求めた"文字数"単位の配列）は
 * 次工程・印刷帳票4ツール追加フェーズ（Excelラベル作成・名簿テンプレート作成）で
 * 追加したオプション引数。省略時は従来通り列幅指定なしで書き出すため、
 * 既存の呼び出し箇所（Tool 4〜8）の動作は変更しない。
 */
export async function writeXlsxSheets(
  sheets: { name: string; rows: unknown[][]; columns?: { width: number }[] }[]
): Promise<Blob> {
  const { default: writeXlsxFile } = await import("write-excel-file/universal");
  // write-excel-file はデータが0行のシートを受け付けないため、空シートには
  // 空セル1行を補って安全に書き出せるようにする。
  const safeSheets = sheets.map((s) => ({
    name: s.name,
    rows: s.rows.length > 0 ? s.rows : [[null]],
    columns: s.columns,
  }));
  // write-excel-file の型は `unknown` を直接受け付けないため、
  // ライブラリ自身がエクスポートする Row/SheetData 型へこの境界でのみ変換する。
  // dateFormatを既定で指定しておく: read-excel-fileが返すDate値をそのまま
  // 書き戻す場合（Tool 4/8等）、CellObjectでformatを個別指定しない限り
  // write-excel-fileが「Dateセルにはformatが必要」というエラーを投げるため
  // （pdf-to-excel.tsが個別セルへ指定しているformatと同じ既定値に揃える）。
  const sheetInputs = safeSheets.map((s) => ({
    sheet: s.name,
    dateFormat: "yyyy-mm-dd",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: s.rows as any,
    ...(s.columns ? { columns: s.columns } : {}),
  }));
  try {
    return await writeXlsxFile(sheetInputs).toBlob();
  } catch {
    throw new Error("Excelファイルの生成に失敗しました");
  }
}

/** 行が完全に空（すべてのセルが null または空文字）かどうかを判定する */
export function isBlankRow(row: XlsxCellValue[]): boolean {
  return row.every((cell) => cell === null || cell === undefined || cell === "");
}

/** 列インデックス col が全行にわたって完全に空かどうかを判定する */
export function isBlankColumn(rows: XlsxCellValue[][], col: number): boolean {
  return rows.every((row) => {
    const cell = row[col];
    return cell === null || cell === undefined || cell === "";
  });
}

/** "A" -> 0, "B" -> 1, ... "Z" -> 25, "AA" -> 26 のような列記号→0始まりインデックス変換 */
export function columnLetterToIndex(letter: string): number {
  const trimmed = letter.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(trimmed)) {
    throw new Error(`列の指定「${letter}」が正しくありません（A, B, C... の形式で入力してください）`);
  }
  let index = 0;
  for (const ch of trimmed) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** 0始まりインデックス→列記号（"A", "B", ... "AA"）への変換 */
export function columnIndexToLetter(index: number): string {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/**
 * mm幅を write-excel-file の列幅指定（"文字数"単位、Excel既定フォント基準の近似値）へ変換する
 * （Mr.Satto 次工程・印刷帳票4ツール追加フェーズ：Excelラベル作成・名簿テンプレート作成の2ツールが
 * 共通で使う。write-excel-file自体はmm単位の列幅指定をサポートしていないため、
 * 96dpi換算のピクセル幅からExcelの伝統的な「文字数」単位へ近似変換する
 * （Excel標準フォントでの一般的な近似式。環境・フォントにより実際の表示幅は多少前後する）。
 */
export function mmToExcelColumnWidth(mm: number): number {
  const px = mm * (96 / 25.4);
  return Math.max(1, (px - 5) / 7);
}
