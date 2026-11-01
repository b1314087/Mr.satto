/**
 * 座席表作成（参加者の名簿）。ブラウザ内の処理だけ（名前は外部に送らない・保存しない）。
 *
 * 決まり（画面・テストと同じ）:
 * - 1行に1人。行の中の最初のタブ・「,」「、」「，」より後ろを役職（肩書き）にする。名前の中の空白では区切らない。
 * - 前後の空白は取り除き、途中の連続した空白は1つにまとめる。空の行は除く。
 * - 入力した順番が、席に入る順番になる。
 * - 同じ名前（全角・半角・大文字小文字・空白の違いを無視）が2人以上いるときは、2人目以降に「(2)」のように番号を付けて残す
 *   （席の入れ替えで、人を取り違えないため）。
 */
import type { XlsxCellValue } from "@/lib/excel/xlsx-simple-io";

export interface Participant {
  id: number;
  name: string;
  role: string;
}

export interface ParsedParticipants {
  participants: Participant[];
  /** 同じ名前のため、番号を付けた名前（変更後の名前） */
  renamedDuplicates: string[];
  /** 上限を超えたために読み込まなかった人数 */
  overLimit: number;
}

/** 1回に扱える参加者の上限 */
export const SEATING_MAX_PARTICIPANTS = 400;

/** 名前の照合に使う形（全角・半角、大文字小文字、空白の違いを無視する） */
export function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 表示に使う形（前後の空白を除き、途中の連続した空白は1つにまとめる） */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 1行を、名前と役職に分ける */
export function splitLine(line: string): { name: string; role: string } {
  const m = /^([^\t,、，]*)[\t,、，](.*)$/.exec(line);
  if (!m) return { name: cleanText(line), role: "" };
  return { name: cleanText(m[1]), role: cleanText(m[2].replace(/[\t,、，]+/g, " ")) };
}

export function parseParticipants(text: string): ParsedParticipants {
  const participants: Participant[] = [];
  const renamedDuplicates: string[] = [];
  const used = new Set<string>();
  const counts = new Map<string, number>();
  let overLimit = 0;
  for (const raw of text.split(/\r?\n/)) {
    const { name, role } = splitLine(raw);
    if (name === "") continue;
    if (participants.length >= SEATING_MAX_PARTICIPANTS) {
      overLimit++;
      continue;
    }
    const key = nameKey(name);
    let finalName = name;
    if (used.has(key)) {
      let n = (counts.get(key) ?? 1) + 1;
      while (used.has(nameKey(`${name}(${n})`))) n++;
      counts.set(key, n);
      finalName = `${name}(${n})`;
      renamedDuplicates.push(finalName);
    } else {
      counts.set(key, 1);
    }
    used.add(nameKey(finalName));
    participants.push({ id: participants.length, name: finalName, role });
  }
  return { participants, renamedDuplicates, overLimit };
}

const NAME_HEADERS = /^(氏名|名前|お名前|参加者|参加者名|生徒名|児童名|社員名|name|names|full ?name)$/i;
const ROLE_HEADERS = /^(役職|肩書き?|職位|職名|所属|部署|部門|会社名?|学年|クラス|担当|role|title|position|department)$/i;

function cellText(value: XlsxCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  return String(value);
}

/**
 * 表（CSV・Excelのシート）から、名前と役職を取り出して、入力欄の文字（1行に「名前<タブ>役職」）にする。
 * 最初の空でない行に「氏名」「名前」などの見出しがあれば、その列（見出しの行は除く）。役職は「役職」「所属」などの見出しの列。
 * 見出しが無ければ、1列目を名前、2列目を役職とする。
 */
export function namesFromRows(rows: XlsxCellValue[][]): { text: string; count: number; hadHeader: boolean; roleColumn: boolean } {
  const first = rows.findIndex((r) => r.some((c) => cellText(c).trim() !== ""));
  if (first < 0) return { text: "", count: 0, hadHeader: false, roleColumn: false };
  const header = rows[first].map((c) => cellText(c).trim());
  const nameCol = header.findIndex((h) => NAME_HEADERS.test(h));
  const roleHeaderCol = header.findIndex((h) => ROLE_HEADERS.test(h));
  const hadHeader = nameCol >= 0;
  const column = hadHeader ? nameCol : 0;
  const roleCol = hadHeader ? roleHeaderCol : 1;
  const start = hadHeader ? first + 1 : first;
  const lines: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const name = cleanText(cellText(rows[i][column]).replace(/[\t,、，]/g, " "));
    if (name === "") continue;
    const role = roleCol >= 0 ? cleanText(cellText(rows[i][roleCol])) : "";
    lines.push(role ? `${name}\t${role}` : name);
  }
  return { text: lines.join("\n"), count: lines.length, hadHeader, roleColumn: roleCol >= 0 && lines.some((l) => l.includes("\t")) };
}
