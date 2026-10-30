/**
 * 座席表作成（参加者の名簿）。ブラウザ内の処理だけ（名前は外部に送らない・保存しない）。
 *
 * 決まり（画面の説明・テストと同じ）:
 * - 改行・タブ・「、」「,」で区切って1人ずつにする。名前の中の空白（姓と名の間など）では区切らない。
 * - 前後の空白は取り除き、途中の連続した空白は1つにまとめる。空の行は数えて除く。
 * - 同じ名前（全角・半角・大文字小文字・空白の違いを無視）は、既定では2人目以降を除く。
 *   「同じ名前も別の人として扱う」を選ぶと、残して「山田太郎(2)」のように番号を付ける。
 */
import type { XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

export interface Participant {
  id: number;
  name: string;
}

export interface ParsedParticipants {
  participants: Participant[];
  /** 取り除いた空の項目の数 */
  blankCount: number;
  /** 同じ名前として取り除いた名前（取り除いた回数ぶん） */
  removedDuplicates: string[];
  /** 同じ名前を残して、番号を付けた名前（変更後の名前） */
  renamedDuplicates: string[];
  /** 上限を超えたために読み込まなかった人数 */
  overLimit: number;
}

/** 1回に扱える参加者の上限 */
export const SEATING_MAX_PARTICIPANTS = 500;
/** テーブル数の上限・1テーブルの席数の上限 */
export const SEATING_MAX_TABLES = 60;
export const SEATING_MAX_SEATS_PER_TABLE = 40;

/** 名前の照合に使う形（全角・半角、大文字小文字、空白の違いを無視する） */
export function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 名前の表示に使う形（前後の空白を除き、途中の連続した空白は1つにまとめる） */
export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** 名簿の文字列を、1人ずつの名前に分ける（空の項目も含めて返す） */
export function splitNames(text: string): string[] {
  return text.split(/[\r\n\t,、，]/);
}

export function parseParticipants(text: string, options: { keepDuplicates?: boolean } = {}): ParsedParticipants {
  const participants: Participant[] = [];
  const removedDuplicates: string[] = [];
  const renamedDuplicates: string[] = [];
  const used = new Set<string>();
  const counts = new Map<string, number>();
  let blankCount = 0;
  let overLimit = 0;

  for (const raw of splitNames(text)) {
    const name = cleanName(raw);
    if (name === "") {
      blankCount++;
      continue;
    }
    const key = nameKey(name);
    let finalName = name;
    if (used.has(key)) {
      if (!options.keepDuplicates) {
        removedDuplicates.push(name);
        continue;
      }
      let n = (counts.get(key) ?? 1) + 1;
      while (used.has(nameKey(`${name}(${n})`))) n++;
      counts.set(key, n);
      finalName = `${name}(${n})`;
      renamedDuplicates.push(finalName);
    }
    if (participants.length >= SEATING_MAX_PARTICIPANTS) {
      overLimit++;
      continue;
    }
    used.add(nameKey(finalName));
    if (!counts.has(key)) counts.set(key, 1);
    participants.push({ id: participants.length, name: finalName });
  }
  return { participants, blankCount, removedDuplicates, renamedDuplicates, overLimit };
}

const NAME_HEADERS = /^(氏名|名前|お名前|参加者|参加者名|名簿|name|names)$/i;

function cellText(value: XlsxCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * 表（CSV・Excelのシート）から、名前の列を取り出す。
 * 最初の空でない行に「氏名」「名前」などの見出しがあれば、その列（見出しの行は除く）。無ければ、1列目の全部。
 */
export function namesFromRows(rows: XlsxCellValue[][]): { names: string[]; column: number; hadHeader: boolean } {
  const first = rows.findIndex((r) => r.some((c) => cellText(c).trim() !== ""));
  if (first < 0) return { names: [], column: 0, hadHeader: false };
  const headerCol = rows[first].findIndex((c) => NAME_HEADERS.test(cellText(c).trim()));
  const column = headerCol >= 0 ? headerCol : 0;
  const start = headerCol >= 0 ? first + 1 : first;
  const names: string[] = [];
  for (let i = start; i < rows.length; i++) names.push(cellText(rows[i][column]));
  return { names, column, hadHeader: headerCol >= 0 };
}
