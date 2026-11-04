import { readXlsxSheets, type XlsxCellValue } from "@/lib/excel/xlsx-simple-io";
import { decodeCsvBytes, LEGACY_EXCEL_MESSAGE } from "@/lib/calendar/event-file";
import { parseCsv } from "@/lib/utils/csv";
import type { LabelHonorificLine } from "@/lib/label/layout";

/**
 * ラベル作成：Excel・CSVのファイルから、ラベルごとの文字を読み込む。
 * ファイルはブラウザの中だけで読み、サーバーへは送らない。
 *
 * 読み込み方：
 * - 1行が1枚のラベルになる。横に並んだセル（氏名・住所など）は、ラベルの中で改行して並べる。
 * - 空のセル・空の行は飛ばす。セルの中の改行（Alt+Enter）も、ラベルの中の改行になる。
 * - 1行目が見出し（「氏名」「住所」など）に見えるときは、最初はラベルにしない（画面で切り替えられる）。
 * 読み込んだ結果は、ラベル作成の「1行を1枚にする」形式の文字（セルの区切りはタブ）にして、入力欄へ入れる。
 */

// 古い形式（.xls）も受け付ける（読み込めないため、保存し直す方法を案内する）
export const LABEL_IMPORT_ACCEPT =
  ".xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain";

export interface LabelImportData {
  fileName: string;
  /** 読み込んだシートの名前（Excelのとき） */
  sheetName: string | null;
  /** セルの文字（空の行は除いたもの） */
  rows: string[][];
  /** 1行目が見出しに見えるか */
  headerLikely: boolean;
}

function cellText(v: XlsxCellValue | string): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return `${v.getFullYear()}/${v.getMonth() + 1}/${v.getDate()}`;
  return String(v);
}

/** セルの文字を整える（前後の空白を除き、セルの中の改行はラベルの中の改行にするため区切りに変える） */
function normalizeCell(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const HEADER_WORDS = /^(氏名|名前|お名前|なまえ|宛名|宛先|住所|ご住所|郵便番号|〒|電話|電話番号|tel|会社|会社名|部署|所属|役職|学年|クラス|組|番号|no\.?|品名|商品名|名称|name|address|zip|company)$/i;

/** 1行目が見出しに見えるか（見出しの言葉のセルがあり、長い文章のセルがない） */
export function looksLikeHeader(row: string[]): boolean {
  const cells = row.map((c) => c.trim()).filter((c) => c !== "");
  if (cells.length === 0) return false;
  return cells.some((c) => HEADER_WORDS.test(c)) && cells.every((c) => c.length <= 12);
}

/** 読み込んだ行を、ラベルの入力欄の文字（1行1枚・セルはタブ区切り）にする */
export function rowsToLabelListText(rows: string[][], skipHeader: boolean): { text: string; count: number } {
  const body = skipHeader ? rows.slice(1) : rows;
  const lines = body
    .map((row) => row.flatMap((cell) => normalizeCell(cell)))
    .filter((cells) => cells.length > 0)
    .map((cells) => cells.join("\t"));
  return { text: lines.join("\n"), count: lines.length };
}

/** ファイルを読み、空でない行の一覧にする。対応していない形式・空のファイルは、日本語のエラーを投げる */
export async function readLabelImportFile(file: File): Promise<LabelImportData> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) throw new Error(LEGACY_EXCEL_MESSAGE);

  let rows: string[][];
  let sheetName: string | null = null;
  if (name.endsWith(".csv") || name.endsWith(".txt") || file.type === "text/csv" || file.type === "text/plain") {
    const text = decodeCsvBytes(await file.arrayBuffer());
    // タブ区切り（Excelからコピーして保存したテキスト）にも対応する
    rows = text.includes("\t") && !text.includes(",") ? text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.split("\t")) : parseCsv(text);
  } else {
    const sheets = await readXlsxSheets(file);
    // 文字が入っている最初のシートを使う
    const sheet = sheets.find((s) => s.rows.some((r) => r.some((v) => cellText(v).trim() !== ""))) ?? sheets[0];
    sheetName = sheet.name;
    rows = sheet.rows.map((r) => r.map(cellText));
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) throw new Error(`${file.name} には、読み込める文字がありませんでした。`);
  const headerLikely = looksLikeHeader(nonEmpty[0]);
  if (headerLikely) restorePostalZeros(nonEmpty);
  return { fileName: file.name, sheetName, rows: nonEmpty, headerLikely };
}

const NAME_HEADER = /^(氏名|名前|お名前|なまえ|宛名|宛先|会社|会社名|団体名|name|company)$/i;

/**
 * 見出しの行から、敬称（様・御中）を付ける行を決める。
 * 名前の列が最初なら1行目、最後なら最後の行。分からないときは null（今の設定のまま）。
 */
export function honorificLineFromHeader(row: string[]): LabelHonorificLine | null {
  const cells = row.map((c) => c.trim()).filter((c) => c !== "");
  const index = cells.findIndex((c) => NAME_HEADER.test(c));
  if (index < 0) return null;
  if (index === 0) return "first";
  if (index === cells.length - 1) return "last";
  return null;
}

const POSTAL_HEADER = /^(郵便番号|〒|zip|zipcode|postal ?code)$/i;

/**
 * 見出しが「郵便番号」の列で、数値として入力されて先頭の0が消えた番号（例: 0600001 → 600001）を、7けたに戻す。
 * Excelで郵便番号を数値のまま入力すると、先頭の0が消えるため。
 */
export function restorePostalZeros(rows: string[][]): void {
  const col = rows[0].findIndex((c) => POSTAL_HEADER.test(c.trim()));
  if (col < 0) return;
  for (const row of rows.slice(1)) {
    const v = (row[col] ?? "").trim();
    if (/^\d{5,6}$/.test(v)) row[col] = v.padStart(7, "0");
  }
}
